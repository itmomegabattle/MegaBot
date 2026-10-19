package ru.itmomegabattle.megabot.availability;

import java.time.Clock;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;

@Service
class AvailabilityService {

	static final ZoneId PROJECT_ZONE = ZoneId.of("Europe/Moscow");

	private final JdbcClient jdbc;
	private final AvailabilitySettingsService settingsService;
	private final Clock clock;
	private final AuditWriter audit;

	AvailabilityService(JdbcClient jdbc, AvailabilitySettingsService settingsService, Clock clock, AuditWriter audit) {
		this.jdbc = jdbc;
		this.settingsService = settingsService;
		this.clock = clock;
		this.audit = audit;
	}

	@Transactional(readOnly = true)
	AvailabilityController.AvailabilityResponse get(AuthenticatedUser actor, String requestedUserId) {
		var userId = resolveUser(actor, requestedUserId);
		var settings = settingsService.get();
		var starts = horizon(settings.weekCount());
		var first = starts.getFirst();
		var lastExclusive = starts.getLast().plusWeeks(1);
		var weeks = new LinkedHashMap<LocalDate, MutableWeek>();
		starts.forEach(start -> weeks.put(start, new MutableWeek(start)));

		jdbc.sql("""
				select w.id, w.week_start, w.out_of_week, w.version, m.title, m.description,
				       d.day_date, d.status, s.start_minute
				from availability_weeks w
				left join availability_week_metadata m on m.week_start = w.week_start
				left join availability_days d on d.week_id = w.id
				left join availability_slots s on s.day_id = d.id
				where w.user_id = :userId and w.week_start >= :first and w.week_start < :last
				order by w.week_start, d.day_date, s.start_minute
				""")
				.param("userId", userId).param("first", first).param("last", lastExclusive)
				.query((row, index) -> new AvailabilityRow(
						row.getString("id"), row.getObject("week_start", LocalDate.class), row.getBoolean("out_of_week"),
						row.getLong("version"), row.getString("title"), row.getString("description"),
						row.getObject("day_date", LocalDate.class), row.getString("status"),
						(Integer) row.getObject("start_minute")))
				.list().forEach(row -> weeks.get(row.weekStart()).accept(row));

		loadMetadata(first, lastExclusive, weeks);
		return new AvailabilityController.AvailabilityResponse(userId, clock.instant(), PROJECT_ZONE.getId(),
				AvailabilityController.SettingsView.from(settings),
				weeks.values().stream().map(MutableWeek::view).toList());
	}

	@Transactional
	AvailabilityController.WeekView saveWeek(
			AuthenticatedUser actor,
			String requestedUserId,
			LocalDate weekStart,
			AvailabilityController.SaveWeekRequest request) {
		var userId = resolveUser(actor, requestedUserId);
		// A week row does not exist on first save: lock its stable parent before reading its version.
		jdbc.sql("select id from users where id=:id for no key update").param("id",userId).query(String.class).optional()
				.orElseThrow(()->new ApiException(HttpStatus.NOT_FOUND,"user_not_found","Участник не найден"));
		var days = validateWeek(weekStart, request);
		var current = jdbc.sql("select id, version from availability_weeks where user_id = :userId and week_start = :weekStart for update")
				.param("userId", userId).param("weekStart", weekStart)
				.query((row, index) -> new WeekIdentity(row.getString("id"), row.getLong("version")))
				.optional();
		var currentVersion = current.map(WeekIdentity::version).orElse(0L);
		if (currentVersion != request.expectedVersion()) {
			throw new ApiException(HttpStatus.CONFLICT, "stale_version", "Эта неделя уже изменена. Обновите данные.");
		}
		var weekId = current.map(WeekIdentity::id).orElseGet(() -> "aw_" + UUID.randomUUID());
		var nextVersion = currentVersion + 1;
		if (current.isEmpty()) {
			jdbc.sql("insert into availability_weeks(id, user_id, week_start, out_of_week, version) values (:id, :userId, :weekStart, :out, :version)")
					.param("id", weekId).param("userId", userId).param("weekStart", weekStart)
					.param("out", request.outOfWeek()).param("version", nextVersion).update();
		} else {
			jdbc.sql("update availability_weeks set out_of_week = :out, version = :version, updated_at = now() where id = :id")
					.param("out", request.outOfWeek()).param("version", nextVersion).param("id", weekId).update();
			jdbc.sql("delete from availability_days where week_id = :id").param("id", weekId).update();
		}
		if (!request.outOfWeek()) {
			for (var day : days) {
				var dayId = "ad_" + UUID.randomUUID();
				jdbc.sql("insert into availability_days(id, week_id, week_start, day_date, status) values (:id, :weekId, :weekStart, :date, :status)")
						.param("id", dayId).param("weekId", weekId).param("weekStart", weekStart)
						.param("date", day.date()).param("status", day.status()).update();
				for (var minute : day.startMinutes()) {
					jdbc.sql("insert into availability_slots(day_id, start_minute) values (:dayId, :minute)")
							.param("dayId", dayId).param("minute", minute).update();
				}
			}
		}
		audit.write(actor.id(), "availability_week", weekId, "replaced", Map.of(
				"userId", userId, "weekStart", weekStart.toString(), "outOfWeek", request.outOfWeek(), "version", nextVersion));
		return get(actor, userId).weeks().stream().filter(week -> week.weekStart().equals(weekStart)).findFirst().orElseThrow();
	}

