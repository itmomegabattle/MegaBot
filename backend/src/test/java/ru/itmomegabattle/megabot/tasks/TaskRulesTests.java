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
	@Test void everyStatusPairMatchesExplicitTransitionTable() {
		var allowed=java.util.Map.of("open",java.util.Set.of("assigned","cancelled"),
				"assigned",java.util.Set.of("open","in_progress","waiting","completed","cancelled"),
				"in_progress",java.util.Set.of("open","assigned","waiting","completed","cancelled"),
				"waiting",java.util.Set.of("open","assigned","in_progress","completed","cancelled"),
				"completed",java.util.Set.of("assigned","in_progress","waiting","cancelled"),"cancelled",java.util.Set.<String>of());
		for(var before:allowed.keySet()) for(var after:allowed.keySet()) {
			if("cancelled".equals(before)) assertThatThrownBy(()->TaskRules.transition(before,after)).isInstanceOf(ApiException.class);
			else if(before.equals(after)) assertThat(TaskRules.transition(before,after)).isFalse();
			else if(allowed.get(before).contains(after)) assertThat(TaskRules.transition(before,after)).isTrue();
			else assertThatThrownBy(()->TaskRules.transition(before,after)).isInstanceOf(ApiException.class);
		}
	}
}
