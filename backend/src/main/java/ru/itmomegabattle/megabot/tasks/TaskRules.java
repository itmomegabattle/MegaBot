package ru.itmomegabattle.megabot.tasks;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import ru.itmomegabattle.megabot.common.ApiException;

final class TaskRules {
	static final Map<String, Set<String>> TRANSITIONS = Map.of(
			"open", Set.of("assigned", "cancelled"),
			"assigned", Set.of("open", "in_progress", "waiting", "completed", "cancelled"),
			"in_progress", Set.of("open", "assigned", "waiting", "completed", "cancelled"),
			"waiting", Set.of("open", "assigned", "in_progress", "completed", "cancelled"),
			"completed", Set.of("assigned", "in_progress", "waiting", "cancelled"),
			"cancelled", Set.of());
	private TaskRules() {}
	static boolean transition(String before, String after) {
		if (!TRANSITIONS.containsKey(after)) throw bad("invalid_task_status", "Неизвестный статус задачи");
		if ("cancelled".equals(before)) throw conflict("task_cancelled", "Отменённую задачу нельзя возобновить");
		if (before.equals(after)) return false;
		if (!TRANSITIONS.getOrDefault(before, Set.of()).contains(after)) throw conflict("invalid_task_transition", "Недопустимый переход статуса задачи");
		return true;
	}
	static String text(String value, int min, int max) {
		var clean = value == null ? "" : value.strip();
		if (clean.length() < min || clean.length() > max) throw bad("invalid_task_text", "Некорректная длина текста задачи");
		return clean;
	}
	static String priority(String value) {
		if (!List.of("normal", "important", "critical").contains(value == null ? "" : value)) throw bad("invalid_task_priority", "Неизвестный приоритет задачи");
		return value;
	}
	static Instant deadline(LocalDate date) {
		return date == null ? null : date.plusDays(1).atStartOfDay(ZoneId.of("Europe/Moscow")).toInstant().minusMillis(1);
	}
	static ApiException bad(String code, String message) { return new ApiException(HttpStatus.BAD_REQUEST, code, message); }
	static ApiException conflict(String code, String message) { return new ApiException(HttpStatus.CONFLICT, code, message); }
}
