package ru.itmomegabattle.megabot.tasks;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import jakarta.validation.Validator;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import tools.jackson.databind.JsonNode;

/** Partial legacy edits are merged inside the command transaction, then validated by the same domain. */
@Service
class LegacyTaskMutationService {
	private final TaskService tasks;
	private final JdbcClient jdbc;
	private final Validator validator;
	LegacyTaskMutationService(TaskService tasks,JdbcClient jdbc,Validator validator) {
		this.tasks=tasks; this.jdbc=jdbc; this.validator=validator;
	}
	@Transactional
	public Map<String,Object> update(JsonNode body,AuthenticatedUser actor,boolean facultyRoute) {
		TaskMaintenanceGate.shared(jdbc);
		var id=id(body); var current=tasks.get(id,actor);
		var faculty=(String)current.get("facultyId");
		if(facultyRoute!=(faculty!=null)) throw TaskRules.bad("wrong_task_route","Выберите маршрут контура задачи");
		var selectedFaculty=body.has("facultyId")?text(body,"facultyId",null):faculty;
		var due=(Instant)current.get("dueAt");
		var deadline=body.has("deadline")?date(body.get("deadline")):due==null?null:due.atZone(ZoneId.of("Europe/Moscow")).toLocalDate();
		var assigned=body.has("assignedTo")?strings(body.get("assignedTo"),200,true):stringList(current.get("assigneeIds"));
		var competencies=body.has("competencies")?competencyIds(strings(body.get("competencies"),100,false),faculty)
				:body.has("competency")?competencyIds(strings(body.get("competency"),1,true),faculty):stringList(current.get("competencyIds"));
		var tips=body.has("tips") && !body.get("tips").isNull()?strings(body.get("tips"),50,false):null;
		List<TaskController.ReminderInput> reminders=null;
		if(body.has("reminders") && !body.get("reminders").isNull()) {
			var values=body.get("reminders");
			if(!values.isArray() || values.size()>3) throw bad();
			reminders=new ArrayList<>();
			for(var value:values) {
				if(!value.isObject() || !value.path("value").isIntegralNumber() || !value.path("value").canConvertToInt()) throw bad();
				var reminderId=text(value,"id",null);
				if(reminderId!=null && reminderId.startsWith("draft_")) reminderId=null;
				reminders.add(new TaskController.ReminderInput(reminderId,text(value,"type",null),value.path("value").asInt(),text(value,"unit",null)));
			}
		}
		var mutation=new TaskController.Mutation(text(body,"title",(String)current.get("title")),
				text(body,"description",(String)current.get("description")),text(body,"sow",(String)current.get("sow")),
				text(body,"priority",(String)current.get("priority")),text(body,"eventId",(String)current.get("eventId")),
				selectedFaculty,deadline,assigned,competencies,version(body),tips,reminders);
		validate(mutation);
		return result(tasks.update(id,mutation,actor));
	}
	@Transactional
	public Map<String,Object> assignment(JsonNode body,AuthenticatedUser actor,String action) {
		var task=tasks.assignment(id(body),action,version(body),actor);
		var response=new java.util.LinkedHashMap<String,Object>(result(task));
		if("release".equals(action)) {
			response.put("becameOpen","open".equals(task.get("status")));
			response.put("remainingAssigneeIds",task.get("assigneeIds"));
		}
		return response;
	}
	@Transactional
	public Map<String,Object> notify(JsonNode body,AuthenticatedUser actor) {
		return tasks.notify(id(body),version(body),actor);
	}
	@Transactional
	public Map<String,Object> comment(JsonNode body,AuthenticatedUser actor) {
		var side=text(body,"side",null);
		var target="executor".equals(side)?null:text(body,"assigneeId",null);
		if("coordinator".equals(side) && (target==null || target.isBlank())) throw TaskRules.bad("comment_target_required","Выберите исполнителя");
		var comment=new TaskController.Comment(side,target,text(body,"text",null),version(body)); validate(comment);
		return result(tasks.comment(id(body),comment,actor));
	}
	@Transactional
	public Map<String,Object> status(JsonNode body,AuthenticatedUser actor) {
		Integer minutes=null;
		if(body.hasNonNull("timeSpentMinutes")) {
			var value=body.get("timeSpentMinutes");
			if(!value.isIntegralNumber() || !value.canConvertToInt()) throw bad();
			minutes=value.asInt();
		}
		var request=new TaskController.Status(text(body,"status",null),version(body),minutes,text(body,"completionComment",null));
		validate(request);
		var task=tasks.status(id(body),request,actor);
		if("completed".equals(request.status())) {
			var completion=(Map<?,?>)TaskFrontendMapper.map(task,List.of()).get("completionComments");
			var previous=java.util.Objects.toString(completion.get(task.get("completedBy")),"");
			if((body.has("timeSpentMinutes") && !java.util.Objects.equals(minutes,task.get("timeSpentMinutes")))
					|| (body.has("completionComment") && !previous.equals(request.completionComment()==null?"":request.completionComment().strip())))
				throw TaskRules.conflict("completion_reopen_required","Для изменения результата сначала верните задачу в работу");
		}
		return result(task);
	}
	private Map<String,Object> result(Map<String,Object> task) {
		var labels=jdbc.sql("select c.name from competencies c join task_competencies tc on tc.competency_id=c.id where tc.task_id=:id order by c.name,c.id")
				.param("id",task.get("id")).query(String.class).list();
		return Map.of("success",true,"task",TaskFrontendMapper.map(task,labels));
	}
	private List<String> competencyIds(List<String> names,String faculty) {
		return names.stream().map(String::strip).distinct().map(name->jdbc.sql("select id from competencies where name=:name and active and scope=:scope")
				.param("name",name).param("scope",faculty==null?"core":"faculty").query(String.class).optional()
				.orElseThrow(()->TaskRules.bad("invalid_task_competency","Компетенция недоступна в этом контуре"))).toList();
	}
	static String id(JsonNode body) { return TaskRules.text(text(body,"taskId",null),1,200); }
	static long version(JsonNode body) {
		var value=body.get("version");
		if(value==null || !value.isIntegralNumber() || !value.canConvertToLong() || value.asLong()<0)
			throw TaskRules.bad("version_required","Укажите актуальную целую версию задачи");
		return value.asLong();
	}
	private static String text(JsonNode body,String field,String fallback) {
		if(body==null || !body.isObject()) throw bad();
		var value=body.get(field); if(value==null) return fallback; if(value.isNull()) return null;
		if(!value.isString()) throw bad(); return value.asText();
	}
	private LocalDate date(JsonNode node) {
		if(node==null || !node.isString() || !node.asText().matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw TaskRules.bad("invalid_deadline","Укажите календарную дату дедлайна");
		try { return LocalDate.parse(node.asText()); }
		catch(java.time.DateTimeException error) { throw TaskRules.bad("invalid_deadline","Несуществующая дата дедлайна"); }
	}
	private List<String> strings(JsonNode node,int limit,boolean scalar) {
		if(node==null || node.isNull()) return List.of();
		if(scalar && node.isString()) return node.asText().isBlank()?List.of():List.of(node.asText());
		if(!node.isArray() || node.size()>limit) throw bad();
		var result=new ArrayList<String>();
		for(var value:node) { if(!value.isString() || value.asText().isBlank()) throw bad(); result.add(value.asText()); }
		return result;
	}
	@SuppressWarnings("unchecked") private List<String> stringList(Object value) { return (List<String>)value; }
	private void validate(Object request) { if(!validator.validate(request).isEmpty()) throw bad(); }
	private static ru.itmomegabattle.megabot.common.ApiException bad() { return TaskRules.bad("invalid_task_payload","Проверьте поля задачи"); }
}
