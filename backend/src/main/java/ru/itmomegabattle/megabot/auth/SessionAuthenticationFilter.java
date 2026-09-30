package ru.itmomegabattle.megabot.auth;

import java.io.IOException;

import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

class SessionAuthenticationFilter extends OncePerRequestFilter {

	private final SessionService sessions;

	SessionAuthenticationFilter(SessionService sessions) {
		this.sessions = sessions;
	}

	@Override
	protected void doFilterInternal(
			HttpServletRequest request,
			HttpServletResponse response,
			FilterChain filterChain) throws ServletException, IOException {
		if (SecurityContextHolder.getContext().getAuthentication() == null) {
			sessions.authenticate(CookieSupport.read(request, AuthController.SESSION_COOKIE)).ifPresent(user -> {
				var authority = new SimpleGrantedAuthority("ROLE_" + user.role().toUpperCase());
				var authentication = new UsernamePasswordAuthenticationToken(user, null, java.util.List.of(authority));
				SecurityContextHolder.getContext().setAuthentication(authentication);
			});
		}
		filterChain.doFilter(request, response);
	}
}
