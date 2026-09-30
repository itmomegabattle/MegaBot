package ru.itmomegabattle.megabot.common;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;
import java.util.function.Supplier;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
public class IdempotencyService {

	private static final Duration RETENTION = Duration.ofHours(24);

	private final JdbcClient jdbc;
	private final ObjectMapper json;
	private final Clock clock;

	IdempotencyService(JdbcClient jdbc, ObjectMapper json, Clock clock) {
		this.jdbc = jdbc;
		this.json = json;
		this.clock = clock;
	}

	@Transactional
	public ReplayableResponse execute(
			String actorId,
			String operation,
			String requestKey,
			Object request,
			int successCode,
			Supplier<?> mutation) {
		validateKey(requestKey);
		var requestHash = hash(encode(request));
		var lockKey = actorId + "\n" + operation + "\n" + requestKey;
		jdbc.sql("select pg_advisory_xact_lock(hashtextextended(:lockKey, 0))").param("lockKey", lockKey).query().singleValue();
		var existing = jdbc.sql("""
				select request_hash, status, result_code, result_body::text as result_body
				from idempotency_requests
				where actor_id = :actorId and operation = :operation and request_key = :requestKey
				for update
				""").param("actorId", actorId).param("operation", operation).param("requestKey", requestKey)
				.query((row, index) -> new StoredRequest(row.getString("request_hash"), row.getString("status"),
						(Integer) row.getObject("result_code"), row.getString("result_body"))).optional();
		if (existing.isPresent()) {
			var stored = existing.get();
			if (!MessageDigest.isEqual(stored.requestHash().getBytes(StandardCharsets.US_ASCII), requestHash.getBytes(StandardCharsets.US_ASCII))) {
				throw new ApiException(HttpStatus.CONFLICT, "idempotency_conflict", "Этот Idempotency-Key уже использован с другими данными");
			}
			if (!"completed".equals(stored.status())) {
				throw new ApiException(HttpStatus.CONFLICT, "idempotency_in_progress", "Запрос с этим ключом ещё выполняется");
			}
			return new ReplayableResponse(stored.resultCode(), decode(stored.resultBody()), true);
		}

		var id = "idem_" + UUID.randomUUID();
		jdbc.sql("""
				insert into idempotency_requests(id, actor_id, operation, request_key, request_hash, status, expires_at)
				values (:id, :actorId, :operation, :requestKey, :requestHash, 'processing', :expiresAt)
				""").param("id", id).param("actorId", actorId).param("operation", operation)
				.param("requestKey", requestKey).param("requestHash", requestHash)
				.param("expiresAt", clock.instant().plus(RETENTION)).update();
		var result = mutation.get();
		var resultJson = encode(result);
		jdbc.sql("""
				update idempotency_requests
				set status = 'completed', result_code = :code, result_body = cast(:body as jsonb), completed_at = now()
				where id = :id
				""").param("code", successCode).param("body", resultJson).param("id", id).update();
		return new ReplayableResponse(successCode, result, false);
	}

	static void validateKey(String key) {
		if (key == null || !key.matches("[A-Za-z0-9._:-]{8,128}")) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_idempotency_key",
					"Idempotency-Key должен содержать 8–128 безопасных символов");
		}
	}

	private String encode(Object value) {
		try {
			return json.writeValueAsString(value);
		} catch (JacksonException exception) {
			throw new IllegalStateException("Cannot serialize idempotent response", exception);
		}
	}

	private JsonNode decode(String value) {
		try {
			return json.readTree(value);
		} catch (JacksonException exception) {
			throw new IllegalStateException("Cannot read idempotent response", exception);
		}
	}

	private String hash(String value) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
		} catch (NoSuchAlgorithmException impossible) {
			throw new IllegalStateException("SHA-256 is unavailable", impossible);
		}
	}

	private record StoredRequest(String requestHash, String status, Integer resultCode, String resultBody) {}
	public record ReplayableResponse(int status, Object body, boolean replayed) {}
}
