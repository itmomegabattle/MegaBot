package ru.itmomegabattle.megabot.tasks;

import java.util.function.Supplier;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.IdempotencyService;
import tools.jackson.databind.JsonNode;

@RestController
@PreAuthorize("isAuthenticated()")
class LegacyTaskMutationController {
	private final LegacyTaskMutationService tasks;
	private final IdempotencyService idempotency;
	LegacyTaskMutationController(LegacyTaskMutationService tasks,IdempotencyService idempotency) { this.tasks=tasks; this.idempotency=idempotency; }
	@PostMapping("/api/task/update")
	@PreAuthorize("hasAnyRole('ADMIN','ORGANIZER')")
	ResponseEntity<Object> update(@RequestBody JsonNode body,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return execute("update",body,actor,key,()->tasks.update(body,actor,false));
	}
	@PostMapping("/api/faculty/task/update")
	@PreAuthorize("hasAnyRole('ADMIN','ORGANIZER')")
	ResponseEntity<Object> facultyUpdate(@RequestBody JsonNode body,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return execute("faculty.update",body,actor,key,()->tasks.update(body,actor,true));
	}
	@PostMapping("/api/task/claim")
	ResponseEntity<Object> claim(@RequestBody JsonNode body,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return execute("claim",body,actor,key,()->tasks.assignment(body,actor,"claim"));
	}
	@PostMapping("/api/task/release")
	ResponseEntity<Object> release(@RequestBody JsonNode body,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return execute("release",body,actor,key,()->tasks.assignment(body,actor,"release"));
	}
	@PostMapping("/api/task/delete")
	ResponseEntity<Object> cancel(@RequestBody JsonNode body,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return execute("cancel",body,actor,key,()->tasks.assignment(body,actor,"cancel"));
	}
	@PostMapping("/api/task/comment")
	ResponseEntity<Object> comment(@RequestBody JsonNode body,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return execute("comment",body,actor,key,()->tasks.comment(body,actor));
	}
	@PostMapping("/api/task/notify")
	ResponseEntity<Object> notify(@RequestBody JsonNode body,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return execute("notify",body,actor,key,()->tasks.notify(body,actor));
	}
	@PostMapping("/api/task/status")
	ResponseEntity<Object> status(@RequestBody JsonNode body,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return execute("status",body,actor,key,()->tasks.status(body,actor));
	}
	private ResponseEntity<Object> execute(String action,JsonNode body,AuthenticatedUser actor,String key,Supplier<?> mutation) {
		var id=LegacyTaskMutationService.id(body);
		LegacyTaskMutationService.version(body);
		var result=idempotency.execute(actor.id(),"legacy.task."+action+"."+id,key,body,200,mutation);
		var response=ResponseEntity.status(result.status()); if(result.replayed()) response.header("Idempotency-Replayed","true");
		return response.body(result.body());
	}
}
