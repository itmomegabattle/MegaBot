package ru.itmomegabattle.megabot.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

class SecurityFoundationTests {

	private static final Instant NOW = Instant.parse("2030-01-01T12:00:00Z");

	@AfterEach
	void clearSecurityContext() {
		SecurityContextHolder.clearContext();
	}

	@Test
	void rateLimitSeparatesIpAndTelegramUserWindows() {
		var properties = new TelegramAuthProperties(
				"token", "", Duration.ofMinutes(5), Duration.ofSeconds(30), Duration.ofDays(30),
				Duration.ofMinutes(5), 2, 1);
		var limiter = new AuthRateLimiter(properties, Clock.fixed(NOW, ZoneOffset.UTC));

		assertThat(limiter.allowIp("127.0.0.1")).isTrue();
		assertThat(limiter.allowIp("127.0.0.1")).isTrue();
		assertThat(limiter.allowIp("127.0.0.1")).isFalse();
		assertThat(limiter.allowUser(42)).isTrue();
		assertThat(limiter.allowUser(42)).isFalse();
		assertThat(limiter.allowUser(43)).isTrue();
	}

	@Test
	void authenticatedMutationRequiresSameOrExplicitlyAllowedOrigin() throws Exception {
		SecurityContextHolder.getContext().setAuthentication(new TestingAuthenticationToken("user", null, "ROLE_ADMIN"));
		var filter = new OriginProtectionFilter(new WebSecurityProperties("https://mini.example"));

		var missingOrigin = request("POST", null);
		var rejected = new MockHttpServletResponse();
		filter.doFilter(missingOrigin, rejected, new MockFilterChain());
		assertThat(rejected.getStatus()).isEqualTo(403);

		var sameOrigin = request("POST", "https://megaorgiabot.ru");
		var accepted = new MockHttpServletResponse();
		filter.doFilter(sameOrigin, accepted, new MockFilterChain());
		assertThat(accepted.getStatus()).isEqualTo(200);

		var configuredOrigin = request("DELETE", "https://mini.example");
		var configuredAccepted = new MockHttpServletResponse();
		filter.doFilter(configuredOrigin, configuredAccepted, new MockFilterChain());
		assertThat(configuredAccepted.getStatus()).isEqualTo(200);
	}

	@Test
	void sessionHashNeverContainsRawToken() {
		var token = "opaque-session-token";
		assertThat(SessionService.hash(token)).hasSize(64).doesNotContain(token);
	}

	private MockHttpServletRequest request(String method, String origin) {
		var request = new MockHttpServletRequest(method, "/api/v1/tasks");
		request.setScheme("https");
		request.setServerName("megaorgiabot.ru");
		request.setServerPort(443);
		if (origin != null) {
			request.addHeader("Origin", origin);
		}
		return request;
	}
}