	@Transactional(readOnly = true)
	List<SlotSuggestionEngine.Suggestion> suggestions(AvailabilityController.SuggestionRequest request) {
		var settings = settingsService.get();
		requireVisibleMonday(request.weekStart(), settings.weekCount());
		if (request.durationMinutes() < 30 || request.durationMinutes() > 360 || request.durationMinutes() % 30 != 0) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_duration", "Длительность должна быть 30–360 минут с шагом 30 минут");
		}
		var dates = request.dates().stream().distinct().sorted().toList();
		if (dates.isEmpty() || dates.stream().anyMatch(date -> date == null
				|| date.isBefore(request.weekStart()) || date.isAfter(request.weekStart().plusDays(6))
				|| !settings.activeDays().contains(date.getDayOfWeek().getValue() - 1))) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_suggestion_dates", "Выберите активные дни указанной недели");
		}
		var builders = new LinkedHashMap<String, ParticipantBuilder>();
		jdbc.sql("""
				select u.id, u.real_name, u.username, coalesce(w.out_of_week, false) as out_of_week,
				       d.day_date, d.status, s.start_minute
				from users u
				left join availability_weeks w on w.user_id = u.id and w.week_start = :weekStart
				left join availability_days d on d.week_id = w.id
				left join availability_slots s on s.day_id = d.id
				where u.active and u.role in ('admin', 'organizer')
				order by u.real_name, u.id, d.day_date, s.start_minute
				""").param("weekStart", request.weekStart())
				.query((row, index) -> new SuggestionRow(row.getString("id"), row.getString("real_name"),
						row.getString("username"), row.getBoolean("out_of_week"),
						row.getObject("day_date", LocalDate.class), row.getString("status"),
						(Integer) row.getObject("start_minute")))
				.list().forEach(row -> builders.computeIfAbsent(row.id(), ignored -> new ParticipantBuilder(row))
						.accept(row));
		return SlotSuggestionEngine.suggest(builders.values().stream().map(ParticipantBuilder::build).toList(),
				dates, request.durationMinutes(), settings.firstHour(), settings.lastHour());
	}

	@Transactional
	AvailabilityController.WeekMetadataView saveMetadata(LocalDate weekStart, AvailabilityController.MetadataMutation request) {
		requireMonday(weekStart);
		var title = normalizeOptional(request.title(), 120, "Название недели");
		var description = normalizeOptional(request.description(), 1000, "Описание недели");
		jdbc.sql("""
				insert into availability_week_metadata(week_start, title, description)
				values (:weekStart, :title, :description)
				on conflict (week_start) do update set title = excluded.title, description = excluded.description, updated_at = now()
				""").param("weekStart", weekStart).param("title", title).param("description", description).update();
		audit.writeCurrent("availability_metadata", weekStart.toString(), "upserted", Map.of(
				"hasTitle", title != null, "hasDescription", description != null));
		return new AvailabilityController.WeekMetadataView(weekStart, title, description);
	}

	List<LocalDate> horizon(int weekCount) {
		var monday = LocalDate.now(clock.withZone(PROJECT_ZONE)).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
		return java.util.stream.IntStream.range(0, weekCount).mapToObj(monday::plusWeeks).toList();
	}

	List<AvailabilityController.DayMutation> validateWeek(LocalDate weekStart, AvailabilityController.SaveWeekRequest request) {
		var settings = settingsService.get();
		requireVisibleMonday(weekStart, settings.weekCount());
		if (request == null || request.expectedVersion() < 0)
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_week_request", "Некорректная версия недели");
		return validateDays(weekStart, request, settings);
	}

	private List<AvailabilityController.DayMutation> validateDays(
			LocalDate weekStart,
			AvailabilityController.SaveWeekRequest request,
			AvailabilitySettings settings) {
		if (request.outOfWeek()) {
			if (request.days() == null || request.days().stream().anyMatch(day -> day == null || day.startMinutes() == null || !day.startMinutes().isEmpty())) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "out_week_has_slots", "У недели «Я в ауте» не может быть слотов");
			}
			return List.of();
		}
		if (request.days() == null) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "missing_days", "Передайте состояния дней выбранной недели");
		}
		var unique = new HashMap<LocalDate, AvailabilityController.DayMutation>();
		for (var day : request.days()) {
			if (day == null || day.date() == null || day.date().isBefore(weekStart) || day.date().isAfter(weekStart.plusDays(6))
					|| unique.put(day.date(), day) != null) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_day", "Дни должны быть уникальны и входить в выбранную неделю");
			}
			var offset = day.date().getDayOfWeek().getValue() - 1;
			if (!settings.activeDays().contains(offset)) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "inactive_day", "Нельзя сохранить слоты для отключённого дня недели");
			}
			if (day.status() == null || !List.of("unanswered", "available", "unavailable").contains(day.status())) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_day_status", "Неизвестное состояние дня");
			}
			if (day.startMinutes() == null || day.startMinutes().stream().anyMatch(java.util.Objects::isNull))
				throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_slot", "Передайте список часов без пустых значений");
			var slots = day.startMinutes().stream().distinct().sorted().toList();
			if (slots.stream().anyMatch(minute -> minute == null || minute % 60 != 0
					|| minute < settings.firstHour() * 60 || minute > settings.lastHour() * 60)) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_slot", "Слот должен попадать в настроенный часовой диапазон");
			}
			if (("available".equals(day.status())) != !slots.isEmpty()) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_day_slots", "Только доступный день должен содержать хотя бы один слот");
			}
			unique.put(day.date(), new AvailabilityController.DayMutation(day.date(), day.status(), slots));
		}
		return unique.values().stream().sorted(java.util.Comparator.comparing(AvailabilityController.DayMutation::date)).toList();
	}

	private String resolveUser(AuthenticatedUser actor, String requestedUserId) {
		if (requestedUserId == null || requestedUserId.isBlank() || requestedUserId.equals(actor.id())) {
			return actor.id();
		}
		if (!"admin".equals(actor.role())) {
			throw new ApiException(HttpStatus.FORBIDDEN, "foreign_availability", "Можно изменять только свою доступность");
		}
		var exists = jdbc.sql("select count(*) from users where id = :id and active").param("id", requestedUserId)
				.query(Long.class).single();
		if (exists == 0) {
			throw new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "Участник не найден");
		}
		return requestedUserId;
	}

	private void requireVisibleMonday(LocalDate weekStart, int weekCount) {
		requireMonday(weekStart);
		if (!horizon(weekCount).contains(weekStart)) {
			throw new ApiException(HttpStatus.CONFLICT, "week_outside_horizon", "Неделя больше не входит в текущий горизонт");
		}
	}

	private void requireMonday(LocalDate weekStart) {
		if (weekStart == null || weekStart.getDayOfWeek() != DayOfWeek.MONDAY) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_week_start", "weekStart должен быть понедельником");
		}
	}

	private void loadMetadata(LocalDate first, LocalDate last, Map<LocalDate, MutableWeek> weeks) {
		jdbc.sql("select week_start, title, description from availability_week_metadata where week_start >= :first and week_start < :last")
				.param("first", first).param("last", last)
				.query((row, index) -> new MetadataRow(row.getObject("week_start", LocalDate.class), row.getString("title"), row.getString("description")))
				.list().forEach(row -> weeks.get(row.weekStart()).metadata(row.title(), row.description()));
	}

	private String normalizeOptional(String value, int max, String field) {
		if (value == null || value.isBlank()) return null;
		var normalized = value.strip();
		if (normalized.length() > max) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "text_too_long", field + " слишком длинное");
		}
		return normalized;
	}

	private record WeekIdentity(String id, long version) {}
	private record MetadataRow(LocalDate weekStart, String title, String description) {}
	private record AvailabilityRow(String id, LocalDate weekStart, boolean out, long version, String title,
			String description, LocalDate dayDate, String status, Integer startMinute) {}
	private record SuggestionRow(String id, String realName, String username, boolean out, LocalDate date,
			String status, Integer startMinute) {}

	private static final class ParticipantBuilder {
		private final String id;
		private final String realName;
		private final String username;
		private final boolean out;
		private final Map<LocalDate, DayBuilder> days = new HashMap<>();

		private ParticipantBuilder(SuggestionRow row) {
			this.id = row.id(); this.realName = row.realName(); this.username = row.username(); this.out = row.out();
		}
		private void accept(SuggestionRow row) {
			if (row.date() != null) days.computeIfAbsent(row.date(), ignored -> new DayBuilder(row.status())).add(row.startMinute());
		}
		private SlotSuggestionEngine.Participant build() {
			return new SlotSuggestionEngine.Participant(id, realName, username, out,
					days.entrySet().stream().collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, entry -> entry.getValue().build())));
		}
	}

	private static final class DayBuilder {
		private final String status;
		private final Set<Integer> slots = new HashSet<>();
		private DayBuilder(String status) { this.status = status; }
		private void add(Integer slot) { if (slot != null) slots.add(slot); }
		private SlotSuggestionEngine.Day build() { return new SlotSuggestionEngine.Day(status, Set.copyOf(slots)); }
	}

	private static final class MutableWeek {
		private final LocalDate weekStart;
		private boolean out;
		private long version;
		private String title;
		private String description;
		private final Map<LocalDate, MutableDay> days = new LinkedHashMap<>();

		private MutableWeek(LocalDate weekStart) { this.weekStart = weekStart; }
		private void accept(AvailabilityRow row) {
			out = row.out(); version = row.version(); title = row.title(); description = row.description();
			if (row.dayDate() != null) days.computeIfAbsent(row.dayDate(), date -> new MutableDay(date, row.status())).add(row.startMinute());
		}
		private void metadata(String title, String description) { this.title = title; this.description = description; }
		private AvailabilityController.WeekView view() {
			return new AvailabilityController.WeekView(weekStart,
					title == null ? "Неделя " + weekStart : title, description, out, version,
					days.values().stream().map(MutableDay::view).toList());
		}
	}

	private static final class MutableDay {
		private final LocalDate date;
		private final String status;
		private final List<Integer> slots = new ArrayList<>();
		private MutableDay(LocalDate date, String status) { this.date = date; this.status = status; }
		private void add(Integer slot) { if (slot != null) slots.add(slot); }
		private AvailabilityController.DayView view() { return new AvailabilityController.DayView(date, status, List.copyOf(slots)); }
	}
}
