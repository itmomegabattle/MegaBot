package ru.itmomegabattle.megabot.tasks;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;
import ru.itmomegabattle.megabot.common.SqlTime;
import ru.itmomegabattle.megabot.notifications.OutboxWriter;
import tools.jackson.databind.ObjectMapper;

@Service
public class TaskService {
    /** Shared read visibility, including removal/membership/assignment; bind only trusted actor values. */
    static final String VISIBLE_SQL="""
            t.removed_at is null and (:core or
              ((t.faculty_all or t.faculty_id=(select faculty_id from faculty_memberships where user_id=:actor))
               and exists(select 1 from faculty_memberships where user_id=:actor)
               and exists(select 1 from task_assignees a where a.task_id=t.id and a.user_id=:actor)))
            """;
	private final JdbcClient jdbc;
	private final Clock clock;
	private final AuditWriter audit;
	private final OutboxWriter outbox;
	private final ObjectMapper json;
	private final TaskReminderService reminders;
	TaskService(JdbcClient jdbc, Clock clock, AuditWriter audit, OutboxWriter outbox, ObjectMapper json, TaskReminderService reminders) {
		this.jdbc=jdbc; this.clock=clock; this.audit=audit; this.outbox=outbox; this.json=json;
		this.reminders=reminders;
	}

	@Transactional(readOnly=true, isolation=Isolation.REPEATABLE_READ)
	public List<Map<String, Object>> list(AuthenticatedUser actor, int limit, String cursor) {
		if (limit < 1 || limit > 100) throw TaskRules.bad("invalid_limit", "Лимит должен быть 1–100");
        return jdbc.sql("select t.* from tasks t where "+VISIBLE_SQL+" and t.id>:cursor order by t.id limit :limit").param("cursor", cursor == null ? "" : cursor).param("core", core(actor)).param("actor",actor.id()).param("limit",limit)
				.query((row,index)->row(row)).list().stream().map(t->view(t,actor)).toList();
	}
	@Transactional(readOnly=true, isolation=Isolation.REPEATABLE_READ)
	public Map<String,Object> get(String id, AuthenticatedUser actor) { var task=require(id,false); access(task,actor); return view(task,actor); }
	@Transactional(readOnly=true, isolation=Isolation.REPEATABLE_READ)
	public List<Map<String,Object>> frontendTasks(AuthenticatedUser actor) {
        return jdbc.sql("select t.* from tasks t where "+VISIBLE_SQL+" order by t.created_at,t.id").param("core",core(actor)).param("actor",actor.id()).query((row,index)->row(row)).list().stream()
				.map(task->TaskFrontendMapper.map(view(task,actor),jdbc.sql("""
						select c.name from competencies c join task_competencies tc on tc.competency_id=c.id
						where tc.task_id=:id order by c.name,c.id
						""").param("id",task.id()).query(String.class).list())).toList();
	}
	@Transactional(readOnly=true)
	public List<Map<String,Object>> history(String id,AuthenticatedUser actor,int limit,String cursor) {
		access(require(id,false),actor);
		if(limit<1 || limit>100) throw TaskRules.bad("invalid_limit","Лимит должен быть 1–100");
		return jdbc.sql("""
				select * from task_status_history where task_id=:id
				and (:cursor='' or (occurred_at,id) > (select occurred_at,id from task_status_history where id=:cursor and task_id=:id))
				order by occurred_at,id limit :limit
				""")
				.param("id",id).param("cursor",cursor==null?"":cursor).param("limit",limit).query((row,index)->{
			Map<String,Object> entry=new LinkedHashMap<>(); entry.put("id",row.getString("id")); entry.put("actorId",row.getString("actor_id"));
			entry.put("previousStatus",row.getString("previous_status")); entry.put("status",row.getString("new_status"));
			entry.put("occurredAt",row.getTimestamp("occurred_at").toInstant()); return entry;
		}).list();
	}

