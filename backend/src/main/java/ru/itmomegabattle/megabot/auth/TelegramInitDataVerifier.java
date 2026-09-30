package ru.itmomegabattle.megabot.auth;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.stereotype.Component;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Component
public class TelegramInitDataVerifier {

	private static final String HMAC_ALGORITHM = "HmacSHA256";

	private final TelegramAuthProperties properties;
	private final Clock clock;
	private final ObjectMapper objectMapper;

	public TelegramInitDataVerifier(TelegramAuthProperties properties, Clock clock, ObjectMapper objectMapper) {
		this.properties = properties;
		this.clock = clock;
		this.objectMapper = objectMapper;
	}

	public Optional<VerifiedTelegramUser> verify(String initData) {
		if (initData == null || initData.isBlank() || properties.botToken() == null || properties.botToken().isBlank()) {
			return Optional.empty();
		}
		try {
			var parameters = parseUniqueParameters(initData);
			var receivedHash = parameters.remove("hash");
			if (receivedHash == null || !receivedHash.matches("(?i)[0-9a-f]{64}")) {
				return Optional.empty();
			}
			var dataCheckString = parameters.entrySet().stream()
					.sorted(Map.Entry.comparingByKey())
					.map(entry -> entry.getKey() + "=" + entry.getValue())
					.collect(Collectors.joining("\n"));
			var calculatedHash = calculateHash(properties.botToken(), dataCheckString);
			if (!MessageDigest.isEqual(HexFormat.of().parseHex(receivedHash), calculatedHash)) {
				return Optional.empty();
			}
			var authDate = parseAuthDate(parameters.get("auth_date"));
			if (authDate == null || !isFresh(authDate)) {
				return Optional.empty();
			}
			return parseUser(parameters.get("user"));
		} catch (IllegalArgumentException | GeneralSecurityException exception) {
			return Optional.empty();
		}
	}

	private Map<String, String> parseUniqueParameters(String initData) {
		var result = new LinkedHashMap<String, String>();
		for (var pair : initData.split("&", -1)) {
			var separator = pair.indexOf('=');
			if (separator <= 0) {
				throw new IllegalArgumentException("Malformed initData");
			}
			var key = URLDecoder.decode(pair.substring(0, separator), StandardCharsets.UTF_8);
			var value = URLDecoder.decode(pair.substring(separator + 1), StandardCharsets.UTF_8);
			if (key.isBlank() || result.putIfAbsent(key, value) != null) {
				throw new IllegalArgumentException("Duplicate initData parameter");
			}
		}
		return result;
	}

	private byte[] calculateHash(String botToken, String dataCheckString) throws GeneralSecurityException {
		var secretMac = Mac.getInstance(HMAC_ALGORITHM);
		secretMac.init(new SecretKeySpec("WebAppData".getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM));
		var secretKey = secretMac.doFinal(botToken.getBytes(StandardCharsets.UTF_8));

		var dataMac = Mac.getInstance(HMAC_ALGORITHM);
		dataMac.init(new SecretKeySpec(secretKey, HMAC_ALGORITHM));
		return dataMac.doFinal(dataCheckString.getBytes(StandardCharsets.UTF_8));
	}

	private Instant parseAuthDate(String value) {
		if (value == null || !value.matches("[1-9][0-9]*")) {
			return null;
		}
		try {
			return Instant.ofEpochSecond(Long.parseLong(value));
		} catch (RuntimeException exception) {
			return null;
		}
	}

	private boolean isFresh(Instant authDate) {
		var now = clock.instant();
		return !authDate.isBefore(now.minus(properties.maxAge()))
				&& !authDate.isAfter(now.plus(properties.futureSkew()));
	}

	private Optional<VerifiedTelegramUser> parseUser(String rawUser) {
		if (rawUser == null) {
			return Optional.empty();
		}
		try {
			JsonNode user = objectMapper.readTree(rawUser);
			var id = user == null ? null : user.get("id");
			if (user == null || !user.isObject() || id == null || !id.isIntegralNumber() || !id.canConvertToLong()) {
				return Optional.empty();
			}
			var telegramId = id.longValue();
			if (telegramId <= 0) {
				return Optional.empty();
			}
			return Optional.of(new VerifiedTelegramUser(
					telegramId,
					optionalText(user, "username"),
					optionalText(user, "first_name"),
					optionalText(user, "last_name")));
		} catch (RuntimeException exception) {
			return Optional.empty();
		}
	}

	private String optionalText(JsonNode object, String field) {
		var node = object.get(field);
		if (node == null) {
			return null;
		}
		if (!node.isTextual()) {
			throw new IllegalArgumentException("Invalid Telegram user field");
		}
		var value = node.textValue().trim();
		return value.isEmpty() ? null : value;
	}
}
