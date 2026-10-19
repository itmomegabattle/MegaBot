package ru.itmomegabattle.megabot.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;

class SessionAuthenticationFilterTests {
    final SessionService sessions = mock(SessionService.class);
    final SessionAuthenticationFilter filter = new SessionAuthenticationFilter(sessions);

    @AfterEach void clearContext() { SecurityContextHolder.clearContext(); }

    void request(String path, String token) throws Exception {
        var request = new MockHttpServletRequest("GET", path);
        request.setServletPath(path);
        if (token != null) request.setCookies(new Cookie(AuthController.SESSION_COOKIE, token));
        var continued = new AtomicBoolean();
        filter.doFilter(request, new MockHttpServletResponse(), (req, response) -> continued.set(true));
        assertThat(continued).isTrue();
    }

    @Test void absentAndBlankCookiesDoNotOpenDatabaseTransactions() throws Exception {
        request("/api/v1/me", null);
        request("/api/v1/me", "");
        verifyNoInteractions(sessions);
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }

    @Test void publicHealthIgnoresCookiesEvenWhenSessionDatabaseIsUnavailable() throws Exception {
        when(sessions.authenticate(anyString())).thenThrow(new IllegalStateException("database unavailable"));
        for (var path : new String[]{"/actuator/health", "/actuator/health/liveness", "/actuator/health/readiness"})
            request(path, "stale-session");
        verifyNoInteractions(sessions);
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }

    @Test void healthPrefixLookalikesAndProtectedEndpointsStillAuthenticateCookies() throws Exception {
        when(sessions.authenticate("token")).thenReturn(Optional.empty());
        request("/actuator/health-other", "token");
        request("/api/v1/me", "token");
        verify(sessions, times(2)).authenticate("token");
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }

    @Test void protectedRequestKeepsTheResolvedPrincipalAndRole() throws Exception {
        var member = new AuthenticatedUser("u_member", "member", "Member", "organizer");
        when(sessions.authenticate("token")).thenReturn(Optional.of(member));
        request("/api/v1/me", "token");
        var authentication = SecurityContextHolder.getContext().getAuthentication();
        assertThat(authentication.getPrincipal()).isEqualTo(member);
        assertThat(authentication.getAuthorities()).extracting("authority").containsExactly("ROLE_ORGANIZER");
        verify(sessions).authenticate("token");
    }
}
