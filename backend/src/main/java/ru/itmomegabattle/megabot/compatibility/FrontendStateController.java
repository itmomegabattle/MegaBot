package ru.itmomegabattle.megabot.compatibility;

import java.util.Map;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.itmomegabattle.megabot.auth.AuthenticatedUser;

@RestController
class FrontendStateController {

	private final FrontendStateService state;

	FrontendStateController(FrontendStateService state) {
		this.state = state;
	}

	@GetMapping("/api/state")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	Map<String, Object> state(@AuthenticationPrincipal AuthenticatedUser viewer) {
		return state.state(viewer);
	}
}
