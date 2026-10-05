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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;

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
		jdbc.execute("TRUNCATE TABLE users, app_settings, availability_week_metadata, chat_bindings, outbox_events, integration_jobs, idempotency_requests, audit_events CASCADE");
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
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select count(*) from outbox_events", Long.class)).isEqualTo(2);
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select count(*) from integration_jobs", Long.class)).isEqualTo(1);
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_type='meeting'", Long.class)).isEqualTo(1);
		org.assertj.core.api.Assertions.assertThat(jdbc.queryForObject("select payload::text from outbox_events where event_type='meeting.created'", String.class))
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

	private Map<String,Object> mutation(long version) {
		var date=LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.next(DayOfWeek.MONDAY));
		return new java.util.LinkedHashMap<>(Map.of("title","Изменённая встреча","kind","vibe","date",date.toString(),"time","23:30",
				"durationMinutes",120,"audienceMode","selected","selectedUserIds",List.of(host.getId()),"expectedVersion",version,"topic","Тема","description","Полный текст"));
	}
	private org.springframework.test.web.servlet.ResultActions edit(String id,Map<String,Object> body,Cookie actor,String key) throws Exception {
		return mvc.perform(patch("/api/v1/meetings/{id}",id).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key",key)
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)));
	}
	@Test void concurrentUpdatesHaveOneWinnerAndReplayPreservesFullNightMeeting() throws Exception {
		var id=insertMeeting();var cookie=cookieFor(host);var body=mutation(0);var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return edit(id,body,cookie,"meeting-race-one").andReturn().getResponse().getStatus();});
			var b=pool.submit(()->{gate.await();return edit(id,body,cookie,"meeting-race-two").andReturn().getResponse().getStatus();});gate.countDown();
			var first=a.get();var second=b.get();assertThat(List.of(first,second)).containsExactlyInAnyOrder(200,409);
			edit(id,body,cookie,first==200?"meeting-race-one":"meeting-race-two").andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		}
		assertThat(jdbc.queryForObject("select version from meetings where id=?",Long.class,id)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from integration_jobs",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select payload::text from outbox_events where event_type='meeting.updated'",String.class)).contains("Полный текст","Тема","vibe");
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where event_type='meeting.reminder'",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select changes::text from audit_events where action='updated'",String.class)).contains("before","after","Полный текст");
		assertThat(jdbc.queryForObject("select (starts_at+duration_minutes*interval '1 minute') at time zone 'Europe/Moscow' > ((starts_at at time zone 'Europe/Moscow')::date+1) from meetings where id=?",Boolean.class,id)).isTrue();
	}
	@Test void meetingCommandFailureRollsBackDomainInvitationsAuditJobsAndIdempotency() throws Exception {
		var cookie=cookieFor(host);var body=mutation(0);
		jdbc.execute("alter table integration_jobs add constraint meeting_job_failure check (provider<>'google_calendar') not valid");
		try {
			mvc.perform(post("/api/v1/meetings").cookie(cookie).header("Origin","http://localhost").header("Idempotency-Key","meeting-create-rollback")
					.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isConflict());
		}finally { jdbc.execute("alter table integration_jobs drop constraint meeting_job_failure"); }
		for(var table:List.of("meetings","meeting_invitations","audit_events","outbox_events","integration_jobs","idempotency_requests"))
			assertThat(jdbc.queryForObject("select count(*) from "+table,Long.class)).as(table).isZero();
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
