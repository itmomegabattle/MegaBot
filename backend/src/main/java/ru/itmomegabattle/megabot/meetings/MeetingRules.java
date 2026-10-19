package ru.itmomegabattle.megabot.meetings;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;

import org.springframework.http.HttpStatus;

import ru.itmomegabattle.megabot.common.ApiException;

final class MeetingRules {

	static final ZoneId PROJECT_ZONE = ZoneId.of("Europe/Moscow");
	private static final List<String> KINDS = List.of("meeting", "setup", "vibe");

	private MeetingRules() {
	}

	static NormalizedMeeting normalize(MeetingController.MeetingMutation request, Clock clock) {
		var kind = request.kind() == null ? "meeting" : request.kind();
		if (!KINDS.contains(kind)) throw bad("invalid_meeting_kind", "Неизвестный вид встречи");
		var title = normalizeText(request.title(), 2, 160, "Название встречи");
		if (request.date() == null || request.time() == null) throw bad("invalid_meeting_time", "Укажите дату и время встречи");
		var start = ZonedDateTime.of(request.date(), request.time(), PROJECT_ZONE).toInstant();
		if (!start.isAfter(clock.instant())) throw bad("meeting_in_past", "Нельзя назначить встречу в прошлом");
		var duration = request.durationMinutes();
		if ("setup".equals(kind) ? duration < 60 || duration > 720 || duration % 60 != 0 : duration < 30 || duration > 360 || duration % 30 != 0) {
			throw bad("invalid_meeting_duration", "setup".equals(kind) ? "Монтаж: от 1 до 12 целых часов" : "Длительность должна быть 30–360 минут с шагом 30 минут");
		}
		var eventId = blankToNull(request.eventId());
		if ("setup".equals(kind) && eventId == null) throw bad("setup_event_required", "Для монтажа выберите мероприятие");
		var audienceMode = "setup".equals(kind) ? "all" : request.audienceMode();
		if (!List.of("all", "selected", "block").contains(audienceMode)) {
			throw bad("invalid_meeting_audience", "Неизвестный тип аудитории");
		}
		var topic = "setup".equals(kind) ? null : normalizeOptional(request.topic(), 500, "Тема");
		var description = "setup".equals(kind) ? null : normalizeOptional(request.description(), 4000, "Описание");
		return new NormalizedMeeting(kind, title, eventId, start, duration, audienceMode,
				blankToNull(request.competencyId()), topic, description,
				request.selectedUserIds() == null ? List.of() : request.selectedUserIds().stream().distinct().toList());
	}

	static String phase(Instant startsAt, int durationMinutes, String status, Instant now) {
		if ("cancelled".equals(status)) return "cancelled";
		if (now.isBefore(startsAt)) return "upcoming";
		return now.isBefore(startsAt.plusSeconds(durationMinutes * 60L)) ? "ongoing" : "past";
	}

	private static String normalizeText(String value, int min, int max, String label) {
		var normalized = value == null ? "" : value.strip().replaceAll("\\s+", " ");
		if (normalized.length() < min || normalized.length() > max) throw bad("invalid_meeting_text", label + " должно содержать " + min + "–" + max + " символов");
		return normalized;
	}

	static String normalizeOptional(String value, int max, String label) {
		if (value == null || value.isBlank()) return null;
		var normalized = value.strip();
		if (normalized.length() > max) throw bad("invalid_meeting_text", label + " слишком длинное");
		return normalized;
	}

	private static String blankToNull(String value) { return value == null || value.isBlank() ? null : value.strip(); }
	private static ApiException bad(String code, String message) { return new ApiException(HttpStatus.BAD_REQUEST, code, message); }

	record NormalizedMeeting(String kind, String title, String eventId, Instant startsAt, int durationMinutes,
			String audienceMode, String competencyId, String topic, String description, List<String> selectedUserIds) {}
}
