package ru.itmomegabattle.megabot.availability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.ZoneId;
import java.util.List;

import org.junit.jupiter.api.Test;

import ru.itmomegabattle.megabot.common.ApiException;

class AvailabilityCalendarTests {

	@Test
	void rotatesExactlyAtMoscowMonday() {
		var before = serviceAt("2026-10-04T20:59:59Z");
		var after = serviceAt("2026-10-04T21:00:00Z");

		assertThat(before.horizon(2)).containsExactly(LocalDate.parse("2026-09-28"), LocalDate.parse("2026-10-05"));
		assertThat(after.horizon(2)).containsExactly(LocalDate.parse("2026-10-05"), LocalDate.parse("2026-10-12"));
	}

	@Test
	void horizonSkipsElapsedWeeksWithoutMovingStoredDates() {
		var initial = serviceAt("2026-10-05T00:00:00Z").horizon(4);
		var later = serviceAt("2026-10-26T00:00:00Z").horizon(4);

		assertThat(initial).containsExactly(
				LocalDate.parse("2026-10-05"), LocalDate.parse("2026-10-12"),
				LocalDate.parse("2026-10-19"), LocalDate.parse("2026-10-26"));
		assertThat(later).containsExactly(
				LocalDate.parse("2026-10-26"), LocalDate.parse("2026-11-02"),
				LocalDate.parse("2026-11-09"), LocalDate.parse("2026-11-16"));
	}

	@Test
	void settingsRejectInvalidHorizonAndHours() {
		assertThatThrownBy(() -> AvailabilitySettingsService.validate(1, List.of(0), 17, 23))
				.isInstanceOf(ApiException.class);
		assertThatThrownBy(() -> AvailabilitySettingsService.validate(4, List.of(0), 23, 17))
				.isInstanceOf(ApiException.class);
	}

	@Test
	void operatingSystemClockZoneDoesNotChangeProjectWeek() {
		var instant = Instant.parse("2026-10-04T21:30:00Z");
		var utc = new AvailabilityService(null, null, Clock.fixed(instant, ZoneOffset.UTC), null);
		var losAngeles = new AvailabilityService(null, null, Clock.fixed(instant, ZoneId.of("America/Los_Angeles")), null);

		assertThat(utc.horizon(2)).isEqualTo(losAngeles.horizon(2));
		assertThat(utc.horizon(2).getFirst()).isEqualTo(LocalDate.parse("2026-10-05"));
	}

	private AvailabilityService serviceAt(String instant) {
		return new AvailabilityService(null, null, Clock.fixed(Instant.parse(instant), ZoneOffset.UTC), null);
	}
}