	@Transactional
	Map<String,Object> create(TaskController.Mutation request, AuthenticatedUser actor) {
		return createInternal(request,actor,false);
	}
	@Transactional
	Map<String,Object> createLegacyFaculty(TaskController.Mutation request,AuthenticatedUser actor) {
		return createInternal(request,actor,true);
	}
	private Map<String,Object> createInternal(TaskController.Mutation request,AuthenticatedUser actor,boolean waiting) {
		TaskMaintenanceGate.shared(jdbc);
		var ids=validate(request, null);
		var id="task_"+UUID.randomUUID();
		jdbc.sql("""
				insert into tasks(id,title,description,sow,priority,status,event_id,faculty_id,faculty_all,creator_id,due_at)
				values (:id,:title,:description,:sow,:priority,:status,:event,:faculty,:all,:creator,:due)
				""").param("id",id).param("title",TaskRules.text(request.title(),2,160))
				.param("description",TaskRules.text(request.description(),0,4000)).param("sow",TaskRules.text(request.sow(),0,8000))
				.param("priority",TaskRules.priority(request.priority())).param("status",ids.isEmpty()?"open":waiting?"waiting":"assigned")
				.param("event",blank(request.eventId())).param("faculty","all".equals(blank(request.facultyId()))?null:blank(request.facultyId()))
				.param("all","all".equals(blank(request.facultyId()))).param("creator",actor.id())
				.param("due",SqlTime.of(TaskRules.deadline(request.deadline()))).update();
		replaceLinks(id,ids,request.competencyIds());
		replaceTips(id,request.tips());
		var task=require(id,false);
		reminders.configure(id,task.dueAt(),task.createdAt(),request.reminders());
		changed(task,null,"created",actor,ids);
		return view(task,actor);
	}

	@Transactional
	Map<String,Object> update(String id, TaskController.Mutation request, AuthenticatedUser actor) {
		TaskMaintenanceGate.shared(jdbc);
		var task=require(id,true); coordinator(task,actor); editable(task);
		if(request.expectedVersion()==null) throw TaskRules.bad("version_required","Укажите версию задачи");
		version(task,request.expectedVersion());
		if (!java.util.Objects.equals(task.facultyId(),blank(request.facultyId()))) throw TaskRules.bad("task_scope_immutable","Контур задачи нельзя изменить");
		var previous=assignees(id); var next=validate(request,task.eventId());
		var status=next.isEmpty()?"open":("open".equals(task.status())?"assigned":task.status());
		jdbc.sql("""
				update tasks set title=:title,description=:description,sow=:sow,priority=:priority,event_id=:event,
				due_at=:due,status=:status,version=version+1,updated_at=now() where id=:id
				""").param("id",id).param("title",TaskRules.text(request.title(),2,160))
				.param("description",TaskRules.text(request.description(),0,4000)).param("sow",TaskRules.text(request.sow(),0,8000))
				.param("priority",TaskRules.priority(request.priority())).param("event",blank(request.eventId()))
				.param("due",SqlTime.of(TaskRules.deadline(request.deadline()))).param("status",status).update();
		replaceLinks(id,next,request.competencyIds());
		replaceTips(id,request.tips());
		var updated=require(id,false);
		reminders.configure(id,updated.dueAt(),updated.createdAt(),request.reminders());
		reminders.lifecycle(id,updated.status());
		var targets=new java.util.HashSet<>(previous); targets.addAll(next);
		changed(updated,task.status(),"updated",actor,List.copyOf(targets),task.title()); return view(updated,actor);
	}

