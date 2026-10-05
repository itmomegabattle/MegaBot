package ru.itmomegabattle.megabot.tasks;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.IdempotencyService;
import tools.jackson.databind.JsonNode;
import ru.itmomegabattle.megabot.tasks.TaskController.ReminderInput;

/** Old request/response names only; actor identity and writes still belong to the Java domain. */
@RestController
@PreAuthorize("hasAnyRole('ADMIN','ORGANIZER')")
class LegacyTaskCreateController {
	private final TaskService tasks;
	private final JdbcClient jdbc;
	private final IdempotencyService idempotency;
	LegacyTaskCreateController(TaskService tasks,JdbcClient jdbc,IdempotencyService idempotency) {
		this.tasks=tasks; this.jdbc=jdbc; this.idempotency=idempotency;
	}
	@PostMapping("/api/task/create")
	ResponseEntity<Object> core(@Valid @RequestBody Create request,@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String key) {
		if(request.facultyId()!=null && !request.facultyId().isBlank())
			throw TaskRules.bad("use_faculty_task_route","Используйте создание факультетской задачи");
		return create(request,actor,key,false);
	}
	@PostMapping("/api/faculty/task/create")
	ResponseEntity<Object> faculty(@Valid @RequestBody Create request,@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String key) {
		if(request.facultyId()==null || request.facultyId().isBlank()) throw TaskRules.bad("faculty_required","Укажите факультет");
		if(assignees(request.assignedTo()).isEmpty()) throw TaskRules.bad("assignees_required","Выберите исполнителей");
		return create(request,actor,key,true);
	}
	private ResponseEntity<Object> create(Create request,AuthenticatedUser actor,String key,boolean faculty) {
		var result=idempotency.execute(actor.id(),faculty?"legacy.faculty.task.create":"legacy.task.create",key,request,200,()->{
			var names=request.competencies()!=null?request.competencies()
					:request.competency()==null || request.competency().isBlank()?List.<String>of():List.of(request.competency());
			var ids=new ArrayList<String>();
			for(var name:names.stream().map(String::strip).distinct().toList()) {
				ids.add(jdbc.sql("select id from competencies where name=:name and scope=:scope and active")
						.param("name",name).param("scope",faculty?"faculty":"core").query(String.class).optional()
						.orElseThrow(()->TaskRules.bad("invalid_task_competency","Компетенция недоступна в этом контуре")));
			}
			// Legacy form ids are client-local draft keys, never persisted reminder identities.
			var reminders=request.reminders()==null?null:request.reminders().stream()
					.map(r->new TaskController.ReminderInput(null,r.type(),r.value(),r.unit())).toList();
			var mutation=new TaskController.Mutation(request.title(),request.description(),request.sow(),
					request.priority()==null?"normal":request.priority(),request.eventId(),faculty?request.facultyId():null,
					request.deadline(),assignees(request.assignedTo()),ids,null,request.tips(),reminders);
			var task=faculty?tasks.createLegacyFaculty(mutation,actor):tasks.create(mutation,actor);
			var labels=jdbc.sql("select c.name from competencies c join task_competencies tc on tc.competency_id=c.id where tc.task_id=:id order by c.name,c.id")
					.param("id",task.get("id")).query(String.class).list();
			return Map.of("success",true,"task",TaskFrontendMapper.map(task,labels));
		});
		var response=ResponseEntity.status(result.status());
		if(result.replayed()) response.header("Idempotency-Replayed","true");
		return response.body(result.body());
	}
	private List<String> assignees(JsonNode node) {
		if(node==null || node.isNull()) return List.of();
		if(node.isString()) return node.asText().isBlank()?List.of():List.of(node.asText());
		if(!node.isArray() || node.size()>200) throw TaskRules.bad("invalid_assignees","Некорректный список исполнителей");
		var ids=new ArrayList<String>();
		for(var item:node) {
			if(!item.isString() || item.asText().isBlank()) throw TaskRules.bad("invalid_assignees","Некорректный исполнитель");
			ids.add(item.asText());
		}
		return ids;
	}
	// requesterId/creatorId from a legacy body are intentionally not identity inputs.
	record Create(@NotBlank @Size(max=160) String title,@Size(max=4000) String description,@NotNull LocalDate deadline,
			JsonNode assignedTo,@Size(max=8000) String sow,@Size(max=50) List<@NotBlank @Size(max=1000) String> tips,
			String priority,@Size(max=200) String facultyId,@Size(max=200) String eventId,
			@Size(max=100) List<@NotBlank @Size(max=200) String> competencies,@Size(max=200) String competency,
			@Size(max=3) List<@NotNull @Valid ReminderInput> reminders) {}
}
