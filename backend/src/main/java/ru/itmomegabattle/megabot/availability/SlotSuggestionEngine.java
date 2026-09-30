package ru.itmomegabattle.megabot.availability;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class SlotSuggestionEngine {

	private SlotSuggestionEngine() {
	}

	static List<Suggestion> suggest(
			List<Participant> participants,
			List<LocalDate> dates,
			int durationMinutes,
			int firstHour,
			int lastHour) {
		var requiredHours = (int) Math.ceil(durationMinutes / 60.0);
		var suggestions = new ArrayList<Suggestion>();
		for (var date : dates.stream().sorted().toList()) {
			for (var start = firstHour * 60; start + durationMinutes <= (lastHour + 1) * 60; start += 60) {
				var required = new ArrayList<Integer>();
				for (var offset = 0; offset < requiredHours; offset++) required.add(start + offset * 60);
				var can = new ArrayList<Person>();
				var cannot = new ArrayList<UnavailablePerson>();
				for (var person : participants) {
					var view = new Person(person.id(), person.realName(), person.username());
					var day = person.days().get(date);
					if (!person.outOfWeek() && day != null && "available".equals(day.status())
							&& day.startMinutes().containsAll(required)) {
						can.add(view);
					} else {
						var reason = person.outOfWeek() ? "out"
								: day == null || "unanswered".equals(day.status()) ? "not_marked" : "inconvenient";
						cannot.add(new UnavailablePerson(person.id(), person.realName(), person.username(), reason));
					}
				}
				if (!can.isEmpty()) {
					suggestions.add(new Suggestion(date, start, start + durationMinutes, durationMinutes,
							can.size(), participants.size(), List.copyOf(can), List.copyOf(cannot)));
				}
			}
		}
		return suggestions.stream()
				.sorted(Comparator.comparingInt(Suggestion::count).reversed()
						.thenComparing(Suggestion::date).thenComparingInt(Suggestion::startMinute))
				.limit(5)
				.toList();
	}

	record Participant(String id, String realName, String username, boolean outOfWeek, Map<LocalDate, Day> days) {}
	record Day(String status, Set<Integer> startMinutes) {}
	record Person(String id, String realName, String username) {}
	record UnavailablePerson(String id, String realName, String username, String reason) {}
	record Suggestion(LocalDate date, int startMinute, int endMinute, int durationMinutes, int count, int total,
			List<Person> canUsers, List<UnavailablePerson> cannotUsers) {}
}
