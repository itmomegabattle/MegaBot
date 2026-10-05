package ru.itmomegabattle.megabot.notifications;

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
class BroadcastGroupTargetsController {
	private final BroadcastGroupTargets targets; private final IdempotencyService idempotency;
	BroadcastGroupTargetsController(BroadcastGroupTargets targets,IdempotencyService idempotency) { this.targets=targets;this.idempotency=idempotency; }
	@GetMapping("/api/v1/broadcast-group-targets") @PreAuthorize("hasAnyRole('ADMIN','ORGANIZER')")
	Map<String,Object> available(@RequestParam(defaultValue="50") int limit,@RequestParam(required=false) String cursor) { return targets.list(false,limit,cursor); }
	@GetMapping("/api/v1/admin/broadcast-group-targets") @PreAuthorize("hasRole('ADMIN')")
	Map<String,Object> all(@RequestParam(defaultValue="50") int limit,@RequestParam(required=false) String cursor) { return targets.list(true,limit,cursor); }
	@PostMapping("/api/v1/admin/broadcast-group-targets") @PreAuthorize("hasRole('ADMIN')")
	ResponseEntity<Object> create(@Valid @RequestBody Mutation request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(),"broadcast.group.create",key,request,201,()->targets.save(null,request,actor)));
	}
	@PatchMapping("/api/v1/admin/broadcast-group-targets/{id}") @PreAuthorize("hasRole('ADMIN')")
	ResponseEntity<Object> update(@PathVariable String id,@Valid @RequestBody Mutation request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(),"broadcast.group.update."+id,key,request,200,()->targets.save(id,request,actor)));
	}
	private ResponseEntity<Object> response(IdempotencyService.ReplayableResponse result) {
		var response=ResponseEntity.status(result.status());if(result.replayed())response.header("Idempotency-Replayed","true");return response.body(result.body());
	}
	record Mutation(@NotBlank @Size(max=120) String label,@NotBlank @Pattern(regexp="[0-9]{1,20}") String botId,
			@NotNull @Max(-1) Long chatId,@Positive Long messageThreadId,@NotNull Boolean active,@Min(0) Long expectedVersion) {}
}
