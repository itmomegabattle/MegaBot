package ru.itmomegabattle.megabot.events;

import java.time.Instant;
import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.IdempotencyService;
import org.springframework.http.ResponseEntity;

@RestController
@RequestMapping("/api/v1/events")
class WorkEventController {

	private final WorkEventService events;
	private final IdempotencyService idempotency;

	WorkEventController(WorkEventService events, IdempotencyService idempotency) {
		this.events = events;
		this.idempotency = idempotency;
	}

	@GetMapping
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	List<EventView> list() {
		return events.list();
	}

	@PostMapping
	@PreAuthorize("hasRole('ADMIN')")
	ResponseEntity<Object> create(
			@Valid @RequestBody EventMutation request,
			@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String requestKey) {
		var result = idempotency.execute(actor.id(), "work-event.create", requestKey, request,
				HttpStatus.CREATED.value(), () -> events.create(request, actor));
		var response = ResponseEntity.status(result.status());
		if (result.replayed()) response.header("Idempotency-Replayed", "true");
		return response.body(result.body());
	}

	@PatchMapping("/{id}")
	@PreAuthorize("hasRole('ADMIN')")
	EventView update(@PathVariable String id, @Valid @RequestBody EventMutation request) {
		return events.update(id, request);
	}

	@DeleteMapping("/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	@PreAuthorize("hasRole('ADMIN')")
	void archive(@PathVariable String id, @RequestParam @Min(0) long expectedVersion) {
		events.archive(id, expectedVersion);
	}

	record EventMutation(
			@NotBlank @Size(max = 120) String name,
			@Size(max = 4000) String description,
			Instant startsAt,
			Instant endsAt,
			@Min(0) long expectedVersion) {
	}

	record EventView(
			String id,
			String name,
			String description,
			Instant startsAt,
			Instant endsAt,
			String status,
			long version) {

		static EventView from(WorkEventEntity event) {
			return new EventView(event.id(), event.name(), event.description(), event.startsAt(), event.endsAt(),
					event.status(), event.version());
		}
	}
}
