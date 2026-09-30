package ru.itmomegabattle.megabot.team;

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
@RequestMapping("/api/v1")
class TeamController {

	private final TeamService team;
	private final IdempotencyService idempotency;

	TeamController(TeamService team, IdempotencyService idempotency) {
		this.team = team;
		this.idempotency = idempotency;
	}

	@GetMapping("/team")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	List<UserView> team() {
		return team.listActive();
	}

	@GetMapping("/profile")
	UserView profile(@AuthenticationPrincipal AuthenticatedUser actor) {
		return team.profile(actor);
	}

	@PatchMapping("/profile")
	UserView updateProfile(@AuthenticationPrincipal AuthenticatedUser actor, @Valid @RequestBody UpdateProfileRequest request) {
		return team.updateOwn(actor, request);
	}

	@PostMapping("/users")
	@PreAuthorize("hasRole('ADMIN')")
	ResponseEntity<Object> create(
			@Valid @RequestBody CreateUserRequest request,
			@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String requestKey) {
		var result = idempotency.execute(actor.id(), "team.user.create", requestKey, request,
				HttpStatus.CREATED.value(), () -> team.create(request, actor));
		var response = ResponseEntity.status(result.status());
		if (result.replayed()) response.header("Idempotency-Replayed", "true");
		return response.body(result.body());
	}

	@PatchMapping("/users/{id}")
	@PreAuthorize("hasRole('ADMIN')")
	UserView update(@PathVariable String id, @Valid @RequestBody AdminUpdateUserRequest request) {
		return team.updateByAdmin(id, request);
	}

	@DeleteMapping("/users/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	@PreAuthorize("hasRole('ADMIN')")
	void deactivate(
			@PathVariable String id,
			@RequestParam @Min(0) long expectedVersion,
			@AuthenticationPrincipal AuthenticatedUser actor) {
		team.deactivate(id, expectedVersion, actor);
	}

	record CreateUserRequest(
			Long telegramId,
			@NotBlank @Size(max = 32) String username,
			@NotBlank @Size(max = 100) String realName,
			@NotBlank String role,
			Integer birthdayDay,
			Integer birthdayMonth,
			Integer birthdayYear) {
	}

	record UpdateProfileRequest(
			@NotBlank @Size(max = 100) String realName,
			@NotBlank @Size(max = 32) String username,
			Integer birthdayDay,
			Integer birthdayMonth,
			Integer birthdayYear,
			@Min(0) long expectedVersion) {
	}

	record AdminUpdateUserRequest(
			@NotBlank @Size(max = 100) String realName,
			@NotBlank @Size(max = 32) String username,
			@NotBlank String role,
			Integer birthdayDay,
			Integer birthdayMonth,
			Integer birthdayYear,
			Boolean active,
			@Min(0) long expectedVersion) {
	}

	record UserView(
			String id,
			String username,
			String realName,
			String role,
			boolean registered,
			boolean active,
			Integer birthdayDay,
			Integer birthdayMonth,
			Integer birthdayYear,
			long version,
			Instant deactivatedAt,
			List<String> competencyIds,
			String primaryCompetencyId,
			String facultyId,
			String facultyRole) {}
}