	@Transactional
	Map<String,Object> assignment(String id,String action,long expectedVersion,AuthenticatedUser actor) {
		TaskMaintenanceGate.shared(jdbc);
		var task=require(id,true); access(task,actor);
		var assigned=assignees(id);
		if ("cancel".equals(action)) {
			coordinator(task,actor);
			if ("cancelled".equals(task.status())) return view(task,actor);
			version(task,expectedVersion);
			jdbc.sql("update tasks set status='cancelled',completed_at=null,completed_by=null,time_spent_minutes=null,cancelled_at=:now,cancelled_by=:actor,version=version+1,updated_at=now() where id=:id")
					.param("now",SqlTime.of(clock.instant())).param("actor",actor.id()).param("id",id).update();
		} else {
			editable(task);
			if ("release".equals(action) && !assigned.contains(actor.id())) throw forbidden();
			version(task,expectedVersion);
			if ("claim".equals(action)) {
				if (!core(actor) || task.facultyId()!=null) throw forbidden();
				if (!"open".equals(task.status()) || !assigned.isEmpty()) throw TaskRules.conflict("task_taken","Задача уже взята");
				var required=competencies(id);
				if (!required.isEmpty() && jdbc.sql("select count(*) from user_competencies where user_id=:actor and competency_id in (:ids)")
						.param("actor",actor.id()).param("ids",required).query(Long.class).single()==0) throw forbidden();
				jdbc.sql("insert into task_assignees(task_id,user_id) values (:id,:actor)").param("id",id).param("actor",actor.id()).update();
				setStatus(id,"assigned",actor,null);
			} else {
				jdbc.sql("delete from task_assignees where task_id=:id and user_id=:actor").param("id",id).param("actor",actor.id()).update();
				setStatus(id,assignees(id).isEmpty()?"open":task.status(),actor,null);
			}
		}
		var updated=require(id,false); reminders.lifecycle(id,updated.status());
		var targets=new java.util.HashSet<>(assigned); targets.add(actor.id());
		if(task.creatorId()!=null) targets.add(task.creatorId());
		changed(updated,task.status(),action,actor,List.copyOf(targets)); return view(updated,actor);
	}

    /** Faculty dialog confirmation: a stale/closed offer must never reopen a task or silently succeed. */
    @Transactional(propagation=org.springframework.transaction.annotation.Propagation.MANDATORY)
    public Map<String,Object> facultyStatus(String id,long expectedVersion,String next,AuthenticatedUser actor) {
        if(!List.of("faculty_responsible","faculty_helper").contains(actor.role())) throw forbidden();
        if(next==null || !List.of("waiting","in_progress","completed").contains(next))
            throw TaskRules.bad("invalid_task_status","Выберите статус задачи кнопкой");
        TaskMaintenanceGate.shared(jdbc);
        var task=require(id,true); access(task,actor); editable(task); version(task,expectedVersion);
        return status(id,new TaskController.Status(next,expectedVersion,null,null),actor);
    }
	@Transactional
	Map<String,Object> status(String id,TaskController.Status request,AuthenticatedUser actor) {
		TaskMaintenanceGate.shared(jdbc);
		var task=require(id,true); access(task,actor);
		if (!"admin".equals(actor.role()) && !assignees(id).contains(actor.id())) throw forbidden();
		if (!TaskRules.transition(task.status(),request.status())) return view(task,actor);
		version(task,request.expectedVersion());
		if ("cancelled".equals(request.status())) throw TaskRules.bad("use_cancel_command","Используйте команду отмены");
		if ("open".equals(request.status()) && !assignees(id).isEmpty()) throw TaskRules.conflict("task_has_assignees","Сначала снимите назначения");
		if (!"open".equals(request.status()) && assignees(id).isEmpty()) throw TaskRules.conflict("task_without_assignees","У задачи нет исполнителя");
		if ("completed".equals(request.status())) {
			if(request.timeSpentMinutes()!=null && (request.timeSpentMinutes()<1 || request.timeSpentMinutes()>60000)) throw TaskRules.bad("invalid_time_spent","Некорректное время выполнения");
			var comment=TaskRules.text(request.completionComment(),0,4000);
			if (!comment.isEmpty()) insertComment(id,actor.id(),"executor",actor.id(),comment,"completion");
		}
		setStatus(id,request.status(),actor,request.timeSpentMinutes());
		var updated=require(id,false);
		reminders.lifecycle(id,updated.status());
		var targets=task.creatorId()==null || task.creatorId().equals(actor.id()) ? List.<String>of() : List.of(task.creatorId());
		changed(updated,task.status(),"status",actor,targets); return view(updated,actor);
	}

