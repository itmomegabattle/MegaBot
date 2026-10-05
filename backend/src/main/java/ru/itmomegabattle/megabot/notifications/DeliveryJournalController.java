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
@RequestMapping("/api/v1/broadcasts/{broadcastId}/deliveries")
@PreAuthorize("hasAnyRole('ADMIN','ORGANIZER')")
class DeliveryJournalController {
	private final DeliveryJournalService journal;private final IdempotencyService idempotency;
	DeliveryJournalController(DeliveryJournalService journal,IdempotencyService idempotency) { this.journal=journal;this.idempotency=idempotency; }
	@GetMapping Map<String,Object> list(@PathVariable String broadcastId,@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestParam(defaultValue="50") int limit,@RequestParam(required=false) String cursor) { return journal.list(broadcastId,actor,limit,cursor); }
	@PostMapping("/{deliveryId}/retry") ResponseEntity<Object> retry(@PathVariable String broadcastId,@PathVariable String deliveryId,
			@Valid @RequestBody Retry request,@AuthenticationPrincipal AuthenticatedUser actor,@RequestHeader("Idempotency-Key") String key) {
		journal.authorize(broadcastId,actor); // Replayed replies must still obey current owner/admin access.
		var result=idempotency.execute(actor.id(),"broadcast.retry."+broadcastId+"."+deliveryId,key,request,201,()->journal.retry(broadcastId,deliveryId,request,actor));
		var response=ResponseEntity.status(result.status());if(result.replayed())response.header("Idempotency-Replayed","true");return response.body(result.body());
	}
	record Retry(@NotNull @Min(0) Long expectedVersion,@NotNull @AssertTrue Boolean acknowledgeDuplicateRisk) {}
}
