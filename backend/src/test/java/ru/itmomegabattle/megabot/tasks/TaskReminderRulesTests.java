package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import ru.itmomegabattle.megabot.common.ApiException;

class TaskReminderRulesTests {
	@Test void beforeDeadlineUsesTheExactPersistedInstant() {
		var deadline=Instant.parse("2026-10-05T20:59:59.999Z");
		assertThat(TaskReminderRules.firstDue("before_deadline",Duration.ofHours(2),deadline))
				.isEqualTo(Instant.parse("2026-10-05T18:59:59.999Z"));
		assertThatThrownBy(()->TaskReminderRules.firstDue("before_deadline",Duration.ofDays(1),null))
				.isInstanceOf(ApiException.class);
	}
	@Test void repeatSkipsOldTicksWithoutDriftingFromAnchor() {
		var anchor=Instant.parse("2026-10-01T09:00:00Z");
		assertThat(TaskReminderRules.firstDue("repeat",Duration.ofHours(2),anchor)).isEqualTo(anchor.plusSeconds(7200));
		assertThat(TaskReminderRules.nextRepeat(anchor,Duration.ofHours(2),Instant.parse("2026-10-03T10:12:17Z")))
				.isEqualTo(Instant.parse("2026-10-03T11:00:00Z"));
		assertThat(TaskReminderRules.nextRepeat(anchor,Duration.ofHours(2),anchor.plusSeconds(7200)))
				.isEqualTo(anchor.plusSeconds(14400));
	}
	@Test void clockGoingBackDoesNotScheduleBeforeFirstTick() {
		var anchor=Instant.parse("2026-10-01T09:00:00Z");
		assertThat(TaskReminderRules.nextRepeat(anchor,Duration.ofHours(1),anchor.minusSeconds(3600)))
				.isEqualTo(anchor.plusSeconds(3600));
	}
	@Test void validatesReminderTypeUnitAndPositiveValue() {
		assertThatThrownBy(()->TaskReminderRules.interval("repeat",0,"hours")).isInstanceOf(ApiException.class);
		assertThatThrownBy(()->TaskReminderRules.interval("unknown",1,"hours")).isInstanceOf(ApiException.class);
		assertThatThrownBy(()->TaskReminderRules.interval("repeat",1,"minutes")).isInstanceOf(ApiException.class);
		assertThat(TaskReminderRules.interval("repeat",1,"days")).isEqualTo(Duration.ofHours(24));
	}
	@Test void completedAndCancelledTasksPauseScheduling() {
		assertThat(TaskReminderRules.schedulable("completed")).isFalse();
		assertThat(TaskReminderRules.schedulable("cancelled")).isFalse();
		assertThat(TaskReminderRules.schedulable("in_progress")).isTrue();
	}
}
