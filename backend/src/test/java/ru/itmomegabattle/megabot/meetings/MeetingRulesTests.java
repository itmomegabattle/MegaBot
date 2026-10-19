package ru.itmomegabattle.megabot.meetings;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.List;

import org.junit.jupiter.api.Test;

import ru.itmomegabattle.megabot.common.ApiException;

class MeetingRulesTests {

	private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-01T10:00:00Z"), ZoneOffset.UTC);

	@Test
	void setupUsesSelectedDurationEventAndWholeCoreTeam() {
		var normalized = MeetingRules.normalize(mutation("setup", LocalDate.parse("2026-10-05"), LocalTime.of(18, 0), 240,
				null, "evt_1"), CLOCK);

		assertThat(normalized.durationMinutes()).isEqualTo(240);
		assertThat(normalized.audienceMode()).isEqualTo("all");
		assertThat(normalized.eventId()).isEqualTo("evt_1");
	}

	@Test void setupDurationUsesWholeHoursAndMayCrossMidnight() {
		for (var duration : List.of(0, 15, 30, 45, 90, 361, 721, 780)) {
			assertThatThrownBy(() -> MeetingRules.normalize(mutation("setup", LocalDate.parse("2026-10-05"),
					LocalTime.of(18, 0), duration, "all", "evt_1"), CLOCK)).isInstanceOf(ApiException.class);
		}
		for (var hour = 1; hour <= 12; hour++) {
			var normalized = MeetingRules.normalize(mutation("setup", LocalDate.parse("2026-10-05"),
					LocalTime.of(23, 0), hour * 60, "all", "evt_1"), CLOCK);
			assertThat(normalized.durationMinutes()).isEqualTo(hour * 60);
		}
	}

	@Test
	void everyKindAcceptsEveryWeekdayAndTimeIncludingMidnightCrossing() {
		for (var kind : List.of("meeting", "setup", "vibe")) {
			for (var day = 0; day < 7; day++) {
				var date = LocalDate.parse("2026-10-05").plusDays(day);
				for (var time : List.of(LocalTime.MIDNIGHT, LocalTime.of(8, 15), LocalTime.of(23, 59))) {
					var normalized = MeetingRules.normalize(mutation(kind, date, time, 60, "all", "evt_1"), CLOCK);
					assertThat(normalized.startsAt()).isEqualTo(date.atTime(time).atZone(MeetingRules.PROJECT_ZONE).toInstant());
					assertThat(MeetingRules.phase(normalized.startsAt(), 60, "scheduled", normalized.startsAt().plusSeconds(3599))).isEqualTo("ongoing");
					assertThat(MeetingRules.phase(normalized.startsAt(), 60, "scheduled", normalized.startsAt().plusSeconds(3600))).isEqualTo("past");
				}
			}
		}
	}

	@Test void unrestrictedScheduleStillRejectsPastAndInvalidDurations() {
		for (var kind : List.of("meeting", "setup", "vibe")) {
			assertThatThrownBy(() -> MeetingRules.normalize(mutation(kind, LocalDate.parse("2026-09-30"),
					LocalTime.of(23, 59), 60, "all", "evt_1"), CLOCK)).isInstanceOf(ApiException.class).hasMessageContaining("прошлом");
		}
		for (var kind : List.of("meeting", "vibe")) {
			for (var duration : List.of(0, 29, 31, 361, 720)) {
				assertThatThrownBy(() -> MeetingRules.normalize(mutation(kind, LocalDate.parse("2026-10-04"),
						LocalTime.MIDNIGHT, duration, "all", null), CLOCK)).isInstanceOf(ApiException.class);
			}
		}
	}

	@Test
	void vibeMayCrossMidnightAndLifecycleUsesActualEnd() {
		var normalized = MeetingRules.normalize(
				mutation("vibe", LocalDate.parse("2026-10-04"), LocalTime.of(23, 30), 120, "all", null), CLOCK);
		var during = normalized.startsAt().plusSeconds(3600);

		assertThat(MeetingRules.phase(normalized.startsAt(), 120, "scheduled", during)).isEqualTo("ongoing");
		assertThat(MeetingRules.phase(normalized.startsAt(), 120, "scheduled", normalized.startsAt().plusSeconds(7200)))
				.isEqualTo("past");
	}

	@Test
	void initialRsvpStateIsNotInferredByRules() {
		assertThatThrownBy(() -> MeetingRules.normalize(
				mutation("setup", LocalDate.parse("2026-10-05"), LocalTime.of(18, 0), 60, "all", null), CLOCK))
				.isInstanceOf(ApiException.class)
				.hasMessageContaining("мероприятие");
	}

	private MeetingController.MeetingMutation mutation(
			String kind, LocalDate date, LocalTime time, int duration, String audience, String eventId) {
		return new MeetingController.MeetingMutation("Командная встреча", kind, eventId, date, time, duration,
				audience, null, List.of("u_1"), "Тема", "Описание", 0);
	}
}
