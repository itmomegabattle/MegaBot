package ru.itmomegabattle.megabot.auth;

import java.time.Duration;
import java.time.Clock;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;

@RestController
@RequestMapping("/api/v1/auth")
class AuthController {

	static final String SESSION_COOKIE = "megabot_session";

	private final TelegramInitDataVerifier verifier;
	private final TelegramAuthService authService;
	private final SessionService sessions;
	private final AuthRateLimiter rateLimiter;
	private final Clock clock;

	AuthController(
			TelegramInitDataVerifier verifier,
			TelegramAuthService authService,
			SessionService sessions,
			AuthRateLimiter rateLimiter,
			Clock clock) {
		this.verifier = verifier;
		this.authService = authService;
		this.sessions = sessions;
		this.rateLimiter = rateLimiter;
		this.clock = clock;
	}

	@PostMapping("/telegram")
	ResponseEntity<?> telegram(@Valid @RequestBody TelegramLoginRequest body, HttpServletRequest request) {
		if (!rateLimiter.allowIp(request.getRemoteAddr())) {
			return rateLimited();
		}
		var telegramUser = verifier.verify(body.initData())
				.orElseThrow(() -> new AuthenticationRejectedException("Некорректные или устаревшие данные Telegram"));
		if (!rateLimiter.allowUser(telegramUser.id())) {
			return rateLimited();
		}
		var result = authService.login(telegramUser);
		var maxAge = Duration.between(clock.instant(), result.session().expiresAt());
		var cookie = sessionCookie(result.session().rawToken(), maxAge.isNegative() ? Duration.ZERO : maxAge);
		return ResponseEntity.ok()
				.header(HttpHeaders.SET_COOKIE, cookie.toString())
				.body(new LoginResponse(result.user()));
	}

	@PostMapping("/logout")
	ResponseEntity<Void> logout(HttpServletRequest request) {
		sessions.revoke(CookieSupport.read(request, SESSION_COOKIE));
		return ResponseEntity.noContent()
				.header(HttpHeaders.SET_COOKIE, sessionCookie("", Duration.ZERO).toString())
				.build();
	}

	private ResponseEntity<ApiError> rateLimited() {
		return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
				.header(HttpHeaders.RETRY_AFTER, "300")
				.contentType(MediaType.APPLICATION_JSON)
				.body(new ApiError("rate_limited", "Слишком много попыток входа. Повторите позже."));
	}

	private ResponseCookie sessionCookie(String value, Duration maxAge) {
		return ResponseCookie.from(SESSION_COOKIE, value)
				.httpOnly(true)
				.secure(true)
				.sameSite("Lax")
				.path("/")
				.maxAge(maxAge)
				.build();
	}

	record TelegramLoginRequest(@NotBlank String initData) {
	}

	record LoginResponse(AuthenticatedUser user) {
	}

	record ApiError(String code, String message) {
	}
}
