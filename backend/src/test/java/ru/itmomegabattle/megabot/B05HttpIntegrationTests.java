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
	void setupWholeHoursPersistOutsideSlotsAndCrossMidnight() throws Exception {
		jdbc.update("insert into work_events(id, name, status) values ('setup_event', 'Монтаж', 'active')");
		var date = LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.next(DayOfWeek.MONDAY));
		var body = json.writeValueAsString(Map.of("title", "Ночной монтаж", "kind", "setup", "eventId", "setup_event",
				"date", date.toString(), "time", "23:00", "durationMinutes", 720, "audienceMode", "all", "expectedVersion", 0));
		mvc.perform(post("/api/v1/meetings").cookie(cookieFor(host)).header("Origin", "http://localhost")
				.header("Idempotency-Key", "setup-twelve-hours").contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isCreated()).andExpect(jsonPath("$.durationMinutes").value(720));
		assertThat(jdbc.queryForObject("select duration_minutes from meetings where kind='setup'", Integer.class)).isEqualTo(720);
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

	@Test void everyKindCanBeCreatedAndMovedOutsideAvailabilityWithoutLosingRsvp() throws Exception {
		jdbc.update("insert into work_events(id,name,status) values ('anytime_event','Квиз','active')");
		jdbc.update("insert into app_settings(setting_key,setting_value) values ('availability',cast(? as jsonb))",
				"{\"activeDays\":[0],\"firstHour\":17,\"lastHour\":18}");
		var sunday=LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.next(DayOfWeek.SUNDAY));
		var cookie=cookieFor(host);
		for(var kind:List.of("meeting","setup","vibe")) {
			var body=new java.util.LinkedHashMap<String,Object>(Map.of("title","Свободное время "+kind,"kind",kind,
					"eventId","anytime_event","date",sunday.toString(),"time","00:00","durationMinutes",60,
					"audienceMode","all","expectedVersion",0));
			var created=mvc.perform(post("/api/v1/meetings").cookie(cookie).header("Origin","http://localhost")
					.header("Idempotency-Key","anytime-create-"+kind).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
					.andExpect(status().isCreated()).andExpect(jsonPath("$.kind").value(kind)).andReturn();
			var id=json.readTree(created.getResponse().getContentAsString()).path("id").asText();
			mvc.perform(post("/api/v1/meetings/{id}/rsvp",id).cookie(cookie).header("Origin","http://localhost")
					.contentType(MediaType.APPLICATION_JSON).content("{\"response\":\"yes\"}")).andExpect(status().isOk());
			body.put("date",sunday.plusDays(6).toString());body.put("time","23:59");
			body.put("durationMinutes",kind.equals("setup")?720:120);
			edit(id,body,cookie,"anytime-update-"+kind).andExpect(status().isOk()).andExpect(jsonPath("$.version").value(1));
			edit(id,body,cookie,"anytime-update-"+kind).andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
			assertThat(jdbc.queryForObject("select starts_at from meetings where id=?",java.sql.Timestamp.class,id).toInstant())
					.isEqualTo(sunday.plusDays(6).atTime(23,59).atZone(ZoneId.of("Europe/Moscow")).toInstant());
			assertThat(jdbc.queryForObject("select rsvp from meeting_invitations where meeting_id=? and user_id=?",String.class,id,host.getId())).isEqualTo("yes");
			assertThat(jdbc.queryForObject("select count(*) from integration_jobs where entity_id=?",Integer.class,id)).isEqualTo(2);
			assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_type='meeting' and entity_id=?",Integer.class,id)).isEqualTo(2);
			assertThat(jdbc.queryForObject("select (starts_at+duration_minutes*interval '1 minute') at time zone 'Europe/Moscow' > ((starts_at at time zone 'Europe/Moscow')::date+1) from meetings where id=?",Boolean.class,id)).isTrue();
			body.put("expectedVersion",1);body.put("date",sunday.minusWeeks(2).toString());
			edit(id,body,cookie,"anytime-past-"+kind).andExpect(status().isBadRequest());
			body.put("date",sunday.plusDays(6).toString());body.put("durationMinutes",kind.equals("setup")?90:31);
			edit(id,body,cookie,"anytime-invalid-duration-"+kind).andExpect(status().isBadRequest());
			assertThat(jdbc.queryForObject("select version from meetings where id=?",Long.class,id)).isEqualTo(1);
			assertThat(jdbc.queryForObject("select count(*) from integration_jobs where entity_id=?",Integer.class,id)).isEqualTo(2);
		}
		assertThat(jdbc.queryForObject("select setting_value->>'firstHour' from app_settings where setting_key='availability'",String.class)).isEqualTo("17");
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
	@Test void concurrentFirstAvailabilitySaveReturnsOneSuccessAndOneVersionConflict() throws Exception {
		var week=LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
		var cookie=cookieFor(host);var body=json.writeValueAsString(Map.of("outOfWeek",false,"expectedVersion",0,
				"days",List.of(Map.of("date",week.toString(),"status","available","startMinutes",List.of(1020)))));
		try(var pool=Executors.newFixedThreadPool(2)) {
			var go=new CountDownLatch(1);var work=(java.util.concurrent.Callable<Integer>)()->{go.await();return mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/api/v1/availability/weeks/{week}",week)
					.cookie(cookie).header("Origin","http://localhost").contentType(MediaType.APPLICATION_JSON).content(body)).andReturn().getResponse().getStatus();};
			var a=pool.submit(work);var b=pool.submit(work);go.countDown();
			assertThat(List.of(a.get(15,java.util.concurrent.TimeUnit.SECONDS),b.get(15,java.util.concurrent.TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,409);
		}
		assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(1L);
		assertThat(jdbc.queryForObject("select count(*) from availability_slots",Integer.class)).isEqualTo(1);
	}
	@Test void failedFirstAvailabilitySaveRollsBackAndSameVersionCanBeRetried() throws Exception {
		var week=LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
		var cookie=cookieFor(host);var body=json.writeValueAsString(Map.of("outOfWeek",false,"expectedVersion",0,
				"days",List.of(Map.of("date",week.toString(),"status","available","startMinutes",List.of(1020)))));
		jdbc.execute("alter table availability_slots add constraint fixture_slot_failure check(start_minute<>1020)");
		try {
			mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/api/v1/availability/weeks/{week}",week)
					.cookie(cookie).header("Origin","http://localhost").contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isConflict());
			assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
			assertThat(jdbc.queryForObject("select count(*) from availability_days",Integer.class)).isZero();
		}finally { jdbc.execute("alter table availability_slots drop constraint fixture_slot_failure"); }
		mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/api/v1/availability/weeks/{week}",week)
				.cookie(cookie).header("Origin","http://localhost").contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(1L);
	}
}
