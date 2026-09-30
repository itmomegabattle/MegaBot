package ru.itmomegabattle.megabot.tasks;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.IdempotencyService;

@RestController
@RequestMapping("/api/v1/tasks")
@PreAuthorize("isAuthenticated()")
class TaskController {
	private final TaskService tasks;
	private final IdempotencyService idempotency;
	TaskController(TaskService tasks, IdempotencyService idempotency) { this.tasks = tasks; this.idempotency = idempotency; }
	@GetMapping
	List<Map<String, Object>> list(@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestParam(defaultValue = "50") @Min(1) @Max(100) int limit, @RequestParam(required = false) String cursor) {
		return tasks.list(actor, limit, cursor);
	}
	@GetMapping("/{id}")
	Map<String, Object> get(@PathVariable String id, @AuthenticationPrincipal AuthenticatedUser actor) { return tasks.get(id, actor); }
	@GetMapping("/{id}/history")
	List<Map<String, Object>> history(@PathVariable String id, @AuthenticationPrincipal AuthenticatedUser actor,
			@RequestParam(defaultValue="50") int limit, @RequestParam(required=false) String cursor) {
		return tasks.history(id,actor,limit,cursor);
	}
	@PostMapping
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	ResponseEntity<Object> create(@Valid @RequestBody Mutation request, @AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(), "task.create", key, request, 201, () -> tasks.create(request, actor)));
	}
	@PatchMapping("/{id}")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	ResponseEntity<Object> update(@PathVariable String id, @Valid @RequestBody Mutation request,
			@AuthenticationPrincipal AuthenticatedUser actor, @RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(), "task.update." + id, key, request, 200, () -> tasks.update(id, request, actor)));
	}
	@PostMapping("/{id}/{action:claim|release|cancel}")
	ResponseEntity<Object> assignment(@PathVariable String id, @PathVariable String action, @Valid @RequestBody Version request,
			@AuthenticationPrincipal AuthenticatedUser actor, @RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(), "task." + action + "." + id, key, request, 200,
				() -> tasks.assignment(id, action, request.expectedVersion(), actor)));
	}
	@PostMapping("/{id}/status")
	ResponseEntity<Object> status(@PathVariable String id, @Valid @RequestBody Status request,
			@AuthenticationPrincipal AuthenticatedUser actor, @RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(), "task.status." + id, key, request, 200, () -> tasks.status(id, request, actor)));
	}
	@PostMapping("/{id}/comments")
	ResponseEntity<Object> comment(@PathVariable String id, @Valid @RequestBody Comment request,
			@AuthenticationPrincipal AuthenticatedUser actor, @RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(), "task.comment." + id, key, request, 201, () -> tasks.comment(id, request, actor)));
	}
	private ResponseEntity<Object> response(IdempotencyService.ReplayableResponse result) {
		var builder = ResponseEntity.status(result.status());
		if (result.replayed()) builder.header("Idempotency-Replayed", "true");
		return builder.body(result.body());
	}
	record Mutation(@NotBlank @Size(max=160) String title, @Size(max=4000) String description,
			@Size(max=8000) String sow, @NotBlank String priority, String eventId, String facultyId,
			LocalDate deadline, @Size(max=200) List<@NotBlank String> assigneeIds,
			@Size(max=100) List<@NotBlank String> competencyIds, @Min(0) Long expectedVersion) {}
	record Version(@NotNull @Min(0) Long expectedVersion) {}
	record Status(@NotBlank String status, @NotNull @Min(0) Long expectedVersion, @Min(1) @Max(60000) Integer timeSpentMinutes,
			@Size(max=4000) String completionComment) {}
	record Comment(@NotBlank String side, String targetAssigneeId, @NotBlank @Size(max=4000) String text,
			@NotNull @Min(0) Long expectedVersion) {}
}
