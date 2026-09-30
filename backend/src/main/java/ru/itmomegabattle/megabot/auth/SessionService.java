package ru.itmomegabattle.megabot.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.itmomegabattle.megabot.team.UserRepository;

@Service
public class SessionService {

	private final SessionRepository sessions;
	private final UserRepository users;
	private final TelegramAuthProperties properties;
	private final Clock clock;
	private final SecureRandom secureRandom = new SecureRandom();

	SessionService(
			SessionRepository sessions,
			UserRepository users,
			TelegramAuthProperties properties,
			Clock clock) {
		this.sessions = sessions;
		this.users = users;
		this.properties = properties;
		this.clock = clock;
	}

	@Transactional
	public CreatedSession rotateFor(String userId) {
		var now = clock.instant();
		sessions.revokeActiveByUserId(userId, now);
		var rawToken = generateToken();
		var expiresAt = now.plus(properties.sessionTtl());
		sessions.save(new SessionEntity(hash(rawToken), userId, expiresAt, now));
		return new CreatedSession(rawToken, expiresAt);
	}

	@Transactional(readOnly = true)
	public Optional<AuthenticatedUser> authenticate(String rawToken) {
		if (rawToken == null || rawToken.isBlank()) {
			return Optional.empty();
		}
		return sessions.findByTokenHashAndRevokedAtIsNullAndExpiresAtAfter(hash(rawToken), clock.instant())
				.flatMap(session -> users.findById(session.userId()))
				.filter(user -> user.isActive() && user.isRegistered())
				.map(user -> new AuthenticatedUser(user.getId(), user.getUsername(), user.getRealName(), user.getRole()));
	}

	@Transactional
	public void revoke(String rawToken) {
		if (rawToken != null && !rawToken.isBlank()) {
			sessions.revokeByTokenHash(hash(rawToken), clock.instant());
		}
	}

	@Transactional
	public void revokeAllFor(String userId) {
		sessions.revokeActiveByUserId(userId, clock.instant());
	}

	private String generateToken() {
		var bytes = new byte[32];
		secureRandom.nextBytes(bytes);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
	}

	public static String hash(String rawToken) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
					.digest(rawToken.getBytes(StandardCharsets.UTF_8)));
		} catch (NoSuchAlgorithmException impossible) {
			throw new IllegalStateException("SHA-256 is unavailable", impossible);
		}
	}

	public record CreatedSession(String rawToken, java.time.Instant expiresAt) {
	}
}
