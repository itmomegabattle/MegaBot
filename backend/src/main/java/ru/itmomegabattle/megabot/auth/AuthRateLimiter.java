package ru.itmomegabattle.megabot.auth;

import java.time.Clock;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

@Component
class AuthRateLimiter {

	private final TelegramAuthProperties properties;
	private final Clock clock;
	private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

	AuthRateLimiter(TelegramAuthProperties properties, Clock clock) {
		this.properties = properties;
		this.clock = clock;
	}

	boolean allowIp(String address) {
		return allow("ip:" + address, properties.rateLimitPerIp());
	}

	boolean allowUser(long telegramId) {
		return allow("user:" + telegramId, properties.rateLimitPerUser());
	}

	private boolean allow(String key, int limit) {
		var now = clock.instant();
		var updated = windows.compute(key, (ignored, current) -> {
			if (current == null || !now.isBefore(current.startedAt().plus(properties.rateLimitWindow()))) {
				return new Window(now, 1);
			}
			return new Window(current.startedAt(), current.count() + 1);
		});
		return updated.count() <= limit;
	}

	private record Window(Instant startedAt, int count) {
	}
}
