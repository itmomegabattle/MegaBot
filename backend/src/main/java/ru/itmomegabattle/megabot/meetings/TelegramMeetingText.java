package ru.itmomegabattle.megabot.meetings;

import java.time.format.DateTimeFormatter;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.team.UserEntity;

/** The legacy core menu lists team meetings; invitations separately authorize RSVP. */
@Service
public class TelegramMeetingText {

	private final MeetingService meetings;

	TelegramMeetingText(MeetingService meetings) { this.meetings = meetings; }

	@Transactional(readOnly = true)
	public String render(UserEntity user) {
		if (!user.isActive() || !user.isRegistered()
				|| !("admin".equals(user.getRole()) || "organizer".equals(user.getRole()))) {
			throw new ApiException(HttpStatus.FORBIDDEN, "core_required", "Встречи доступны только организаторам и администратору.");
		}
		var upcoming = meetings.list().stream()
				.filter(m -> "scheduled".equals(m.status()) && !"past".equals(m.phase()))
				.limit(8).toList();
		if (upcoming.isEmpty()) return "Встречи\n\nБлижайших встреч нет.";
		var text = new StringBuilder("Ближайшие встречи");
		for (int i = 0; i < upcoming.size(); i++) {
			var meeting = upcoming.get(i);
			text.append("\n\n").append(i + 1).append(". ").append(bounded(meeting.title(), 160))
					.append('\n').append(meeting.startsAt().atZone(MeetingRules.PROJECT_ZONE)
							.format(DateTimeFormatter.ofPattern("dd.MM.yyyy, HH:mm")));
			if (meeting.topic() != null && !meeting.topic().isBlank()) text.append('\n').append(bounded(meeting.topic(), 250));
		}
		return text.toString();
	}

	private static String bounded(String text, int max) {
		return text.length() > max ? text.substring(0, max) + "…" : text;
	}
}
