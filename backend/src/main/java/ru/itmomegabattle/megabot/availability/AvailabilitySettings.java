package ru.itmomegabattle.megabot.availability;

import java.util.List;

record AvailabilitySettings(int weekCount, List<Integer> activeDays, int firstHour, int lastHour, long version) {

	static AvailabilitySettings defaults() {
		return new AvailabilitySettings(4, List.of(0, 1, 2, 3, 4), 17, 23, 0);
	}
}
