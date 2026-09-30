package ru.itmomegabattle.megabot.auth;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/me")
class MeController {

	@GetMapping
	AuthenticatedUser me(@AuthenticationPrincipal AuthenticatedUser user) {
		return user;
	}
}
