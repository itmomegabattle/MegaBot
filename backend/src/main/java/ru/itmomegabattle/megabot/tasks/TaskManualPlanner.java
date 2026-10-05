package ru.itmomegabattle.megabot.tasks;

import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.SqlTime;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;
import tools.jackson.databind.ObjectMapper;

/** Audited manual reminders, creation, update and status events share one immutable private-target lifecycle. */
@Service
public class TaskManualPlanner {
	private final JdbcClient jdbc;private final DeliveryQueue queue;private final ObjectMapper json;private final TaskDeliveryGate gate;
	public TaskManualPlanner(JdbcClient jdbc,DeliveryQueue queue,ObjectMapper json,TaskDeliveryGate gate) { this.jdbc=jdbc;this.queue=queue;this.json=json;this.gate=gate; }
	@Transactional
	public int materialize(int limit) {
		if(limit<1 || limit>100)throw new IllegalArgumentException("invalid_manual_batch");TaskMaintenanceGate.shared(jdbc);
		jdbc.sql("""
				update outbox_events e set status='cancelled',last_error_code='task_unavailable',updated_at=clock_timestamp()
				where e.aggregate_type='task' and e.event_type in ('task.manual_reminder','task.created','task.status','task.updated','task.claim','task.release','task.comment','task.cancel') and e.status in ('pending','retry') and e.available_at<=clock_timestamp()
				and not exists(select 1 from tasks t where t.id=e.aggregate_id and t.removed_at is null)
				""").update();
		var tasks=jdbc.sql("""
				select t.id from tasks t where t.removed_at is null and exists(select 1 from outbox_events e where
				e.aggregate_type='task' and e.aggregate_id=t.id and e.event_type in ('task.manual_reminder','task.created','task.status','task.updated','task.claim','task.release','task.comment','task.cancel') and e.status in ('pending','retry') and e.available_at<=clock_timestamp())
				order by t.id for update skip locked limit :limit
				""").param("limit",limit).query(String.class).list();int count=0;
		for(var task:tasks) {
			var events=jdbc.sql("select id,payload::text,available_at,event_type from outbox_events where aggregate_type='task' and aggregate_id=:task and event_type in ('task.manual_reminder','task.created','task.status','task.updated','task.claim','task.release','task.comment','task.cancel') and status in ('pending','retry') and available_at<=clock_timestamp() order by id for update limit 20")
					.param("task",task).query((r,i)->new Event(r.getString(1),r.getString(2),r.getTimestamp(3).toInstant(),r.getString(4).substring(5))).list();
			for(var event:events) {
				count++;Snapshot snapshot;
				try {
					var root=json.readTree(event.payload());var version=root.path("version");var title=root.path("title");var people=root.path("recipientSnapshot");
					if("created".equals(event.action()) && (!root.path("action").asText().equals("created") || !root.path("actorId").isString() || !List.of("open","assigned","waiting").contains(root.path("status").asText())))throw new IllegalArgumentException("invalid_creation_payload");
					if("updated".equals(event.action()) && (!root.path("action").asText().equals("updated") || !root.path("actorId").isString() || !List.of("open","assigned","waiting","in_progress").contains(root.path("status").asText())))throw new IllegalArgumentException("invalid_update_payload");
					if(List.of("status","claim","release","comment","cancel").contains(event.action()) && (!root.path("action").asText().equals(event.action()) || !root.path("actorId").isString() || !root.path("actorName").isString() || root.path("actorName").asText().isBlank() || root.path("actorName").asText().length()>200 || !List.of("open","assigned","waiting","in_progress","completed","cancelled").contains(root.path("status").asText())))throw new IllegalArgumentException("invalid_status_payload");
					if(!root.path("taskId").asText().equals(task) || !version.isIntegralNumber() || !version.canConvertToLong() || version.asLong()<0 || !title.isString() || title.asText().isBlank() || title.asText().length()>160 || !people.isArray() || people.size()>2000)
						throw new IllegalArgumentException("invalid_manual_payload");
					if("claim".equals(event.action()) && !"assigned".equals(root.path("status").asText()) || "release".equals(event.action()) && !List.of("open","assigned","waiting","in_progress").contains(root.path("status").asText()))throw new IllegalArgumentException("invalid_assignment_status");
					var ids=new HashSet<String>();var recipients=new java.util.ArrayList<Recipient>();
					if("status".equals(event.action()) && "cancelled".equals(root.path("status").asText()))throw new IllegalArgumentException("invalid_status_payload");
					if("cancel".equals(event.action()) && !"cancelled".equals(root.path("status").asText()) || "comment".equals(event.action()) && !List.of("open","assigned","waiting","in_progress").contains(root.path("status").asText()))throw new IllegalArgumentException("invalid_mutation_status");
					for(var person:people) {
						var id=person.path("userId");var chat=person.path("telegramId");
						if(!id.isString() || id.asText().isBlank() || !ids.add(id.asText()) || !(chat.isNull() || chat.isIntegralNumber() && chat.canConvertToLong()))throw new IllegalArgumentException("invalid_manual_target");
						var kind=person.path("kind").asText();
						if(List.of("claim","release").contains(event.action()) && !("coordinator".equals(kind) || "claim".equals(event.action()) && "admin".equals(kind) || "release".equals(event.action()) && "open".equals(root.path("status").asText()) && "open".equals(kind)))throw new IllegalArgumentException("invalid_assignment_kind");
						recipients.add(new Recipient(id.asText(),chat.isNull()?null:chat.asLong(),false,kind));
					}
					if(!"manual_reminder".equals(event.action())) {
						var audience=root.path("audienceUserIds");var declared=new HashSet<String>();
						if(!audience.isArray() || audience.size()>2000)throw new IllegalArgumentException("invalid_creation_audience");
						for(var id:audience)if(!id.isString() || !declared.add(id.asText()))throw new IllegalArgumentException("invalid_creation_audience");
						if(!declared.equals(ids) || ids.contains(root.path("actorId").asText()))throw new IllegalArgumentException("invalid_creation_audience");
						if("status".equals(event.action()) && ids.size()>1 || List.of("claim","release").contains(event.action()) && recipients.stream().filter(p->"coordinator".equals(p.kind())).count()>1)throw new IllegalArgumentException("invalid_status_audience");
					}
					var oldTitle=root.path("previousTitle");
					if("updated".equals(event.action())) {
						var removed=root.path("removedRecipientSnapshot");var removedIds=root.path("removedAssigneeIds");
						if(!oldTitle.isString() || oldTitle.asText().isBlank() || oldTitle.asText().length()>160 || !removed.isArray() || removed.size()>2000 || !removedIds.isArray() || removedIds.size()!=removed.size())throw new IllegalArgumentException("invalid_removal_snapshot");
						var declared=new HashSet<String>();for(var id:removedIds)if(!id.isString() || !declared.add(id.asText()) || id.asText().equals(root.path("actorId").asText()))throw new IllegalArgumentException("invalid_removal_audience");
						var seen=new HashSet<String>();for(var person:removed) {
							var id=person.path("userId");var chat=person.path("telegramId");
							if(!id.isString() || !declared.contains(id.asText()) || !seen.add(id.asText()) || !(chat.isNull() || chat.isIntegralNumber() && chat.canConvertToLong()))throw new IllegalArgumentException("invalid_removal_target");
							recipients.add(new Recipient(id.asText(),chat.isNull()?null:chat.asLong(),true));
						}
					}
					snapshot=new Snapshot(version.asLong(),title.asText(),recipients,root.path("actorId").asText(),root.path("status").asText(),root.path("actorName").asText(),oldTitle.asText(),"updated".equals(event.action())?root.path("removedAssigneeIds").toString():"[]");
				}catch(RuntimeException invalid) { complete(event.id(),"failed","invalid_manual_payload");continue; }
				var actor=jdbc.sql("select actor_id from audit_events where entity_type='task' and entity_id=:task and action=:action and actor_id is not null and ((:action='manual_reminder' and changes->>'outboxId'=:id) or (:action in ('created','status','updated','claim','release','comment','cancel') and actor_id=:actor and changes->>'version'=:version and (:action<>'status' or changes->>'action'='status') and (:action<>'updated' or (changes->>'previousTitle'=:title and changes->'removedAssigneeIds'=cast(:removed as jsonb))))) order by id limit 1")
						.param("task",task).param("id",event.id()).param("action",event.action()).param("actor",snapshot.actor()).param("version",Long.toString(snapshot.version())).param("title",snapshot.previousTitle()).param("removed",snapshot.removedIds()).query(String.class).optional();
				if(actor.isEmpty()) { complete(event.id(),"failed","manual_actor_not_verified");continue; }
				var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();var expiry=event.due().plusSeconds(900);
				var valid=List.of("comment","cancel").contains(event.action())?gate.mutationTaskValid(task,snapshot.version(),actor.get(),snapshot.status(),event.action()):List.of("claim","release").contains(event.action())?gate.assignmentTaskValid(task,snapshot.version(),actor.get(),snapshot.status(),event.action()):"status".equals(event.action())?gate.statusTaskValid(task,snapshot.version(),actor.get(),snapshot.status()):gate.manualTaskValid(task,snapshot.version(),actor.get()) && (!List.of("created","updated").contains(event.action()) || gate.creationTaskActive(task));var state=!valid?"cancelled":!expiry.isAfter(now)?"expired":"queued";
				jdbc.sql("insert into task_manual_intents(id,task_id,task_version,actor_id,expires_at,state,action,task_status) values (:id,:task,:version,:actor,:expiry,:state,:action,:status)")
						.param("id",event.id()).param("task",task).param("version",snapshot.version()).param("actor",actor.get()).param("expiry",SqlTime.of(expiry)).param("state",state).param("action",event.action()).param("status",List.of("status","claim","release","comment","cancel").contains(event.action())?snapshot.status():null).update();
				int unavailable=0,queued=0;
				if("queued".equals(state))for(var person:snapshot.people()) {
					if(person.chat()==null || person.chat()<=0 || !(person.removed()?gate.removedRecipientValid(task,person.id(),person.chat()):switch(event.action()) { case "created","updated"->gate.creationRecipientValid(task,person.id(),person.chat());case "comment","cancel"->gate.mutationRecipientValid(task,snapshot.version(),actor.get(),person.id(),person.chat(),event.action());case "status"->gate.statusRecipientValid(task,person.id(),person.chat());case "claim","release"->gate.assignmentRecipientValid(task,person.id(),person.chat(),event.action(),person.kind());default->gate.recipientValid(task,person.id(),person.chat()); })) { unavailable++;continue; }
					var prefix=switch(event.action()) { case "created"->"open".equals(snapshot.status())?"Новая открытая задача":"Вам назначена задача";case "updated"->"open".equals(snapshot.status())?"Открытая задача изменена":"Задача изменена";case "comment"->"Новый комментарий к задаче";case "cancel"->"Задача отменена";case "claim"->"Задача взята в работу";case "release"->"open".equals(person.kind())?"Задача снова свободна":"Исполнитель отказался от задачи";case "status"->"completed".equals(snapshot.status())?"Задача завершена":"Статус задачи изменён: "+statusLabel(snapshot.status());default->"Напоминание от координатора"; };
					var text=person.removed()?"Ваше назначение на задачу снято\n\n"+snapshot.previousTitle():prefix+"\n\n"+snapshot.title()+(List.of("status","claim","release","comment","cancel").contains(event.action())?"\nИнициатор: "+snapshot.actorName():"");
					var payload=json.writeValueAsString(Map.of("text",text,"taskId",task,"sourceOutboxId",event.id()));
					var category=person.removed()?"task_unassigned":switch(event.action()) {case "created"->"task_created";case "updated"->"task_updated";case "status"->"task_status";case "comment"->"task_comment";case "cancel"->"task_cancel";case "claim","release"->"task_assignment";default->"task_manual";};
					var delivery=queue.enqueue(new DeliveryQueue.NewDelivery(event.id(),"manual-task:"+event.id()+":"+person.id()+(person.removed()?":unassigned":""),category,person.id(),person.chat(),null,payload,true,event.due(),event.due(),expiry));
					jdbc.sql("update notification_deliveries set task_manual_id=:source where id=:id").param("source",event.id()).param("id",delivery).update();queued++;
				}
				if("queued".equals(state) && queued==0)state="unavailable";
				jdbc.sql("update task_manual_intents set unavailable_count=:count,state=:state where id=:id").param("id",event.id()).param("count",unavailable).param("state",state).update();
				complete(event.id(),"completed",null);
			}
		}return count;
	}
	private void complete(String id,String status,String code) { jdbc.sql("update outbox_events set status=:status,last_error_code=:code,attempts=attempts+1,lease_token=null,leased_until=null,updated_at=clock_timestamp() where id=:id")
			.param("id",id).param("status",status).param("code",code).update(); }
	private record Event(String id,String payload,Instant due,String action) {}
	private record Recipient(String id,Long chat,boolean removed,String kind) {
		Recipient(String id,Long chat,boolean removed) { this(id,chat,removed,""); }
	}
	private static String statusLabel(String status) { return switch(status) {case "open"->"открыта";case "assigned"->"назначена";case "waiting"->"ожидает";case "in_progress"->"в работе";default->throw new IllegalArgumentException("invalid_task_status");}; }
	private record Snapshot(long version,String title,List<Recipient> people,String actor,String status,String actorName,String previousTitle,String removedIds) {}
}
