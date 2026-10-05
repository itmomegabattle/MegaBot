package ru.itmomegabattle.megabot.compatibility;

import java.time.Clock;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;

import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.tasks.TaskService;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
class FrontendStateService {

	private static final ZoneId PROJECT_ZONE = ZoneId.of("Europe/Moscow");

	private final JdbcClient jdbc;
	private final ObjectMapper json;
	private final Clock clock;
	private final TaskService tasks;

	FrontendStateService(JdbcClient jdbc, ObjectMapper json, Clock clock, TaskService tasks) {
		this.jdbc = jdbc;
		this.json = json;
		this.clock = clock;
		this.tasks = tasks;
	}

	@Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
	Map<String, Object> state(AuthenticatedUser viewer) {
		var settings = readSettings();
		var monday = LocalDate.now(clock.withZone(PROJECT_ZONE)).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
		var users = users(viewer);
		var coreUserIds = users.stream()
				.filter(user -> List.of("admin", "organizer").contains(user.get("role")) && Boolean.TRUE.equals(user.get("active")))
				.map(user -> (String) user.get("id")).toList();
		var result = new LinkedHashMap<String, Object>();
		result.put("serverNow", clock.instant());
		result.put("timeZone", PROJECT_ZONE.getId());
		result.put("capabilities", Map.of("durableBroadcasts", true));
		result.put("users", users);
		result.put("faculties", faculties());
		result.put("facultyCompetencies", competencyNames("faculty"));
		result.put("competencies", competencyNames("core"));
		result.put("availabilities", availabilities(coreUserIds, monday, settings.weekCount()));
		result.put("meetings", meetings());
		result.put("events", events());
		result.put("tasks", tasks.frontendTasks(viewer));
		result.put("messages", Map.of(viewer.id(), List.of()));
		result.put("settings", settings.view(monday, metadata(monday, settings.weekCount())));
		return result;
	}

	private List<Map<String, Object>> users(AuthenticatedUser viewer) {
		var baseUsers = jdbc.sql("""
				select u.id, u.username, u.real_name, u.role, u.registered, u.active, u.telegram_id is not null as telegram_connected,
				       u.birthday_day, u.birthday_month, u.birthday_year, u.deactivated_at,
				       fm.faculty_id
				from users u left join faculty_memberships fm on fm.user_id = u.id
				order by u.real_name, u.id
				""").query((row, index) -> {
			Map<String, Object> map = new LinkedHashMap<>();
			var id = row.getString("id");
			map.put("id", id);
			map.put("username", row.getString("username"));
			map.put("realName", row.getString("real_name"));
			map.put("role", row.getString("role"));
			map.put("avatarSeed", row.getString("username"));
			map.put("birthday", birthday((Integer) row.getObject("birthday_day"), (Integer) row.getObject("birthday_month"),
					(Integer) row.getObject("birthday_year"), "admin".equals(viewer.role()) || viewer.id().equals(id)));
			map.put("registered", row.getBoolean("registered"));
			map.put("telegramConnected", row.getBoolean("telegram_connected"));
			map.put("active", row.getBoolean("active"));
			map.put("facultyId", valueOrEmpty(row.getString("faculty_id")));
			if ("admin".equals(viewer.role()) && row.getTimestamp("deactivated_at") != null) {
				map.put("deactivatedAt", row.getTimestamp("deactivated_at").toInstant());
			}
			return map;
		}).list();
		var competencies = jdbc.sql("""
				select uc.user_id, c.name, uc.is_primary
				from user_competencies uc join competencies c on c.id = uc.competency_id
				order by c.name
				""").query((row, index) -> new UserCompetency(row.getString("user_id"), row.getString("name"), row.getBoolean("is_primary"))).list();
		for (var user : baseUsers) {
			var assigned = competencies.stream().filter(item -> item.userId().equals(user.get("id"))).toList();
			user.put("competencies", assigned.stream().map(UserCompetency::name).toList());
			user.put("primaryCompetency", assigned.stream().filter(UserCompetency::primary).map(UserCompetency::name).findFirst().orElse(""));
		}
		return baseUsers;
	}

	private List<Map<String, Object>> faculties() {
		return jdbc.sql("select id, name from faculties where active order by name")
				.query((row, index) -> Map.<String, Object>of("id", row.getString("id"), "name", row.getString("name"))).list();
	}

	private List<String> competencyNames(String scope) {
		return jdbc.sql("select name from competencies where active and scope = :scope order by name")
				.param("scope", scope).query(String.class).list();
	}

