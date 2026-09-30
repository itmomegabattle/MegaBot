package ru.itmomegabattle.megabot.team;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.IdempotencyService;

@RestController
@RequestMapping("/api/v1")
class CatalogController {

	private final CatalogService catalogs;
	private final IdempotencyService idempotency;

	CatalogController(CatalogService catalogs, IdempotencyService idempotency) {
		this.catalogs = catalogs;
		this.idempotency = idempotency;
	}

	@GetMapping("/catalogs")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	CatalogView get() { return catalogs.get(); }

	@PostMapping("/competencies")
	@PreAuthorize("hasRole('ADMIN')")
	ResponseEntity<Object> createCompetency(
			@Valid @RequestBody CreateCompetency request,
			@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String requestKey) {
		return created(idempotency.execute(actor.id(), "competency.create", requestKey, request,
				HttpStatus.CREATED.value(), () -> catalogs.createCompetency(request, actor)));
	}

	@PatchMapping("/competencies/{id}")
	@PreAuthorize("hasRole('ADMIN')")
	CompetencyView updateCompetency(@PathVariable String id, @Valid @RequestBody UpdateName request) {
		return catalogs.updateCompetency(id, request);
	}

	@DeleteMapping("/competencies/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	@PreAuthorize("hasRole('ADMIN')")
	void retireCompetency(@PathVariable String id, @RequestParam @Min(0) long expectedVersion) {
		catalogs.retireCompetency(id, expectedVersion);
	}

	@PostMapping("/faculties")
	@PreAuthorize("hasRole('ADMIN')")
	ResponseEntity<Object> createFaculty(
			@Valid @RequestBody CreateFaculty request,
			@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestHeader("Idempotency-Key") String requestKey) {
		return created(idempotency.execute(actor.id(), "faculty.create", requestKey, request,
				HttpStatus.CREATED.value(), () -> catalogs.createFaculty(request, actor)));
	}

	@PatchMapping("/faculties/{id}")
	@PreAuthorize("hasRole('ADMIN')")
	FacultyView updateFaculty(@PathVariable String id, @Valid @RequestBody UpdateName request) {
		return catalogs.updateFaculty(id, request);
	}

	@DeleteMapping("/faculties/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	@PreAuthorize("hasRole('ADMIN')")
	void retireFaculty(@PathVariable String id, @RequestParam @Min(0) long expectedVersion) {
		catalogs.retireFaculty(id, expectedVersion);
	}

	@PutMapping("/faculties/{facultyId}/members/{userId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	@PreAuthorize("hasRole('ADMIN')")
	void membership(@PathVariable String facultyId, @PathVariable String userId, @Valid @RequestBody MembershipMutation request) {
		catalogs.setMembership(facultyId, userId, request);
	}

	@DeleteMapping("/faculties/{facultyId}/members/{userId}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	@PreAuthorize("hasRole('ADMIN')")
	void removeMembership(@PathVariable String facultyId, @PathVariable String userId) {
		catalogs.removeMembership(facultyId, userId);
	}

	@PutMapping("/users/{userId}/competencies")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	@PreAuthorize("hasRole('ADMIN')")
	void competencies(@PathVariable String userId, @Valid @RequestBody UserCompetenciesMutation request) {
		catalogs.setUserCompetencies(userId, request);
	}

	private ResponseEntity<Object> created(IdempotencyService.ReplayableResponse result) {
		var response = ResponseEntity.status(result.status());
		if (result.replayed()) response.header("Idempotency-Replayed", "true");
		return response.body(result.body());
	}

	record CatalogView(List<CompetencyView> competencies, List<FacultyView> faculties) {}
	record CompetencyView(String id, String name, String scope, boolean active, long version) {}
	record FacultyView(String id, String name, boolean active, long version) {}
	record CreateCompetency(@NotBlank @Size(max = 120) String name, @NotBlank String scope) {}
	record CreateFaculty(@NotBlank @Size(max = 120) String name) {}
	record UpdateName(@NotBlank @Size(max = 120) String name, @Min(0) long expectedVersion) {}
	record MembershipMutation(@NotBlank String facultyRole) {}
	record UserCompetenciesMutation(
			@NotNull @Size(max = 50) List<@NotBlank String> competencyIds,
			String primaryCompetencyId) {}
}
