package ru.itmomegabattle.megabot.team;

import java.util.Locale;

import ru.itmomegabattle.megabot.common.ApiException;

import org.springframework.http.HttpStatus;

public enum TeamRole {
	ADMIN("admin"),
	ORGANIZER("organizer"),
	FACULTY_RESPONSIBLE("faculty_responsible"),
	FACULTY_HELPER("faculty_helper");

	private final String value;

	TeamRole(String value) {
		this.value = value;
	}

	public String value() {
		return value;
	}

	public boolean isCore() {
		return this == ADMIN || this == ORGANIZER;
	}

	public static TeamRole parse(String raw) {
		if (raw != null) {
			for (var role : values()) {
				if (role.value.equals(raw.toLowerCase(Locale.ROOT))) {
					return role;
				}
			}
		}
		throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_role", "Неизвестная роль");
	}
}