	private Map<String, Object> availabilities(List<String> userIds, LocalDate monday, int weekCount) {
		var result = new LinkedHashMap<String, Object>();
		for (var userId : userIds) result.put(userId, new MutableAvailability(userId, monday, weekCount));
		if (!userIds.isEmpty()) {
			jdbc.sql("""
					select w.user_id, w.week_start, w.out_of_week, w.version, w.updated_at,
					       d.day_date, d.status, s.start_minute
					from availability_weeks w
					left join availability_days d on d.week_id = w.id
					left join availability_slots s on s.day_id = d.id
					where w.user_id in (:userIds) and w.week_start >= :first and w.week_start < :last
					order by w.user_id, w.week_start, d.day_date, s.start_minute
					""").param("userIds", userIds).param("first", monday).param("last", monday.plusWeeks(weekCount))
					.query((row, index) -> new AvailabilityRow(row.getString("user_id"),
							row.getObject("week_start", LocalDate.class), row.getBoolean("out_of_week"), row.getLong("version"),
							row.getTimestamp("updated_at").toInstant(), row.getObject("day_date", LocalDate.class),
							row.getString("status"), (Integer) row.getObject("start_minute")))
					.list().forEach(row -> ((MutableAvailability) result.get(row.userId())).accept(row));
		}
		return result.entrySet().stream().collect(java.util.stream.Collectors.toMap(
				Map.Entry::getKey, entry -> ((MutableAvailability) entry.getValue()).view(), (left, right) -> left, LinkedHashMap::new));
	}

	private List<Map<String, Object>> events() {
		return jdbc.sql("select id, name, description, starts_at, ends_at, status, created_at, created_by from work_events order by starts_at, name")
				.query((row, index) -> {
					Map<String, Object> event = new LinkedHashMap<>();
					event.put("id", row.getString("id")); event.put("name", row.getString("name"));
					if (row.getString("description") != null) event.put("description", row.getString("description"));
					if (row.getTimestamp("starts_at") != null) event.put("startsAt", row.getTimestamp("starts_at").toInstant());
					if (row.getTimestamp("ends_at") != null) event.put("endsAt", row.getTimestamp("ends_at").toInstant());
					event.put("status", row.getString("status")); event.put("createdAt", row.getTimestamp("created_at").toInstant());
					if (row.getString("created_by") != null) event.put("createdBy", row.getString("created_by"));
					return event;
				}).list();
	}

	private List<Map<String, Object>> meetings() {
		var invitations = jdbc.sql("select meeting_id, user_id, rsvp from meeting_invitations order by meeting_id, user_id")
				.query((row, index) -> new MeetingInvitation(row.getString("meeting_id"), row.getString("user_id"), row.getString("rsvp")))
				.list();
		return jdbc.sql("""
				select m.*, c.name as competency_name from meetings m
				left join competencies c on c.id = m.competency_id
				order by m.starts_at, m.id
				""").query((row, index) -> {
			var id = row.getString("id");
			var invited = invitations.stream().filter(item -> item.meetingId().equals(id)).toList();
			var localStart = row.getTimestamp("starts_at").toInstant().atZone(PROJECT_ZONE);
			Map<String, Object> meeting = new LinkedHashMap<>();
			meeting.put("id", id); meeting.put("title", row.getString("title")); meeting.put("kind", row.getString("kind"));
			if (row.getString("event_id") != null) meeting.put("eventId", row.getString("event_id"));
			meeting.put("type", "all".equals(row.getString("audience_mode")) ? "general" : "custom");
			meeting.put("date", localStart.toLocalDate().toString()); meeting.put("time", localStart.toLocalTime().toString());
			meeting.put("duration", row.getInt("duration_minutes") / 60.0); meeting.put("hostId", row.getString("host_id"));
			meeting.put("participants", "all".equals(row.getString("audience_mode"))
					? "all" : invited.stream().map(MeetingInvitation::userId).toList());
			meeting.put("audiencePolicy", "snapshot");
			meeting.put("audienceUserIds", invited.stream().map(MeetingInvitation::userId).toList());
			meeting.put("attendeeIds", invited.stream().filter(item -> "yes".equals(item.rsvp())).map(MeetingInvitation::userId).toList());
			meeting.put("rsvpByUser", invited.stream().filter(item -> !"unanswered".equals(item.rsvp()))
					.collect(java.util.stream.Collectors.toMap(MeetingInvitation::userId, MeetingInvitation::rsvp)));
			if (row.getString("competency_name") != null) meeting.put("competency", row.getString("competency_name"));
			if (row.getString("topic") != null) meeting.put("topic", row.getString("topic"));
			if (row.getString("description") != null) meeting.put("description", row.getString("description"));
			meeting.put("status", row.getString("status")); meeting.put("version", row.getLong("version"));
			return meeting;
		}).list();
	}

	private Settings readSettings() {
		return jdbc.sql("select setting_value::text, version from app_settings where setting_key = 'availability'")
				.query((row, index) -> decodeSettings(row.getString(1))).optional().orElseGet(Settings::defaults);
	}

