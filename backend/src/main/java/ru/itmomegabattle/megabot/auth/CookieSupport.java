package ru.itmomegabattle.megabot.auth;

import jakarta.servlet.http.HttpServletRequest;

final class CookieSupport {

	private CookieSupport() {
	}

	static String read(HttpServletRequest request, String name) {
		if (request.getCookies() == null) {
			return null;
		}
		for (var cookie : request.getCookies()) {
			if (name.equals(cookie.getName())) {
				return cookie.getValue();
			}
		}
		return null;
	}
}
