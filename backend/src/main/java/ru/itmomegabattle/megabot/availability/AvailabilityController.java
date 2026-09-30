package ru.itmomegabattle.megabot.availability;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;

@RestController
@RequestMapping("/api/v1/availability")
class AvailabilityController {

	private final AvailabilityService availability;
	private final AvailabilitySettingsService settings;

	AvailabilityController(AvailabilityService availability, AvailabilitySettingsService settings) {
		this.availability = availability;
		this.settings = settings;
	}

	@GetMapping
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	AvailabilityResponse get(
			@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestParam(required = false) String userId) {
		return availability.get(actor, userId);
	}

	@PutMapping("/weeks/{weekStart}")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	WeekView save(
			@PathVariable LocalDate weekStart,
			@RequestParam(required = false) String userId,
			@AuthenticationPrincipal AuthenticatedUser actor,
			@Valid @RequestBody SaveWeekRequest request) {
		return availability.saveWeek(actor, userId, weekStart, request);
	}

	@PatchMapping("/weeks/{weekStart}/metadata")
	@PreAuthorize("hasRole('ADMIN')")
	WeekMetadataView metadata(@PathVariable LocalDate weekStart, @Valid @RequestBody MetadataMutation request) {
		return availability.saveMetadata(weekStart, request);
	}

	@PatchMapping("/settings")
	@PreAuthorize("hasRole('ADMIN')")
	SettingsView settings(@Valid @RequestBody SettingsMutation request) {
		return SettingsView.from(settings.update(request));
	}

	@PostMapping("/suggestions")
	@PreAuthorize("hasAnyRole('ADMIN', 'ORGANIZER')")
	List<SlotSuggestionEngine.Suggestion> suggestions(@Valid @RequestBody SuggestionRequest request) {
		return availability.suggestions(request);
	}

	record AvailabilityResponse(String userId, Instant serverNow, String timeZone, SettingsView settings, List<WeekView> weeks) {}
	record SettingsView(int weekCount, List<Integer> activeDays, int firstHour, int lastHour, long version) {
		static SettingsView from(AvailabilitySettings settings) {
			return new SettingsView(settings.weekCount(), settings.activeDays(), settings.firstHour(), settings.lastHour(), settings.version());
		}
	}
	record SettingsMutation(
			@Min(2) @Max(5) int weekCount,
			@NotNull @Size(min = 1, max = 7) List<Integer> activeDays,
			@Min(0) @Max(23) int firstHour,
			@Min(0) @Max(23) int lastHour,
			@Min(0) long expectedVersion) {}
	record SaveWeekRequest(boolean outOfWeek, @NotNull List<@Valid DayMutation> days, @Min(0) long expectedVersion) {}
	record DayMutation(@NotNull LocalDate date, @NotNull String status, @NotNull List<Integer> startMinutes) {}
	record WeekView(LocalDate weekStart, String title, String description, boolean outOfWeek, long version, List<DayView> days) {}
	record DayView(LocalDate date, String status, List<Integer> startMinutes) {}
	record MetadataMutation(@Size(max = 120) String title, @Size(max = 1000) String description) {}
	record WeekMetadataView(LocalDate weekStart, String title, String description) {}
	record SuggestionRequest(
			@NotNull LocalDate weekStart,
			@NotNull @Size(min = 1, max = 7) List<@NotNull LocalDate> dates,
			@Min(30) @Max(360) int durationMinutes) {}
}
