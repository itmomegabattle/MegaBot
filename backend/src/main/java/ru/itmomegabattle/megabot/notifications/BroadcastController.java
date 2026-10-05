package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
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
@RequestMapping("/api/v1/broadcasts")
@PreAuthorize("hasAnyRole('ADMIN','ORGANIZER')")
class BroadcastController {
	private final BroadcastService broadcasts;
	private final IdempotencyService idempotency;
	BroadcastController(BroadcastService broadcasts,IdempotencyService idempotency) { this.broadcasts=broadcasts;this.idempotency=idempotency; }
	@PostMapping
	ResponseEntity<Object> create(@Valid @RequestBody Mutation request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(),"broadcast.create",key,request,201,()->broadcasts.create(request,actor)));
	}
	@GetMapping
	Map<String,Object> list(@AuthenticationPrincipal AuthenticatedUser actor,@RequestParam(defaultValue="50") int limit,@RequestParam(required=false) String cursor) { return broadcasts.list(actor,limit,cursor); }
	@GetMapping("/{id}")
	Map<String,Object> get(@PathVariable String id,@AuthenticationPrincipal AuthenticatedUser actor) { return broadcasts.get(id,actor); }
	@PatchMapping("/{id}")
	ResponseEntity<Object> update(@PathVariable String id,@Valid @RequestBody Mutation request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(),"broadcast.update."+id,key,request,200,()->broadcasts.update(id,request,actor)));
	}
	@PostMapping("/{id}/cancel")
	ResponseEntity<Object> cancel(@PathVariable String id,@Valid @RequestBody Version request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		return response(idempotency.execute(actor.id(),"broadcast.cancel."+id,key,request,200,()->broadcasts.cancel(id,request.expectedVersion(),actor)));
	}
	@PostMapping("/{id}/reschedule")
	ResponseEntity<Object> reschedule(@PathVariable String id,@Valid @RequestBody Reschedule request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		broadcasts.accessible(id,actor,false);
		return response(idempotency.execute(actor.id(),"broadcast.reschedule."+id,key,request,200,()->broadcasts.reschedule(id,request,actor)));
	}
	private ResponseEntity<Object> response(IdempotencyService.ReplayableResponse result) {
		var r=ResponseEntity.status(result.status());if(result.replayed())r.header("Idempotency-Replayed","true");return r.body(result.body());
	}
	record Mutation(@Size(max=120) String title,@NotBlank @Size(max=40000) String body,
			String recipientMode,@Size(max=2000) List<@NotBlank String> recipientIds,
			@Size(max=100) List<@NotBlank String> competencyIds,LocalDate weekStart,
			String dispatchMode,Instant scheduledAt,String zoneId,String misfirePolicy,Boolean silent,@Min(0) Long expectedVersion,
			@Size(max=100) List<@NotBlank String> groupTargetIds) {
		Mutation(String title,String body,String recipientMode,List<String> recipientIds,List<String> competencyIds,LocalDate weekStart,
				String dispatchMode,Instant scheduledAt,String zoneId,String misfirePolicy,Boolean silent,Long expectedVersion) {
			this(title,body,recipientMode,recipientIds,competencyIds,weekStart,dispatchMode,scheduledAt,zoneId,misfirePolicy,silent,expectedVersion,null);
		}
	}
	record Version(@NotNull @Min(0) Long expectedVersion) {}
	record Reschedule(@NotNull @Min(0) Long expectedVersion,@NotNull Instant scheduledAt) {}
}
