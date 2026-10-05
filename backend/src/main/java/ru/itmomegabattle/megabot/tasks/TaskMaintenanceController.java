package ru.itmomegabattle.megabot.tasks;

import java.util.Map;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.IdempotencyService;

@RestController
@RequestMapping("/api/v1/tasks")
@PreAuthorize("hasRole('ADMIN')")
class TaskMaintenanceController {
	private final TaskMaintenanceService tasks;
	private final IdempotencyService idempotency;
	TaskMaintenanceController(TaskMaintenanceService tasks,IdempotencyService idempotency) { this.tasks=tasks; this.idempotency=idempotency; }
	@GetMapping("/{mode:archive|season-reset}/preview")
	Map<String,Object> preview(@PathVariable String mode) { return tasks.preview(mode); }
	@PostMapping("/archive/clear")
	ResponseEntity<Object> archive(@Valid @RequestBody Clear request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return clear("archive",request,actor,key);
	}
	@PostMapping("/season-reset")
	ResponseEntity<Object> reset(@Valid @RequestBody Clear request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return clear("season-reset",request,actor,key);
	}
	@GetMapping("/recovery/{id}")
	Map<String,Object> recovery(@PathVariable String id) { return tasks.recovery(id); }
	@PostMapping("/recovery/{id}/restore")
	ResponseEntity<Object> restore(@PathVariable String id,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(),"task.restore."+id,key,Map.of("id",id),200,()->tasks.restore(id,actor)));
	}
	private ResponseEntity<Object> clear(String mode,Clear request,AuthenticatedUser actor,String key) {
		return response(idempotency.execute(actor.id(),"task.maintenance."+mode,key,request,200,()->tasks.clear(mode,request,actor)));
	}
	private ResponseEntity<Object> response(IdempotencyService.ReplayableResponse result) {
		var response=ResponseEntity.status(result.status());
		if(result.replayed()) response.header("Idempotency-Replayed","true");
		return response.body(result.body());
	}
	record Clear(@NotBlank @Pattern(regexp="[0-9a-f]{64}") String fingerprint,@Size(max=100) String confirmation) {}
}
