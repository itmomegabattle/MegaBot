package ru.itmomegabattle.megabot.auth;

import java.io.IOException;
import java.net.URI;
import java.util.Set;

import org.springframework.http.MediaType;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

class OriginProtectionFilter extends OncePerRequestFilter {

	private static final Set<String> MUTATION_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");

	private final Set<String> allowedOrigins;

	OriginProtectionFilter(WebSecurityProperties properties) {
		this.allowedOrigins = properties.parsedAllowedOrigins();
	}

	@Override
	protected void doFilterInternal(
			HttpServletRequest request,
			HttpServletResponse response,
			FilterChain filterChain) throws ServletException, IOException {
		var authentication = SecurityContextHolder.getContext().getAuthentication();
		if (authentication != null && authentication.isAuthenticated()
				&& !(authentication instanceof AnonymousAuthenticationToken)
				&& MUTATION_METHODS.contains(request.getMethod())) {
			var origin = normalizedOrigin(request.getHeader("Origin"));
			var requestOrigin = request.getScheme().toLowerCase() + "://" + request.getServerName().toLowerCase()
					+ (isDefaultPort(request) ? "" : ":" + request.getServerPort());
			if (origin == null || (!origin.equals(requestOrigin) && !allowedOrigins.contains(origin))) {
				response.setStatus(HttpServletResponse.SC_FORBIDDEN);
				response.setContentType(MediaType.APPLICATION_JSON_VALUE);
				response.getWriter().write("{\"code\":\"invalid_origin\",\"message\":\"Неверный источник запроса\"}");
				return;
			}
		}
		filterChain.doFilter(request, response);
	}

	private String normalizedOrigin(String value) {
		if (value == null || value.isBlank()) {
			return null;
		}
		try {
			var uri = URI.create(value);
			if (uri.getScheme() == null || uri.getRawAuthority() == null || uri.getRawPath() != null && !uri.getRawPath().isEmpty()
					|| uri.getRawQuery() != null || uri.getRawFragment() != null) {
				return null;
			}
			return uri.getScheme().toLowerCase() + "://" + uri.getRawAuthority().toLowerCase();
		} catch (IllegalArgumentException exception) {
			return null;
		}
	}

	private boolean isDefaultPort(HttpServletRequest request) {
		return ("http".equals(request.getScheme()) && request.getServerPort() == 80)
				|| ("https".equals(request.getScheme()) && request.getServerPort() == 443);
	}
}
