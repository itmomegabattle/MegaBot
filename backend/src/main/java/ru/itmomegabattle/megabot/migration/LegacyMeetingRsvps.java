package ru.itmomegabattle.megabot.migration;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import tools.jackson.databind.JsonNode;

/** Offline projection only: audience must already be resolved from the source snapshot. */
public final class LegacyMeetingRsvps {

	private LegacyMeetingRsvps() {}

	public record Invitation(String userId, String response, boolean legacySource) {}

	public static List<Invitation> plan(JsonNode meeting, List<String> audience, Set<String> sourceUserIds) {
		if (meeting == null || !meeting.isObject() || audience == null || sourceUserIds == null)
			throw reject("invalid_legacy_meeting");
		var members = new HashSet<String>();
		for (var id : audience) {
			if (id == null || id.isBlank() || !sourceUserIds.contains(id)) throw reject("missing_audience_user");
			if (!members.add(id)) throw reject("duplicate_audience_user");
		}
		var responses = new HashMap<String, String>();
		var explicit = meeting.path("rsvpByUser");
		if (!explicit.isMissingNode()) {
			if (!explicit.isObject()) throw reject("invalid_legacy_rsvps");
			for (var entry : explicit.properties()) {
				if (!members.contains(entry.getKey())) throw reject("rsvp_outside_audience");
				if (!entry.getValue().isTextual() || !Set.of("yes", "no").contains(entry.getValue().asText()))
					throw reject("invalid_legacy_response");
				responses.put(entry.getKey(), entry.getValue().asText());
			}
		}
		var attendees = meeting.path("attendeeIds");
		if (!attendees.isMissingNode()) {
			if (!attendees.isArray()) throw reject("invalid_legacy_attendees");
			var seen = new HashSet<String>();
			for (var value : attendees) {
				if (!value.isTextual() || !members.contains(value.asText())) throw reject("attendee_outside_audience");
				if (!seen.add(value.asText())) throw reject("duplicate_legacy_attendee");
				responses.putIfAbsent(value.asText(), "yes");
			}
		}
		var result = new ArrayList<Invitation>();
		for (var id : audience) result.add(new Invitation(id, responses.getOrDefault(id, "unanswered"), true));
		return List.copyOf(result);
	}

	private static IllegalArgumentException reject(String code) { return new IllegalArgumentException(code); }
}
