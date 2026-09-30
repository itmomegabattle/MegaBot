package ru.itmomegabattle.megabot.availability;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

class SlotSuggestionEngineTests {

	@Test
	void ranksWindowsAndExplainsEveryUnavailablePerson() {
		var date = LocalDate.parse("2026-10-05");
		var participants = List.of(
				person("u1", false, date, "available", Set.of(1020, 1080)),
				person("u2", true, date, "available", Set.of(1020, 1080)),
				person("u3", false, date, "unanswered", Set.of()),
				person("u4", false, date, "available", Set.of(1020)));

		var result = SlotSuggestionEngine.suggest(participants, List.of(date), 90, 17, 19);

		assertThat(result).isNotEmpty();
		assertThat(result.getFirst().startMinute()).isEqualTo(1020);
		assertThat(result.getFirst().endMinute()).isEqualTo(1110);
		assertThat(result.getFirst().canUsers()).extracting(SlotSuggestionEngine.Person::id).containsExactly("u1");
		assertThat(result.getFirst().cannotUsers())
				.extracting(SlotSuggestionEngine.UnavailablePerson::reason)
				.containsExactly("out", "not_marked", "inconvenient");
	}

	@Test
	void excludesWindowsWhereNobodyCanAttend() {
		var date = LocalDate.parse("2026-10-05");
		var participants = List.of(person("u1", false, date, "unavailable", Set.of()));

		assertThat(SlotSuggestionEngine.suggest(participants, List.of(date), 60, 17, 18)).isEmpty();
	}

	private SlotSuggestionEngine.Participant person(
			String id, boolean out, LocalDate date, String status, Set<Integer> minutes) {
		return new SlotSuggestionEngine.Participant(id, id, id, out,
				Map.of(date, new SlotSuggestionEngine.Day(status, minutes)));
	}
}
