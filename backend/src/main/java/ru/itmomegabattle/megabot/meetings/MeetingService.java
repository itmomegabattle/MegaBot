package ru.itmomegabattle.megabot.meetings;

import ru.itmomegabattle.megabot.common.SqlTime;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;
import ru.itmomegabattle.megabot.notifications.OutboxWriter;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@Service
class MeetingService {

	private final JdbcClient jdbc;
	private final ObjectMapper json;
	private final Clock clock;
	private final AuditWriter audit;
	private final OutboxWriter outbox;
	private final int reminderMinutes;

	MeetingService(JdbcClient jdbc, ObjectMapper json, Clock clock, AuditWriter audit, OutboxWriter outbox,
			@Value("${megabot.meetings.reminder-minutes:60}") int reminderMinutes) {
		if (reminderMinutes < 0 || reminderMinutes > 1440) throw new IllegalArgumentException("invalid_meeting_reminder_interval");
		this.reminderMinutes = reminderMinutes;
		this.jdbc = jdbc;
		this.json = json;
		this.clock = clock;
		this.audit = audit;
		this.outbox = outbox;
	}

	@Transactional(readOnly = true)
	List<MeetingController.MeetingView> list() {
		var now = clock.instant();
		return jdbc.sql("select * from meetings")
				.query((row, index) -> row(row)).list().stream()
				.map(meeting -> view(meeting, now))
				.sorted(meetingComparator())
				.toList();
	}

	@Transactional
	MeetingController.MeetingView create(MeetingController.MeetingMutation request, AuthenticatedUser actor) {
		var normalized = MeetingRules.normalize(request, slotPolicy(), clock);
		validateEvent(normalized.eventId(), "setup".equals(normalized.kind()));
		var audience = resolveAudience(normalized, actor.id());
		var id = "mtg_" + UUID.randomUUID();
		jdbc.sql("""
				insert into meetings(id, kind, title, event_id, starts_at, duration_minutes, zone_id, host_id,
				                     audience_mode, competency_id, topic, description, status, version)
				values (:id, :kind, :title, :eventId, :startsAt, :duration, :zoneId, :hostId,
				        :audienceMode, :competencyId, :topic, :description, 'scheduled', 0)
				""").param("id", id).param("kind", normalized.kind()).param("title", normalized.title())
				.param("eventId", normalized.eventId()).param("startsAt", SqlTime.of(normalized.startsAt()))
				.param("duration", normalized.durationMinutes()).param("zoneId", MeetingRules.PROJECT_ZONE.getId())
				.param("hostId", actor.id()).param("audienceMode", normalized.audienceMode())
				.param("competencyId", normalized.competencyId()).param("topic", normalized.topic())
				.param("description", normalized.description()).update();
		replaceAudience(id, Set.of(), audience);
		var meeting = require(id, false);
		writeSideEffects(meeting, "created", Set.of(), audience,actor.id(),meeting.title());
		audit.write(actor.id(), "meeting", id, "created", snapshot(meeting, audience));
		return view(meeting, clock.instant());
	}

	@Transactional
	MeetingController.MeetingView update(String id, MeetingController.MeetingMutation request, AuthenticatedUser actor) {
		var current = require(id, true);
		requireOwnerOrAdmin(current, actor);
		requireScheduled(current);
		if (current.version() != request.expectedVersion()) throw stale();
		var normalized = MeetingRules.normalize(request, slotPolicy(), clock);
		validateEvent(normalized.eventId(), "setup".equals(normalized.kind()));
		var previousAudience = invitationIds(id);
		var nextAudience = resolveAudience(normalized, current.hostId());
		var nextVersion = current.version() + 1;
		jdbc.sql("""
				update meetings set kind = :kind, title = :title, event_id = :eventId, starts_at = :startsAt,
				 duration_minutes = :duration, audience_mode = :audienceMode, competency_id = :competencyId,
				 topic = :topic, description = :description, version = :version, updated_at = now()
				where id = :id and version = :expectedVersion
				""").param("kind", normalized.kind()).param("title", normalized.title())
				.param("eventId", normalized.eventId()).param("startsAt", SqlTime.of(normalized.startsAt()))
				.param("duration", normalized.durationMinutes()).param("audienceMode", normalized.audienceMode())
				.param("competencyId", normalized.competencyId()).param("topic", normalized.topic())
				.param("description", normalized.description()).param("version", nextVersion)
				.param("id", id).param("expectedVersion", current.version()).update();
		replaceAudience(id, previousAudience, nextAudience);
		var updated = require(id, false);
		var changes = new LinkedHashMap<String, Object>();
		changes.put("before", snapshot(current, previousAudience));
		changes.put("after", snapshot(updated, nextAudience));
		audit.write(actor.id(), "meeting", id, "updated", changes);
		writeSideEffects(updated, "updated", previousAudience, nextAudience,actor.id(),current.title());
		return view(updated, clock.instant());
	}