	private Settings decodeSettings(String raw) {
		try {
			var node = json.readTree(raw);
			return new Settings(node.path("weekCount").asInt(4), integerList(node.path("activeDays")),
					node.path("firstHour").asInt(17), node.path("lastHour").asInt(23));
		} catch (Exception exception) {
			throw new IllegalStateException("Invalid availability settings", exception);
		}
	}

	private List<Integer> integerList(JsonNode node) {
		var result = new ArrayList<Integer>();
		if (node.isArray()) node.forEach(value -> result.add(value.asInt()));
		return result.isEmpty() ? List.of(0, 1, 2, 3, 4) : List.copyOf(result);
	}

	private Map<String, Map<String, String>> metadata(LocalDate monday, int weekCount) {
		var result = new LinkedHashMap<String, Map<String, String>>();
		jdbc.sql("select week_start, title, description from availability_week_metadata where week_start >= :first and week_start < :last order by week_start")
				.param("first", monday).param("last", monday.plusWeeks(weekCount))
				.query((row, index) -> new Metadata(row.getObject("week_start", LocalDate.class), row.getString("title"), row.getString("description")))
				.list().forEach(item -> {
					var values = new LinkedHashMap<String, String>();
					if (item.title() != null) values.put("name", item.title());
					if (item.description() != null) values.put("description", item.description());
					result.put(item.weekStart().toString(), values);
				});
		return result;
	}

	static String birthday(Integer day, Integer month, Integer year, boolean includeYear) {
		if (day == null || month == null) return "";
		if (includeYear && year != null) return "%04d-%02d-%02d".formatted(year, month, day);
		return "%02d.%02d".formatted(day, month);
	}

	private String valueOrEmpty(String value) { return value == null ? "" : value; }

	private record UserCompetency(String userId, String name, boolean primary) {}
	private record AvailabilityRow(String userId, LocalDate weekStart, boolean out, long version, Instant updatedAt,
			LocalDate dayDate, String status, Integer startMinute) {}
	private record Metadata(LocalDate weekStart, String title, String description) {}
	private record MeetingInvitation(String meetingId, String userId, String rsvp) {}

	private record Settings(int weekCount, List<Integer> activeDays, int firstHour, int lastHour) {
		private static Settings defaults() { return new Settings(4, List.of(0, 1, 2, 3, 4), 17, 23); }
		private Map<String, Object> view(LocalDate monday, Map<String, Map<String, String>> metadata) {
			return Map.of("availabilityWeekCount", weekCount, "availabilityActiveDays", activeDays,
					"availabilityStartHour", firstHour, "availabilityEndHour", lastHour,
					"availabilityWeekMetadata", metadata, "availabilityWeekStart", monday.toString());
		}
	}

	private static final class MutableAvailability {
		private final String userId;
		private final LocalDate monday;
		private final Map<Integer, List<Integer>> slots = new LinkedHashMap<>();
		private final List<Integer> unavailable = new ArrayList<>();
		private final List<Integer> outWeeks = new ArrayList<>();
		private final Map<String, Long> versions = new LinkedHashMap<>();
		private Instant updatedAt;

		private MutableAvailability(String userId, LocalDate monday, int weekCount) {
			this.userId = userId; this.monday = monday;
			for (var index = 0; index < weekCount; index++) versions.put(monday.plusWeeks(index).toString(), 0L);
		}
		private void accept(AvailabilityRow row) {
			var weekIndex = (int) java.time.temporal.ChronoUnit.WEEKS.between(monday, row.weekStart());
			versions.put(row.weekStart().toString(), row.version());
			if (row.out() && !outWeeks.contains(weekIndex)) outWeeks.add(weekIndex);
			if (row.updatedAt() != null && (updatedAt == null || row.updatedAt().isAfter(updatedAt))) updatedAt = row.updatedAt();
			if (row.dayDate() == null) return;
			var dayIndex = (int) java.time.temporal.ChronoUnit.DAYS.between(monday, row.dayDate());
			if ("unavailable".equals(row.status()) && !unavailable.contains(dayIndex)) unavailable.add(dayIndex);
			if (row.startMinute() != null) slots.computeIfAbsent(dayIndex, ignored -> new ArrayList<>()).add(row.startMinute() / 60);
		}
		private Map<String, Object> view() {
			var view = new LinkedHashMap<String, Object>();
			view.put("userId", userId); view.put("slots", slots); view.put("hardUnavailableDays", unavailable);
			view.put("outWeekIndexes", outWeeks); view.put("weekVersions", versions);
			view.put("updatedAt", updatedAt == null ? monday.atStartOfDay(PROJECT_ZONE).toInstant() : updatedAt);
			view.put("weekStart", monday.toString());
			return view;
		}
	}
}
