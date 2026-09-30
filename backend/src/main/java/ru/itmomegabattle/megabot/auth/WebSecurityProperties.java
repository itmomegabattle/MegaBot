package ru.itmomegabattle.megabot.auth;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "megabot.security")
record WebSecurityProperties(String allowedOrigins) {

	Set<String> parsedAllowedOrigins() {
		if (allowedOrigins == null || allowedOrigins.isBlank()) {
			return Set.of();
		}
		return Arrays.stream(allowedOrigins.split(","))
				.map(String::trim)
				.filter(value -> !value.isEmpty())
				.collect(Collectors.toUnmodifiableSet());
	}
}