	@Transactional
	MeetingController.MeetingView cancel(String id, long expectedVersion, AuthenticatedUser actor) {
		var current = require(id, true);
		requireOwnerOrAdmin(current, actor);
		if ("cancelled".equals(current.status())) return view(current, clock.instant());
		if (current.version() != expectedVersion) throw stale();
		var nextVersion = current.version() + 1;
		jdbc.sql("update meetings set status = 'cancelled', version = :version, updated_at = now() where id = :id and version = :expected")
				.param("version", nextVersion).param("id", id).param("expected", expectedVersion).update();
		var cancelled = require(id, false);
		var audience = invitationIds(id);
		audit.write(actor.id(), "meeting", id, "cancelled", Map.of("version", nextVersion));
		writeSideEffects(cancelled, "cancelled", audience, audience,actor.id(),current.title());
		return view(cancelled, clock.instant());
	}

	@Transactional
	MeetingController.RsvpView rsvp(String id, String response, AuthenticatedUser actor) {
		if (!List.of("unanswered", "yes", "no").contains(response)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_rsvp", "Ответ должен быть unanswered, yes или no");
		}
		var meeting = require(id, true);
		requireScheduled(meeting);
		if (!clock.instant().isBefore(meeting.startsAt().plusSeconds(meeting.durationMinutes() * 60L))) {
			throw new ApiException(HttpStatus.CONFLICT, "meeting_finished", "Встреча уже завершилась");
		}
		var previous = jdbc.sql("select rsvp from meeting_invitations where meeting_id = :meetingId and user_id = :userId for update")
				.param("meetingId", id).param("userId", actor.id()).query(String.class).optional()
				.orElseThrow(() -> new ApiException(HttpStatus.FORBIDDEN, "not_invited", "Вы не приглашены на эту встречу"));
		if (previous.equals(response)) return new MeetingController.RsvpView(id, response, false);
		jdbc.sql("update meeting_invitations set rsvp = :response, responded_at = :respondedAt where meeting_id = :meetingId and user_id = :userId")
				.param("response", response).param("respondedAt", SqlTime.of("unanswered".equals(response) ? null : clock.instant()))
				.param("meetingId", id).param("userId", actor.id()).update();
		audit.write(actor.id(), "meeting_rsvp", id + ":" + actor.id(), "changed", Map.of("before", previous, "after", response));
		return new MeetingController.RsvpView(id, response, true);
	}

