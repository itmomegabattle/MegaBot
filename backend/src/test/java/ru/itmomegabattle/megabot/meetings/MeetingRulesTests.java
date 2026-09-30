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
	private static final MeetingRules.SlotPolicy POLICY = new MeetingRules.SlotPolicy(List.of(0, 1, 2, 3, 4), 17, 23);

	@Test
	void setupAlwaysUsesEventOneHourAndWholeCoreTeam() {
		var normalized = MeetingRules.normalize(mutation("setup", LocalDate.parse("2026-10-05"), LocalTime.of(18, 0), 0,
				null, "evt_1"), POLICY, CLOCK);

		assertThat(normalized.durationMinutes()).isEqualTo(60);
		assertThat(normalized.audienceMode()).isEqualTo("all");
		assertThat(normalized.eventId()).isEqualTo("evt_1");
	}

	@Test
	void workMeetingMustFitEnabledDayAndHours() {
		assertThatThrownBy(() -> MeetingRules.normalize(
				mutation("meeting", LocalDate.parse("2026-10-04"), LocalTime.of(18, 0), 60, "all", null), POLICY, CLOCK))
				.isInstanceOf(ApiException.class);
		assertThatThrownBy(() -> MeetingRules.normalize(
				mutation("meeting", LocalDate.parse("2026-10-05"), LocalTime.of(23, 30), 60, "all", null), POLICY, CLOCK))
				.isInstanceOf(ApiException.class);
	}

	@Test
	void vibeMayCrossMidnightAndLifecycleUsesActualEnd() {
		var normalized = MeetingRules.normalize(
				mutation("vibe", LocalDate.parse("2026-10-04"), LocalTime.of(23, 30), 120, "all", null), POLICY, CLOCK);
		var during = normalized.startsAt().plusSeconds(3600);

		assertThat(MeetingRules.phase(normalized.startsAt(), 120, "scheduled", during)).isEqualTo("ongoing");
		assertThat(MeetingRules.phase(normalized.startsAt(), 120, "scheduled", normalized.startsAt().plusSeconds(7200)))
				.isEqualTo("past");
	}

	@Test
	void initialRsvpStateIsNotInferredByRules() {
		assertThatThrownBy(() -> MeetingRules.normalize(
				mutation("setup", LocalDate.parse("2026-10-05"), LocalTime.of(18, 0), 60, "all", null), POLICY, CLOCK))
				.isInstanceOf(ApiException.class)
				.hasMessageContaining("мероприятие");
	}

	private MeetingController.MeetingMutation mutation(
			String kind, LocalDate date, LocalTime time, int duration, String audience, String eventId) {
		return new MeetingController.MeetingMutation("Командная встреча", kind, eventId, date, time, duration,
				audience, null, List.of("u_1"), "Тема", "Описание", 0);
	}
}
