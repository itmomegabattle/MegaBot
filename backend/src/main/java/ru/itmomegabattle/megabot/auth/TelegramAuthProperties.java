package ru.itmomegabattle.megabot.auth;

import java.time.Duration;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "megabot.auth.telegram")
public record TelegramAuthProperties(
		String botToken,
		String adminTelegramIds,
		Duration maxAge,
		Duration futureSkew,
		Duration sessionTtl,
		Duration rateLimitWindow,
		int rateLimitPerIp,
		int rateLimitPerUser) {

	public boolean isBootstrapAdmin(long telegramId) {
		return parsedAdminIds().contains(telegramId);
	}

	private Set<Long> parsedAdminIds() {
		if (adminTelegramIds == null || adminTelegramIds.isBlank()) {
			return Set.of();
		}
		return Arrays.stream(adminTelegramIds.split(","))
				.map(String::trim)
				.filter(value -> !value.isEmpty())
				.map(Long::parseLong)
				.collect(Collectors.toUnmodifiableSet());
	}
}
