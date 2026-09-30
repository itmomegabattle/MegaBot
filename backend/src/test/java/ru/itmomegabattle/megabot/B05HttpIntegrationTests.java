package ru.itmomegabattle.megabot;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.TemporalAdjusters;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Testcontainers;

import jakarta.servlet.http.Cookie;
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.team.UserEntity;
import ru.itmomegabattle.megabot.team.UserRepository;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker = true)
class B05HttpIntegrationTests {

	@Autowired MockMvc mvc;
	@Autowired JdbcTemplate jdbc;
	@Autowired UserRepository users;
	@Autowired SessionService sessions;
	@Autowired ObjectMapper json;

	private UserEntity admin;
	private UserEntity host;
	private UserEntity otherOrganizer;
	private UserEntity faculty;

	@BeforeEach
	void prepare() {
		jdbc.execute("TRUNCATE TABLE users, app_settings, availability_week_metadata, chat_bindings CASCADE");
		admin = users.saveAndFlush(new UserEntity(201L, "meeting_admin", "Admin", "admin"));
		host = users.saveAndFlush(new UserEntity(202L, "meeting_host", "Host", "organizer"));
		otherOrganizer = users.saveAndFlush(new UserEntity(203L, "meeting_other", "Other", "organizer"));
		faculty = users.saveAndFlush(new UserEntity(204L, "meeting_faculty", "Faculty", "faculty_helper"));
	}

	@Test
	void createIsIdempotentAndCommitsMeetingAuditAndJobsTogether() throws Exception {
		jdbc.update("insert into chat_bindings(id, bot_id, chat_id, type, important_thread_id) values ('binding_1', 'main', -1001, 'important', 777)");
		var date = LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.next(DayOfWeek.MONDAY));
		var body = json.writeValueAsString(Map.of(
				"title", "Планирование", "kind", "meeting", "date", date.toString(), "time", "18:00",
				"durationMinutes", 60, "audienceMode", "all", "selectedUserIds", List.of(), "expectedVersion", 0));
		var first = mvc.perform(post("/api/v1/meetings").cookie(cookieFor(host)).header("Origin", "http://localhost")
				.header("Idempotency-Key", "meeting-create-001").contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.invitations.length()").value(3))
				.andExpect(jsonPath("$.invitations[0].response").value("unanswered"))
				.andReturn();
		var meetingId = json.readTree(first.getResponse().getContentAsString()).path("id").asText();

		mvc.perform(post("/api/v1/meetings").cookie(cookieFor(host)).header("Origin", "http://localhost")
				.header("Idempotency-Key", "meeting-create-001").contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isCreated()).andExpect(header().string("Idempotency-Replayed", "true"))
				.andExpect(jsonPath("$.id").value(meetingId));
		mvc.perform(get("/api/state").cookie(cookieFor(host)))
				.andExpect(status().isOk()).andExpect(jsonPath("$.meetings[0].id").value(meetingId))
				.andExpect(jsonPath("$.meetings[0].audiencePolicy").value("snapshot"))
				.andExpect(jsonPath("$.meetings[0].audienceUserIds.length()").value(3));
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select count(*) from meetings", Long.class)).isEqualTo(1);
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select count(*) from outbox_events", Long.class)).isEqualTo(1);
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select count(*) from integration_jobs", Long.class)).isEqualTo(1);
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_type='meeting'", Long.class)).isEqualTo(1);
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select payload::text from outbox_events", String.class))
				.contains("messageThreadId").contains("777").contains("Планирование");
	}

	@Test
	void onlyHostOrAdminMayChangeMeetingAndOnlyInviteeMayRsvp() throws Exception {
		var meetingId = insertMeeting();
		mvc.perform(post("/api/v1/meetings/{id}/cancel", meetingId).cookie(cookieFor(otherOrganizer))
				.header("Origin", "http://localhost").header("Idempotency-Key", "cancel-other-01")
				.contentType(MediaType.APPLICATION_JSON).content("{\"expectedVersion\":0}"))
				.andExpect(status().isForbidden());
		mvc.perform(post("/api/v1/meetings/{id}/rsvp", meetingId).cookie(cookieFor(host))
				.header("Origin", "http://localhost").contentType(MediaType.APPLICATION_JSON).content("{\"response\":\"yes\"}"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.changed").value(true));
		mvc.perform(post("/api/v1/meetings/{id}/rsvp", meetingId).cookie(cookieFor(faculty))
				.header("Origin", "http://localhost").contentType(MediaType.APPLICATION_JSON).content("{\"response\":\"yes\"}"))
				.andExpect(status().isForbidden());
		mvc.perform(post("/api/v1/meetings/{id}/cancel", meetingId).cookie(cookieFor(admin))
				.header("Origin", "http://localhost").header("Idempotency-Key", "cancel-admin-01")
				.contentType(MediaType.APPLICATION_JSON).content("{\"expectedVersion\":0}"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"));
	}

	private String insertMeeting() {
		jdbc.update("""
				insert into meetings(id, kind, title, starts_at, duration_minutes, zone_id, host_id, audience_mode, status)
				values ('mtg_test', 'meeting', 'Test', now() + interval '1 day', 60, 'Europe/Moscow', ?, 'selected', 'scheduled')
				""", host.getId());
		jdbc.update("insert into meeting_invitations(meeting_id, user_id) values ('mtg_test', ?)", host.getId());
		return "mtg_test";
	}

	private Cookie cookieFor(UserEntity user) {
		return new Cookie("megabot_session", sessions.rotateFor(user.getId()).rawToken());
	}
}
