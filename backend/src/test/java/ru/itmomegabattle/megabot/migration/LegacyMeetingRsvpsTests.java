package ru.itmomegabattle.megabot.migration;

import static org.assertj.core.api.Assertions.*;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class LegacyMeetingRsvpsTests {
	private final ObjectMapper json = new ObjectMapper();
	private final List<String> audience = List.of("host", "yes", "no", "silent");
	private final Set<String> users = Set.copyOf(audience);

	@Test void explicitResponseWinsAndMissingNeverBecomesRefusalOrHostAcceptance() {
		var source = json.readTree("{\"attendeeIds\":[\"yes\",\"no\"],\"rsvpByUser\":{\"no\":\"no\"}}");
		var first = LegacyMeetingRsvps.plan(source, audience, users);
		assertThat(first).extracting(LegacyMeetingRsvps.Invitation::response).containsExactly("unanswered", "yes", "no", "unanswered");
		assertThat(first).allMatch(LegacyMeetingRsvps.Invitation::legacySource);
		assertThat(LegacyMeetingRsvps.plan(source, audience, users)).isEqualTo(first);
		assertThat(source.path("attendeeIds").size()).isEqualTo(2);
	}

	@Test void absentResponsesStayUnansweredAndResultIsImmutable() {
		var result = LegacyMeetingRsvps.plan(json.readTree("{}"), audience, users);
		assertThat(result).allMatch(row -> row.response().equals("unanswered"));
		assertThatThrownBy(() -> result.clear()).isInstanceOf(UnsupportedOperationException.class);
	}

	@Test void malformedUnknownAndDuplicateResponsesAreRejectedInsteadOfDropped() {
		for (var source : List.of("{\"attendeeIds\":null}", "{\"attendeeIds\":{}}", "{\"attendeeIds\":[1]}",
				"{\"attendeeIds\":[\"gone\"]}", "{\"attendeeIds\":[\"yes\",\"yes\"]}",
				"{\"rsvpByUser\":null}", "{\"rsvpByUser\":[]}", "{\"rsvpByUser\":{\"gone\":\"yes\"}}",
				"{\"rsvpByUser\":{\"yes\":\"unanswered\"}}", "{\"rsvpByUser\":{\"yes\":true}}")) {
			assertThatThrownBy(() -> LegacyMeetingRsvps.plan(json.readTree(source), audience, users))
					.as(source).isInstanceOf(IllegalArgumentException.class);
		}
	}

	@Test void missingOrDuplicateAudienceCannotBeInventedFromCurrentUsers() {
		for (var ids : List.of(List.of("gone"), List.of("host", "host"), List.of(""))) {
			assertThatThrownBy(() -> LegacyMeetingRsvps.plan(json.readTree("{}"), ids, users))
					.isInstanceOf(IllegalArgumentException.class);
		}
		assertThatThrownBy(() -> LegacyMeetingRsvps.plan(json.readTree("[]"), audience, users))
				.isInstanceOf(IllegalArgumentException.class);
	}
}