	@Transactional
	Map<String,Object> comment(String id,TaskController.Comment request,AuthenticatedUser actor) {
		TaskMaintenanceGate.shared(jdbc);
		var task=require(id,true); access(task,actor); editable(task); version(task,request.expectedVersion());
		var assigned=assignees(id);
		if ("coordinator".equals(request.side())) {
			coordinator(task,actor);
			if (request.targetAssigneeId()!=null && !assigned.contains(request.targetAssigneeId())) throw TaskRules.bad("invalid_comment_target","Исполнитель не назначен на задачу");
		} else if (!"executor".equals(request.side()) || !assigned.contains(actor.id())
				|| (request.targetAssigneeId()!=null && !actor.id().equals(request.targetAssigneeId()))) throw forbidden();
		var target="executor".equals(request.side())?actor.id():request.targetAssigneeId();
		insertComment(id,actor.id(),request.side(),target,TaskRules.text(request.text(),1,4000),"discussion");
		jdbc.sql("update tasks set version=version+1,updated_at=now() where id=:id").param("id",id).update();
		var updated=require(id,false);
		var recipients="executor".equals(request.side()) ? (task.creatorId()==null?List.<String>of():List.of(task.creatorId()))
				: (target==null?assigned:List.of(target));
		changed(updated,task.status(),"comment",actor,recipients); return view(updated,actor);
	}

