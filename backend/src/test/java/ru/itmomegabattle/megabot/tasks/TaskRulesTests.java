package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import ru.itmomegabattle.megabot.common.ApiException;

class TaskRulesTests {
	@Test void cancelledTaskCannotBeReopened() {
		for(var status:TaskRules.TRANSITIONS.keySet())
			assertThatThrownBy(()->TaskRules.transition("cancelled",status)).isInstanceOf(ApiException.class);
	}
	@Test void completionRequiresAssignmentAndCanBeReopened() {
		assertThatThrownBy(()->TaskRules.transition("open","completed")).isInstanceOf(ApiException.class);
		assertThat(TaskRules.transition("assigned","completed")).isTrue();
		assertThat(TaskRules.transition("completed","in_progress")).isTrue();
		assertThat(TaskRules.transition("completed","completed")).isFalse();
	}
	@Test void deadlineUsesEndOfMoscowDay() {
		assertThat(TaskRules.deadline(LocalDate.of(2026,10,1))).isEqualTo(Instant.parse("2026-10-01T20:59:59.999Z"));
		assertThat(TaskRules.deadline(null)).isNull();
	}
}
