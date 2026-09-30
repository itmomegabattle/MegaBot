package ru.itmomegabattle.megabot.meetings;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.IdempotencyService;

@RestController
@RequestMapping("/api/v1/meetings")
class MeetingController {

	private final MeetingService meetings;
	private final IdempotencyService idempotency;

	MeetingController(MeetingService meetings, IdempotencyService idempotency) {
		this.meetings = meetings;
		this.idempotency = idempotency;
	}

	@GetMapping
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	List<MeetingView> list() { return meetings.list(); }

	@PostMapping
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	ResponseEntity<Object> create(
			@Valid @RequestBody MeetingMutation request,
			@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String requestKey) {
		var result = idempotency.execute(actor.id(), "meeting.create", requestKey, request, HttpStatus.CREATED.value(),
				() -> meetings.create(request, actor));
		return response(result);
	}

	@PatchMapping("/{id}")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	ResponseEntity<Object> update(
			@PathVariable String id,
			@Valid @RequestBody MeetingMutation request,
			@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String requestKey) {
		var result = idempotency.execute(actor.id(), "meeting.update." + id, requestKey, request, HttpStatus.OK.value(),
				() -> meetings.update(id, request, actor));
		return response(result);
	}

	@PostMapping("/{id}/cancel")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	ResponseEntity<Object> cancel(
			@PathVariable String id,
			@Valid @RequestBody VersionRequest request,
			@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String requestKey) {
		var result = idempotency.execute(actor.id(), "meeting.cancel." + id, requestKey, request, HttpStatus.OK.value(),
				() -> meetings.cancel(id, request.expectedVersion(), actor));
		return response(result);
	}

	@PostMapping("/{id}/rsvp")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	RsvpView rsvp(@PathVariable String id, @Valid @RequestBody RsvpRequest request,
			@AuthenticationPrincipal AuthenticatedUser actor) {
		return meetings.rsvp(id, request.response(), actor);
	}

	private ResponseEntity<Object> response(IdempotencyService.ReplayableResponse result) {
		var response = ResponseEntity.status(result.status());
		if (result.replayed()) response.header("Idempotency-Replayed", "true");
		return response.body(result.body());
	}

	record MeetingMutation(
			@NotBlank @Size(max = 160) String title,
			@NotBlank String kind,
			String eventId,
			@NotNull LocalDate date,
			@NotNull LocalTime time,
			int durationMinutes,
			String audienceMode,
			String competencyId,
			@Size(max = 200) List<String> selectedUserIds,
			@Size(max = 500) String topic,
			@Size(max = 4000) String description,
			@Min(0) long expectedVersion) {}
	record VersionRequest(@Min(0) long expectedVersion) {}
	record RsvpRequest(@NotBlank String response) {}
	record InvitationView(String userId, String response, Instant respondedAt) {}
	record MeetingView(String id, String kind, String title, String eventId, Instant startsAt, Instant endsAt,
			int durationMinutes, String zoneId, String hostId, String audienceMode, String competencyId,
			String topic, String description, String status, long version, String phase,
			List<InvitationView> invitations) {}
	record RsvpView(String meetingId, String response, boolean changed) {}
}
