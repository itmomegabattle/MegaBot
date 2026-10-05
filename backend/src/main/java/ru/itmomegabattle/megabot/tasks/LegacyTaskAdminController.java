package ru.itmomegabattle.megabot.tasks;

import java.util.List;
import java.util.Map;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.IdempotencyService;

@RestController
@RequestMapping("/api/task")
@PreAuthorize("hasRole('ADMIN')")
class LegacyTaskAdminController {
	private final LegacyTaskAdminService tasks;
	private final IdempotencyService idempotency;
	LegacyTaskAdminController(LegacyTaskAdminService tasks,IdempotencyService idempotency) { this.tasks=tasks; this.idempotency=idempotency; }
	@PostMapping("/{mode:archive|season-reset}/preview")
	Map<String,Object> preview(@PathVariable String mode) { return tasks.preview(mode); }
	@PostMapping("/archive/clear")
	ResponseEntity<Object> archive(@Valid @RequestBody Clear request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return clear("archive",request,actor,key);
	}
	@PostMapping("/season-reset")
	ResponseEntity<Object> reset(@Valid @RequestBody Clear request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return clear("season-reset",request,actor,key);
	}
	@PostMapping("/log/clear")
	void removed() {
		throw new ApiException(HttpStatus.GONE,"task_log_clear_disabled","Полная очистка журнала отключена. Используйте предпросмотр архива или сезонного сброса");
	}
	private ResponseEntity<Object> clear(String mode,Clear request,AuthenticatedUser actor,String key) {
		var result=idempotency.execute(actor.id(),"legacy.task.maintenance."+mode,key,request,200,()->tasks.clear(mode,request,actor));
		var response=ResponseEntity.status(result.status()); if(result.replayed()) response.header("Idempotency-Replayed","true");
		return response.body(result.body());
	}
	record Clear(@NotBlank @Pattern(regexp="[0-9a-f]{64}") String fingerprint,@Size(max=100) String confirmation,
			@Size(max=10000) List<@NotBlank @Size(max=200) String> taskIds) {}
}