	private Set<String> resolveAudience(MeetingRules.NormalizedMeeting meeting, String hostId) {
		var audience = new HashSet<String>();
		if ("all".equals(meeting.audienceMode())) {
			audience.addAll(activeCoreIds());
		} else if ("selected".equals(meeting.audienceMode())) {
			if (meeting.selectedUserIds().isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST, "empty_audience", "Выберите хотя бы одного участника");
			var selected = jdbc.sql("select id from users where id in (:ids) and active and role in ('admin', 'organizer')")
					.param("ids", meeting.selectedUserIds()).query(String.class).list();
			if (selected.size() != meeting.selectedUserIds().size()) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_audience_member", "В аудитории есть недоступный участник");
			}
			audience.addAll(selected);
		} else {
			if (meeting.competencyId() == null) throw new ApiException(HttpStatus.BAD_REQUEST, "competency_required", "Выберите блок компетенций");
			var competencyExists = jdbc.sql("select count(*) from competencies where id = :id and active and scope = 'core'")
					.param("id", meeting.competencyId()).query(Long.class).single();
			if (competencyExists == 0) throw new ApiException(HttpStatus.BAD_REQUEST, "competency_not_found", "Блок компетенций не найден");
			audience.addAll(jdbc.sql("""
					select u.id from users u join user_competencies uc on uc.user_id = u.id
					where uc.competency_id = :competencyId and u.active and u.role in ('admin', 'organizer')
					""").param("competencyId", meeting.competencyId()).query(String.class).list());
			if (audience.isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST, "empty_audience", "В выбранном блоке нет активных участников");
		}
		audience.add(hostId);
		return Set.copyOf(audience);
	}

	private List<String> activeCoreIds() {
		return jdbc.sql("select id from users where active and role in ('admin', 'organizer') order by id").query(String.class).list();
	}

	private void replaceAudience(String meetingId, Set<String> previous, Set<String> next) {
		var removed = previous.stream().filter(id -> !next.contains(id)).toList();
		if (!removed.isEmpty()) {
			jdbc.sql("delete from meeting_invitations where meeting_id = :meetingId and user_id in (:ids)")
					.param("meetingId", meetingId).param("ids", removed).update();
		}
		for (var userId : next) {
			jdbc.sql("""
					insert into meeting_invitations(meeting_id, user_id, rsvp)
					values (:meetingId, :userId, 'unanswered') on conflict (meeting_id, user_id) do nothing
					""").param("meetingId", meetingId).param("userId", userId).update();
		}
	}

	private void writeSideEffects(MeetingRow meeting, String action, Set<String> previousAudience, Set<String> nextAudience,String actorId,String previousTitle) {
		var payload = new LinkedHashMap<String, Object>();
		payload.put("action", action); payload.put("meeting", snapshot(meeting, nextAudience));
		payload.put("previousAudienceUserIds", previousAudience); payload.put("audienceUserIds", nextAudience);
		payload.put("actorId",actorId);
		payload.put("previousTitle",previousTitle);
		var union=new HashSet<>(previousAudience);union.addAll(nextAudience);
		var recipients=jdbc.sql("select id,telegram_id from users where id in (:ids) order by id")
				.param("ids",union).query((r,i)->{
			var person=new LinkedHashMap<String,Object>();person.put("userId",r.getString(1));person.put("telegramId",r.getObject(2));
			person.put("kind",nextAudience.contains(r.getString(1))?"invited":"removed");return person;
		}).list();
		payload.put("recipientSnapshot",recipients);
		payload.put("groupTargets", importantGroupTargets());
		var encoded = encode(payload);
		outbox.write("meeting", meeting.id(), "meeting." + action,
				"meeting:" + meeting.id() + ":" + meeting.version() + ":" + action, encoded, clock.instant());
		var due=meeting.startsAt().minusSeconds(reminderMinutes * 60L);
		var databaseNow=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
		if (reminderMinutes > 0 && !action.equals("cancelled") && due.isAfter(databaseNow)) {
			var reminder=new LinkedHashMap<>(payload);
			reminder.put("action","reminder");
			reminder.put("originAction",action);
			reminder.put("recipientSnapshot",recipients.stream().filter(p->p.get("kind").equals("invited")).toList());
			outbox.write("meeting",meeting.id(),"meeting.reminder",
					"meeting:"+meeting.id()+":"+meeting.version()+":reminder",encode(reminder),due);
		}
		jdbc.sql("""
				insert into integration_jobs(id, provider, entity_type, entity_id, entity_version, payload, available_at, status)
				values (:id, 'google_calendar', 'meeting', :meetingId, :version, cast(:payload as jsonb), :availableAt, 'pending')
				""").param("id", "job_" + UUID.randomUUID()).param("meetingId", meeting.id())
				.param("version", meeting.version()).param("payload", encoded).param("availableAt", SqlTime.of(clock.instant())).update();
	}

	private List<Map<String, Object>> importantGroupTargets() {
		return jdbc.sql("""
				select bot_id, chat_id, important_thread_id from chat_bindings
				where type = 'important' order by bot_id, chat_id, important_thread_id
				""").query((row, index) -> Map.<String, Object>of(
					"botId", row.getString("bot_id"),
					"chatId", row.getLong("chat_id"),
					"messageThreadId", row.getLong("important_thread_id"))).list();
	}

	private void validateEvent(String eventId, boolean required) {
		if (eventId == null) {
			if (required) throw new ApiException(HttpStatus.BAD_REQUEST, "setup_event_required", "Для монтажа выберите мероприятие");
			return;
		}
		var exists = jdbc.sql("select count(*) from work_events where id = :id and status = 'active'")
				.param("id", eventId).query(Long.class).single();
		if (exists == 0) throw new ApiException(HttpStatus.BAD_REQUEST, "event_not_found", "Активное мероприятие не найдено");
	}

	private MeetingRules.SlotPolicy slotPolicy() {
		return jdbc.sql("select setting_value::text from app_settings where setting_key = 'availability'")
				.query(String.class).optional().map(this::decodePolicy)
				.orElseGet(() -> new MeetingRules.SlotPolicy(List.of(0, 1, 2, 3, 4), 17, 23));
	}

	private MeetingRules.SlotPolicy decodePolicy(String value) {
		try {
			var node = json.readTree(value);
			var days = new ArrayList<Integer>();
			node.path("activeDays").forEach(item -> days.add(item.asInt()));
			return new MeetingRules.SlotPolicy(days.isEmpty() ? List.of(0, 1, 2, 3, 4) : List.copyOf(days),
					node.path("firstHour").asInt(17), node.path("lastHour").asInt(23));
		} catch (JacksonException exception) {
			throw new IllegalStateException("Invalid availability settings", exception);
		}
	}

	private MeetingRow require(String id, boolean lock) {
		var sql = "select * from meetings where id = :id" + (lock ? " for update" : "");
		return jdbc.sql(sql).param("id", id).query((row, index) -> row(row)).optional()
				.orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "meeting_not_found", "Встреча не найдена"));
	}

	private MeetingRow row(java.sql.ResultSet row) throws java.sql.SQLException {
		return new MeetingRow(row.getString("id"), row.getString("kind"), row.getString("title"), row.getString("event_id"),
				row.getTimestamp("starts_at").toInstant(), row.getInt("duration_minutes"), row.getString("zone_id"),
				row.getString("host_id"), row.getString("audience_mode"), row.getString("competency_id"),
				row.getString("topic"), row.getString("description"), row.getString("status"), row.getLong("version"));
	}

	private Set<String> invitationIds(String meetingId) {
		return Set.copyOf(jdbc.sql("select user_id from meeting_invitations where meeting_id = :id order by user_id")
				.param("id", meetingId).query(String.class).list());
	}

	private List<MeetingController.InvitationView> invitations(String meetingId) {
		return jdbc.sql("select user_id, rsvp, responded_at from meeting_invitations where meeting_id = :id order by user_id")
				.param("id", meetingId).query((row, index) -> new MeetingController.InvitationView(
						row.getString("user_id"), row.getString("rsvp"),
						row.getTimestamp("responded_at") == null ? null : row.getTimestamp("responded_at").toInstant())).list();
	}

	private MeetingController.MeetingView view(MeetingRow meeting, Instant now) {
		return new MeetingController.MeetingView(meeting.id(), meeting.kind(), meeting.title(), meeting.eventId(), meeting.startsAt(),
				meeting.startsAt().plusSeconds(meeting.durationMinutes() * 60L), meeting.durationMinutes(), meeting.zoneId(),
				meeting.hostId(), meeting.audienceMode(), meeting.competencyId(), meeting.topic(), meeting.description(),
				meeting.status(), meeting.version(), MeetingRules.phase(meeting.startsAt(), meeting.durationMinutes(), meeting.status(), now),
				invitations(meeting.id()));
	}

	private Comparator<MeetingController.MeetingView> meetingComparator() {
		return (left, right) -> {
			var leftRank = phaseRank(left.phase()); var rightRank = phaseRank(right.phase());
			if (leftRank != rightRank) return Integer.compare(leftRank, rightRank);
			return "past".equals(left.phase()) || "cancelled".equals(left.phase())
					? right.startsAt().compareTo(left.startsAt()) : left.startsAt().compareTo(right.startsAt());
		};
	}

	private int phaseRank(String phase) { return switch (phase) { case "ongoing" -> 0; case "upcoming" -> 1; case "past" -> 2; default -> 3; }; }
	private void requireOwnerOrAdmin(MeetingRow meeting, AuthenticatedUser actor) {
		if (!"admin".equals(actor.role()) && !meeting.hostId().equals(actor.id())) {
			throw new ApiException(HttpStatus.FORBIDDEN, "meeting_owner_required", "Изменять встречу может организатор или администратор");
		}
	}
	private void requireScheduled(MeetingRow meeting) {
		if (!"scheduled".equals(meeting.status())) throw new ApiException(HttpStatus.CONFLICT, "meeting_not_scheduled", "Встреча уже отменена или завершена");
	}
	private ApiException stale() { return new ApiException(HttpStatus.CONFLICT, "stale_version", "Встреча уже изменена"); }

	private Map<String, Object> snapshot(MeetingRow meeting, Set<String> audience) {
		var result = new LinkedHashMap<String, Object>();
		result.put("id", meeting.id()); result.put("kind", meeting.kind()); result.put("title", meeting.title());
		result.put("eventId", meeting.eventId() == null ? "" : meeting.eventId()); result.put("startsAt", meeting.startsAt().toString());
		result.put("durationMinutes", meeting.durationMinutes()); result.put("zoneId", meeting.zoneId()); result.put("hostId", meeting.hostId());
		result.put("audienceMode", meeting.audienceMode()); result.put("audienceUserIds", audience);
		result.put("competencyId", meeting.competencyId() == null ? "" : meeting.competencyId());
		result.put("topic", meeting.topic() == null ? "" : meeting.topic());
		result.put("description", meeting.description() == null ? "" : meeting.description());
		result.put("status", meeting.status());
		result.put("version", meeting.version());
		return result;
	}

	private String encode(Object value) {
		try { return json.writeValueAsString(value); }
		catch (JacksonException exception) { throw new IllegalStateException("Cannot serialize meeting job", exception); }
	}

	private record MeetingRow(String id, String kind, String title, String eventId, Instant startsAt, int durationMinutes,
			String zoneId, String hostId, String audienceMode, String competencyId, String topic, String description,
			String status, long version) {}
}
