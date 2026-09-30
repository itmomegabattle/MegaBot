package ru.itmomegabattle.megabot.team;

import java.time.Clock;
import java.time.Instant;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.itmomegabattle.megabot.auth.AuthenticatedUser;

@RestController
class FacultyProfileController {

	private final TeamService team;
	private final Clock clock;

	FacultyProfileController(TeamService team, Clock clock) {
		this.team = team;
		this.clock = clock;
	}

	@GetMapping({"/api/faculty/me", "/api/v1/faculty/me"})
	@PreAuthorize("hasAnyRole('FACULTY_RESPONSIBLE', 'FACULTY_HELPER')")
	FacultyProfile profile(@AuthenticationPrincipal AuthenticatedUser actor) {
		return new FacultyProfile(team.profile(actor), clock.instant(), "Europe/Moscow");
	}

	record FacultyProfile(TeamController.UserView user, Instant serverNow, String timeZone) {}
}