	private List<String> validate(TaskController.Mutation request,String existingEvent) {
		var event=blank(request.eventId()); var faculty=blank(request.facultyId());
		if(event!=null && !event.equals(existingEvent) && jdbc.sql("select count(*) from work_events where id=:id and status='active'").param("id",event).query(Long.class).single()==0)
			throw TaskRules.bad("event_not_found","Активное мероприятие не найдено");
		if(faculty!=null && !"all".equals(faculty) && jdbc.sql("select count(*) from faculties where id=:id and active").param("id",faculty).query(Long.class).single()==0)
			throw TaskRules.bad("faculty_not_found","Факультет не найден");
		var ids=request.assigneeIds()==null?List.<String>of():request.assigneeIds().stream().distinct().toList();
		for(var id:ids) {
			var count=jdbc.sql("""
					select count(*) from users u where u.id=:id and u.active and
					((cast(:faculty as text) is null and u.role in ('admin','organizer')) or
					(u.role in ('faculty_responsible','faculty_helper') and exists
					(select 1 from faculty_memberships f join faculties catalog on catalog.id=f.faculty_id and catalog.active
					where f.user_id=u.id and (:faculty='all' or f.faculty_id=:faculty))))
					""").param("id",id).param("faculty",faculty).query(Long.class).single();
			if(count==0) throw TaskRules.bad("invalid_task_assignee","Исполнитель недоступен или относится к другому контуру");
		}
		if(request.competencyIds()!=null) for(var id:request.competencyIds()) {
			if(jdbc.sql("select count(*) from competencies where id=:id and active and scope=:scope")
					.param("id",id).param("scope",faculty==null?"core":"faculty").query(Long.class).single()==0)
				throw TaskRules.bad("invalid_task_competency","Компетенция недоступна в этом контуре");
		}
		return ids;
	}
	private void replaceLinks(String id,List<String> assigned,List<String> competencies) {
		if(assigned.isEmpty()) jdbc.sql("delete from task_assignees where task_id=:id").param("id",id).update();
		else jdbc.sql("delete from task_assignees where task_id=:id and user_id not in (:ids)").param("id",id).param("ids",assigned).update();
		for(var user:assigned) jdbc.sql("insert into task_assignees(task_id,user_id) values (:id,:user) on conflict (task_id,user_id) do nothing")
				.param("id",id).param("user",user).update();
		jdbc.sql("delete from task_competencies where task_id=:id").param("id",id).update();
		if(competencies!=null) for(var competency:competencies.stream().distinct().toList())
			jdbc.sql("insert into task_competencies(task_id,competency_id) values (:id,:competency)").param("id",id).param("competency",competency).update();
	}
	private void setStatus(String id,String status,AuthenticatedUser actor,Integer minutes) {
		jdbc.sql("""
				update tasks set status=:status,completed_at=:completedAt,completed_by=:completedBy,
				time_spent_minutes=:minutes,version=version+1,updated_at=now() where id=:id
				""").param("status",status).param("completedAt",SqlTime.of("completed".equals(status)?clock.instant():null))
				.param("completedBy","completed".equals(status)?actor.id():null).param("minutes","completed".equals(status)?minutes:null).param("id",id).update();
	}
	private void replaceTips(String id,List<String> tips) {
		if(tips==null) return;
		if(tips.size()>50) throw TaskRules.bad("too_many_tips","Допускается до 50 подсказок");
		jdbc.sql("delete from task_tips where task_id=:id").param("id",id).update();
		for(int index=0;index<tips.size();index++)
			jdbc.sql("insert into task_tips(task_id,position,text) values (:id,:position,:text)").param("id",id)
					.param("position",index).param("text",TaskRules.text(tips.get(index),1,1000)).update();
	}
	private List<String> tips(String id) {
		return jdbc.sql("select text from task_tips where task_id=:id order by position").param("id",id).query(String.class).list();
	}
	private void insertComment(String id,String author,String side,String target,String text,String kind) {
		jdbc.sql("""
				insert into task_comments(id,task_id,author_id,side,target_assignee_id,text,kind,task_version,created_at)
				values (:comment,:id,:author,:side,:target,:text,:kind,(select version+1 from tasks where id=:id),:now)
				""").param("comment","comment_"+UUID.randomUUID()).param("id",id).param("author",author).param("side",side)
				.param("target",target).param("text",text).param("kind",kind).param("now",SqlTime.of(clock.instant())).update();
	}
	private void changed(TaskRow task,String before,String action,AuthenticatedUser actor,List<String> recipients) {
		changed(task,before,action,actor,recipients,null);
	}
	private void changed(TaskRow task,String before,String action,AuthenticatedUser actor,List<String> recipients,String previousTitle) {
		var assigned=assignees(task.id());
		var removed="updated".equals(action)?recipients.stream().distinct().filter(id->!id.equals(actor.id()) && !assigned.contains(id)).sorted().toList():List.<String>of();
		var details=new LinkedHashMap<String,Object>(); details.put("action",action); details.put("version",task.version());
		if("updated".equals(action)) { details.put("removedAssigneeIds",removed);details.put("previousTitle",previousTitle); }
		details.put("completedBy",task.completedBy());
		details.put("creatorId",task.creatorId()); details.put("createdAt",task.createdAt());
		details.put("completedAt",task.completedAt()); details.put("cancelledBy",task.cancelledBy());
		details.put("cancelledAt",task.cancelledAt());
		details.put("title",task.title()); details.put("description",task.description()); details.put("sow",task.sow());
		details.put("eventId",task.eventId()); details.put("facultyId",task.facultyId()); details.put("priority",task.priority());
		details.put("dueAt",task.dueAt()); details.put("assigneeIds",assigned);
		details.put("competencyIds",competencies(task.id())); details.put("timeSpentMinutes",task.minutes());
		details.put("tips",tips(task.id())); details.put("reminders",reminders.views(task.id()));
		details.put("comments",jdbc.sql("""
				select id,author_id,side,target_assignee_id,text,kind,created_at from task_comments
				where task_id=:id and task_version=:version order by created_at,id
				""").param("id",task.id()).param("version",task.version()).query((row,index)->{
			var comment=new LinkedHashMap<String,Object>(); comment.put("id",row.getString("id"));
			comment.put("authorId",row.getString("author_id")); comment.put("side",row.getString("side"));
			comment.put("targetAssigneeId",row.getString("target_assignee_id")); comment.put("text",row.getString("text"));
			comment.put("kind",row.getString("kind")); comment.put("createdAt",row.getTimestamp("created_at").toInstant());
			return comment;
		}).list());
		jdbc.sql("insert into task_status_history(id,task_id,actor_id,previous_status,new_status,details,occurred_at) values (:id,:task,:actor,:before,:after,cast(:details as jsonb),:now)")
				.param("id","history_"+UUID.randomUUID()).param("task",task.id()).param("actor",actor.id())
				.param("before",before).param("after",task.status()).param("details",encode(details)).param("now",SqlTime.of(clock.instant())).update();
		audit.write(actor.id(),"task",task.id(),action,details);
		var payload=new LinkedHashMap<String,Object>(); payload.put("taskId",task.id()); payload.put("title",task.title());
		payload.put("action",action); payload.put("status",task.status()); payload.put("version",task.version());
		payload.put("completedBy",task.completedBy()); payload.put("disableNotification",true);
		payload.put("description",task.description()); payload.put("sow",task.sow()); payload.put("priority",task.priority());
		payload.put("dueAt",task.dueAt()); payload.put("eventId",task.eventId()); payload.put("facultyId",task.facultyId());
		payload.put("assigneeIds",assigned); payload.put("timeSpentMinutes",task.minutes());
		payload.put("tips",tips(task.id())); payload.put("reminders",reminders.views(task.id()));
		jdbc.sql("select text from task_comments where task_id=:id and task_version=:version order by created_at,id")
				.param("id",task.id()).param("version",task.version()).query(String.class).optional()
				.ifPresent(text->payload.put("comment",text));
		payload.put("audienceUserIds",recipients.stream().distinct().filter(id->!id.equals(actor.id())).toList());
		if(List.of("created","status","updated","claim","release","comment","cancel").contains(action)) {
			var audience=List.of("created","updated").contains(action) && "open".equals(task.status()) && task.facultyId()==null
					? openCoreAudience(task.id(),actor.id())
					: recipients.stream().distinct().filter(id->!id.equals(actor.id()) && (!"updated".equals(action) || assigned.contains(id))).toList();
			if(List.of("claim","release").contains(action)) {
				var extra="claim".equals(action)?jdbc.sql("select id from users where active and registered and role='admin' and id<>:actor order by id").param("actor",actor.id()).query(String.class).list()
						:"open".equals(task.status()) && task.facultyId()==null?openCoreAudience(task.id(),actor.id()):List.<String>of();
				var targets=new java.util.TreeSet<>(extra);if(task.creatorId()!=null && !task.creatorId().equals(actor.id()))targets.add(task.creatorId());audience=List.copyOf(targets);
			}
			payload.put("actorId",actor.id());payload.put("actorName",actor.realName());payload.put("audienceUserIds",audience);
			var snapshot=recipientSnapshot(audience);
			if(List.of("claim","release").contains(action))for(var person:snapshot)person.put("kind",person.get("userId").equals(task.creatorId())?"coordinator":"claim".equals(action)?"admin":"open");
			payload.put("recipientSnapshot",snapshot);
			if("updated".equals(action)) { payload.put("previousTitle",previousTitle);payload.put("removedAssigneeIds",removed);payload.put("removedRecipientSnapshot",recipientSnapshot(removed)); }
		}
		outbox.write("task",task.id(),"task."+action,"task:"+task.id()+":"+task.version()+":"+action,encode(payload),clock.instant());
	}
	private List<Map<String,Object>> recipientSnapshot(List<String> ids) {
		return ids.isEmpty()?List.of():jdbc.sql("select id,telegram_id from users where id in (:ids) order by id").param("ids",ids).query((r,i)->{
			Map<String,Object> person=new LinkedHashMap<>();person.put("userId",r.getString(1));person.put("telegramId",r.getObject(2));return person;
		}).list();
	}
	private List<String> openCoreAudience(String task,String actor) {
		return jdbc.sql("""
				select u.id from users u where u.active and u.registered and u.role in ('admin','organizer') and u.id<>:actor
				and (not exists(select 1 from task_competencies c where c.task_id=:task) or exists
				(select 1 from task_competencies c join user_competencies uc on uc.competency_id=c.competency_id where c.task_id=:task and uc.user_id=u.id)) order by u.id
				""").param("actor",actor).param("task",task).query(String.class).list();
	}
	@Transactional
	Map<String,Object> notify(String id,long expectedVersion,AuthenticatedUser actor) {
		TaskMaintenanceGate.shared(jdbc);
		var task=require(id,true); access(task,actor); coordinator(task,actor); version(task,expectedVersion);
		if("cancelled".equals(task.status())) throw TaskRules.conflict("task_closed","Задача отменена");
		if(assignees(id).isEmpty()) throw TaskRules.bad("task_assignees_required","Сначала назначьте исполнителей");
		var recipients=jdbc.sql("""
				select u.id,u.telegram_id from task_assignees a join users u on u.id=a.user_id
				where a.task_id=:id and u.active and u.registered order by u.id
				""").param("id",id).query((row,index)->{
			var r=new LinkedHashMap<String,Object>(); r.put("userId",row.getString("id")); r.put("telegramId",row.getObject("telegram_id")); return r;
		}).list();
		if(recipients.isEmpty()) throw TaskRules.bad("task_recipients_unavailable","Нет активных исполнителей для напоминания");
		var payload=new LinkedHashMap<String,Object>();
		payload.put("taskId",id); payload.put("version",task.version()); payload.put("action","manual_reminder");
		payload.put("title",task.title()); payload.put("description",task.description()); payload.put("sow",task.sow());
		payload.put("priority",task.priority()); payload.put("dueAt",task.dueAt()); payload.put("facultyId",task.facultyId());
		payload.put("tips",tips(id)); payload.put("competencyIds",competencies(id));
		payload.put("disableNotification",true); payload.put("category","task_reminder");
		payload.put("audienceUserIds",recipients.stream().map(r->r.get("userId")).toList());
		payload.put("recipientSnapshot",recipients);
		var operation="manual_"+UUID.randomUUID();
		var eventId=outbox.write("task",id,"task.manual_reminder","task:"+id+":"+operation,encode(payload),clock.instant());
		audit.write(actor.id(),"task",id,"manual_reminder",Map.of("outboxId",eventId,"version",task.version(),"audienceUserIds",payload.get("audienceUserIds")));
		var queued=recipients.stream().filter(r->r.get("telegramId")!=null).count();
		return Map.of("success",true,"outboxId",eventId,"queued",queued,"delivered",0,"unavailable",recipients.size()-queued,"deliveryStatus","pending");
	}
	private Map<String,Object> view(TaskRow task,AuthenticatedUser actor) {
		var result=new LinkedHashMap<String,Object>();
		result.put("id",task.id()); result.put("title",task.title()); result.put("description",task.description()); result.put("sow",task.sow());
		result.put("priority",task.priority()); result.put("status",task.status()); result.put("eventId",task.eventId());
		result.put("facultyId",task.facultyId()); result.put("creatorId",task.creatorId()); result.put("dueAt",task.dueAt());
		result.put("assignmentMode","shared"); result.put("assigneeIds",assignees(task.id())); result.put("competencyIds",competencies(task.id()));
		result.put("completedBy",task.completedBy()); result.put("completedAt",task.completedAt()); result.put("timeSpentMinutes",task.minutes()); result.put("version",task.version());
		result.put("createdAt",task.createdAt()); result.put("cancelledAt",task.cancelledAt()); result.put("cancelledBy",task.cancelledBy());
		if("completed".equals(task.status())) result.put("completionVersion",jdbc.sql("""
				select (details->>'version')::bigint from task_status_history where task_id=:id
				and new_status='completed' and details->>'action'='status' and details->>'completedBy'=:actor
				order by occurred_at desc,id desc limit 1
				""").param("id",task.id()).param("actor",task.completedBy()).query(Long.class).optional().orElse(task.version()));
		result.put("legacyDeadline",task.legacyDeadline()); result.put("tips",tips(task.id())); result.put("reminders",reminders.views(task.id()));
		result.put("comments",jdbc.sql("""
				select id,author_id,side,target_assignee_id,text,created_at,kind,task_version from task_comments where task_id=:id
				and (:core or target_assignee_id=:actor or author_id=:actor) order by created_at,id
				""").param("id",task.id()).param("core",core(actor)).param("actor",actor.id()).query((row,index)->{
			var comment=new LinkedHashMap<String,Object>(); comment.put("id",row.getString("id")); comment.put("authorId",row.getString("author_id"));
			comment.put("side",row.getString("side")); comment.put("targetAssigneeId",row.getString("target_assignee_id"));
			comment.put("text",row.getString("text")); comment.put("createdAt",row.getTimestamp("created_at").toInstant());
			comment.put("kind",row.getString("kind")); comment.put("taskVersion",row.getObject("task_version")); return comment;
		}).list());
		return result;
	}
	private TaskRow require(String id,boolean lock) {
		return jdbc.sql("select * from tasks where id=:id and removed_at is null"+(lock?" for update":"")).param("id",id)
				.query((row,index)->row(row)).optional().orElseThrow(()->new ApiException(HttpStatus.NOT_FOUND,"task_not_found","Задача не найдена"));
	}
	private TaskRow row(java.sql.ResultSet row) throws java.sql.SQLException {
		return new TaskRow(row.getString("id"),row.getString("title"),row.getString("description"),row.getString("sow"),row.getString("priority"),
				row.getString("status"),row.getString("event_id"),row.getBoolean("faculty_all")?"all":row.getString("faculty_id"),row.getString("creator_id"),instant(row,"due_at"),
				row.getString("completed_by"),instant(row,"completed_at"),(Integer)row.getObject("time_spent_minutes"),row.getLong("version"),
				instant(row,"created_at"),instant(row,"cancelled_at"),row.getString("cancelled_by"),row.getString("legacy_deadline"));
	}
	private Instant instant(java.sql.ResultSet row,String field) throws java.sql.SQLException { var value=row.getTimestamp(field); return value==null?null:value.toInstant(); }
	private List<String> assignees(String id) { return jdbc.sql("select user_id from task_assignees where task_id=:id order by user_id").param("id",id).query(String.class).list(); }
	private List<String> competencies(String id) { return jdbc.sql("select competency_id from task_competencies where task_id=:id order by competency_id").param("id",id).query(String.class).list(); }
	private void access(TaskRow task,AuthenticatedUser actor) {
		if(core(actor)) return;
		var faculty=jdbc.sql("select faculty_id from faculty_memberships where user_id=:id").param("id",actor.id()).query(String.class).optional().orElse(null);
		if(faculty==null || !(faculty.equals(task.facultyId()) || "all".equals(task.facultyId())) || !assignees(task.id()).contains(actor.id())) throw forbidden();
	}
	private void coordinator(TaskRow task,AuthenticatedUser actor) {
		if(!core(actor) || (!"admin".equals(actor.role()) && !actor.id().equals(task.creatorId()))) throw forbidden();
	}
	private void editable(TaskRow task) {
		if(List.of("completed","cancelled").contains(task.status())) throw TaskRules.conflict("task_closed","Сначала верните задачу в работу");
	}
	private void version(TaskRow task,long version) { if(task.version()!=version) throw TaskRules.conflict("stale_version","Задача уже изменилась"); }
	private boolean core(AuthenticatedUser actor) { return List.of("admin","organizer").contains(actor.role()); }
	private String blank(String value) { return value==null || value.isBlank()?null:value.strip(); }
	private ApiException forbidden() { return new ApiException(HttpStatus.FORBIDDEN,"task_access_denied","Нет прав на это действие с задачей"); }
	private String encode(Object value) { try { return json.writeValueAsString(value); } catch(Exception error) { throw new IllegalStateException("Cannot serialize task event",error); } }
	private record TaskRow(String id,String title,String description,String sow,String priority,String status,String eventId,
			String facultyId,String creatorId,Instant dueAt,String completedBy,Instant completedAt,Integer minutes,long version,
			Instant createdAt,Instant cancelledAt,String cancelledBy,String legacyDeadline) {}
}
