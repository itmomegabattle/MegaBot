package ru.itmomegabattle.megabot.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.ObjectMapper;

class TelegramInitDataVerifierTests {

	private static final String TOKEN = "123456:test-token";
	private static final Instant NOW = Instant.parse("2030-01-01T12:00:00Z");
	private final TelegramAuthProperties properties = new TelegramAuthProperties(
			TOKEN, "42", Duration.ofMinutes(5), Duration.ofSeconds(30), Duration.ofDays(30),
			Duration.ofMinutes(5), 30, 10);
	private final TelegramInitDataVerifier verifier = new TelegramInitDataVerifier(
			properties, Clock.fixed(NOW, ZoneOffset.UTC), new ObjectMapper());

	@Test
	void acceptsSignedUserAtTtlBoundary() {
		var initData = signed(Map.of(
				"auth_date", String.valueOf(NOW.minus(Duration.ofMinutes(5)).getEpochSecond()),
				"query_id", "synthetic",
				"user", "{\"id\":42,\"username\":\"alice\",\"first_name\":\"Alice\"}"));

		var user = verifier.verify(initData).orElseThrow();

		assertThat(user.id()).isEqualTo(42L);
		assertThat(user.username()).isEqualTo("alice");
		assertThat(user.displayName()).isEqualTo("Alice");
	}

	@Test
	void rejectsTamperingDuplicateKeysAndInvalidUserFields() {
		var valid = validInitData("{\"id\":42,\"username\":\"alice\"}");
		assertThat(verifier.verify(valid.replace("alice", "mallory"))).isEmpty();
		assertThat(verifier.verify(valid + "&auth_date=" + NOW.getEpochSecond())).isEmpty();
		assertThat(verifier.verify(validInitData("{\"id\":42,\"username\":7}"))).isEmpty();
	}

	@Test
	void rejectsStaleFutureAndMissingAuthDate() {
		assertThat(verifier.verify(signed(Map.of(
				"auth_date", String.valueOf(NOW.minus(Duration.ofMinutes(5)).minusSeconds(1).getEpochSecond()),
				"user", "{\"id\":42}")))).isEmpty();
		assertThat(verifier.verify(signed(Map.of(
				"auth_date", String.valueOf(NOW.plusSeconds(31).getEpochSecond()),
				"user", "{\"id\":42}")))).isEmpty();
		assertThat(verifier.verify(signed(Map.of("user", "{\"id\":42}")))).isEmpty();
	}

	private String validInitData(String userJson) {
		return signed(Map.of(
				"auth_date", String.valueOf(NOW.getEpochSecond()),
				"user", userJson));
	}

	private String signed(Map<String, String> source) {
		try {
			var parameters = new LinkedHashMap<>(source);
			var dataCheckString = parameters.entrySet().stream()
					.sorted(Map.Entry.comparingByKey())
					.map(entry -> entry.getKey() + "=" + entry.getValue())
					.collect(Collectors.joining("\n"));
			var secretMac = Mac.getInstance("HmacSHA256");
			secretMac.init(new SecretKeySpec("WebAppData".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
			var secret = secretMac.doFinal(TOKEN.getBytes(StandardCharsets.UTF_8));
			var dataMac = Mac.getInstance("HmacSHA256");
			dataMac.init(new SecretKeySpec(secret, "HmacSHA256"));
			parameters.put("hash", HexFormat.of().formatHex(dataMac.doFinal(dataCheckString.getBytes(StandardCharsets.UTF_8))));
			return parameters.entrySet().stream()
					.map(entry -> URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8) + "="
							+ URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8))
					.collect(Collectors.joining("&"));
		} catch (Exception exception) {
			throw new IllegalStateException(exception);
		}
	}
}
