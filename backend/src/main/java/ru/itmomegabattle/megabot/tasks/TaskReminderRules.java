package ru.itmomegabattle.megabot.tasks;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

final class TaskReminderRules {
	private TaskReminderRules() {}

	static Duration interval(String type, int value, String unit) {
		if (!List.of("repeat", "before_deadline").contains(type == null ? "" : type)
				|| !List.of("days", "hours").contains(unit == null ? "" : unit) || value <= 0) {
			throw TaskRules.bad("invalid_task_reminder", "Укажите тип, положительный интервал и единицу напоминания");
		}
		return "days".equals(unit) ? Duration.ofDays(value) : Duration.ofHours(value);
	}

	static Instant firstDue(String type, Duration interval, Instant anchor) {
		if (anchor == null) throw TaskRules.bad("reminder_deadline_required", "Для напоминания до дедлайна укажите дедлайн");
		return "before_deadline".equals(type) ? anchor.minus(interval) : anchor.plus(interval);
	}

	static Instant nextRepeat(Instant anchor, Duration interval, Instant now) {
		var elapsed = Math.max(0, Duration.between(anchor, now).getSeconds());
		var tick = elapsed / interval.getSeconds() + 1;
		return anchor.plusSeconds(Math.multiplyExact(tick, interval.getSeconds()));
	}

	static boolean schedulable(String status) {
		return !List.of("completed", "cancelled").contains(status);
	}
}
