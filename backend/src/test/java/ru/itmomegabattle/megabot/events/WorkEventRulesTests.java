package ru.itmomegabattle.megabot.events;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;

import org.junit.jupiter.api.Test;

import ru.itmomegabattle.megabot.common.ApiException;

class WorkEventRulesTests {

	@Test
	void rejectsBackwardsIntervalButAllowsOpenDates() {
		var start = Instant.parse("2026-10-10T12:00:00Z");
		var end = Instant.parse("2026-10-10T11:59:59Z");

		assertThatThrownBy(() -> WorkEventService.validateInterval(start, end)).isInstanceOf(ApiException.class);
		assertThatCode(() -> WorkEventService.validateInterval(null, end)).doesNotThrowAnyException();
	}
}
