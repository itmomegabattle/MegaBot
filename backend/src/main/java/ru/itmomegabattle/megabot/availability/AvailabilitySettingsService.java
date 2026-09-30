package ru.itmomegabattle.megabot.availability;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;

@Service
class AvailabilitySettingsService {

	private static final String KEY = "availability";

	private final JdbcClient jdbc;
	private final ObjectMapper json;
	private final AuditWriter audit;

	AvailabilitySettingsService(JdbcClient jdbc, ObjectMapper json, AuditWriter audit) {
		this.jdbc = jdbc;
		this.json = json;
		this.audit = audit;
	}

	@Transactional(readOnly = true)
	AvailabilitySettings get() {
		return jdbc.sql("select setting_value::text as value, version from app_settings where setting_key = :key")
				.param("key", KEY)
				.query((row, index) -> decode(row.getString("value"), row.getLong("version")))
				.optional()
				.orElseGet(AvailabilitySettings::defaults);
	}

	@Transactional
	AvailabilitySettings update(AvailabilityController.SettingsMutation request) {
		validate(request.weekCount(), request.activeDays(), request.firstHour(), request.lastHour());
		var current = jdbc.sql("select setting_value::text as value, version from app_settings where setting_key = :key for update")
				.param("key", KEY)
				.query((row, index) -> decode(row.getString("value"), row.getLong("version")))
				.optional();
		var version = current.map(AvailabilitySettings::version).orElse(0L);
		if (version != request.expectedVersion()) {
			throw new ApiException(HttpStatus.CONFLICT, "stale_version", "Настройки слотов уже изменены");
		}
		var normalizedDays = request.activeDays().stream().distinct().sorted().toList();
		var value = encode(new SettingsJson(request.weekCount(), normalizedDays, request.firstHour(), request.lastHour()));
		if (current.isEmpty()) {
			jdbc.sql("insert into app_settings(setting_key, setting_value, version) values (:key, cast(:value as jsonb), 1)")
					.param("key", KEY).param("value", value).update();
			audit.writeCurrent("app_setting", KEY, "created", java.util.Map.of("weekCount", request.weekCount(), "activeDays", normalizedDays));
			return new AvailabilitySettings(request.weekCount(), normalizedDays, request.firstHour(), request.lastHour(), 1);
		}
		jdbc.sql("update app_settings set setting_value = cast(:value as jsonb), version = version + 1, updated_at = now() where setting_key = :key")
				.param("key", KEY).param("value", value).update();
		audit.writeCurrent("app_setting", KEY, "updated", java.util.Map.of("weekCount", request.weekCount(), "activeDays", normalizedDays));
		return new AvailabilitySettings(request.weekCount(), normalizedDays, request.firstHour(), request.lastHour(), version + 1);
	}

	private AvailabilitySettings decode(String value, long version) {
		try {
			var data = json.readValue(value, SettingsJson.class);
			validate(data.weekCount(), data.activeDays(), data.firstHour(), data.lastHour());
			return new AvailabilitySettings(data.weekCount(), data.activeDays().stream().distinct().sorted().toList(),
					data.firstHour(), data.lastHour(), version);
		} catch (JacksonException | ApiException exception) {
			throw new IllegalStateException("Invalid availability settings in database", exception);
		}
	}

	private String encode(SettingsJson value) {
		try {
			return json.writeValueAsString(value);
		} catch (JacksonException exception) {
			throw new IllegalStateException("Cannot serialize availability settings", exception);
		}
	}

	static void validate(int weekCount, List<Integer> activeDays, int firstHour, int lastHour) {
		if (weekCount < 2 || weekCount > 5) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_week_count", "Горизонт должен составлять 2–5 недель");
		}
		if (activeDays == null || activeDays.isEmpty() || activeDays.stream().anyMatch(day -> day == null || day < 0 || day > 6)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_active_days", "Выберите хотя бы один день недели");
		}
		if (firstHour < 0 || lastHour > 23 || firstHour > lastHour) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_slot_hours", "Часы слотов должны входить в диапазон 00:00–23:00");
		}
	}

	private record SettingsJson(int weekCount, List<Integer> activeDays, int firstHour, int lastHour) {
	}
}
