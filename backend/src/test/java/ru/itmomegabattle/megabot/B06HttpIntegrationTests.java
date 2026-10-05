package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
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
@Testcontainers(disabledWithoutDocker=true)
class B06HttpIntegrationTests {
	@Autowired MockMvc mvc;
	@Autowired JdbcTemplate jdbc;
	@Autowired UserRepository users;
	@Autowired SessionService sessions;
	@Autowired ObjectMapper json;
	UserEntity author, first, second, faculty;
	Cookie authorCookie, firstCookie, secondCookie, facultyCookie;
	@BeforeEach void prepare() {
		jdbc.execute("TRUNCATE TABLE users, faculties, work_events, competencies, outbox_events, idempotency_requests, audit_events CASCADE");
		author=users.saveAndFlush(new UserEntity(301L,"task_author","Author","organizer"));
		first=users.saveAndFlush(new UserEntity(302L,"task_first","First","organizer"));
		second=users.saveAndFlush(new UserEntity(303L,"task_second","Second","organizer"));
		faculty=users.saveAndFlush(new UserEntity(304L,"task_faculty","Faculty","faculty_helper"));
		authorCookie=cookie(author); firstCookie=cookie(first); secondCookie=cookie(second); facultyCookie=cookie(faculty);
	}
	@Test void twoConcurrentClaimsHaveOneWinner() throws Exception {
		var id=create(List.of());
		var start=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return command(id,"claim",firstCookie,"claim-first-001","{\"expectedVersion\":0}");});
			var b=pool.submit(()->{start.await();return command(id,"claim",secondCookie,"claim-second-001","{\"expectedVersion\":0}");});
			start.countDown();
			assertThat(List.of(a.get(),b.get())).containsExactlyInAnyOrder(200,409);
		}
		assertThat(jdbc.queryForObject("select count(*) from task_assignees where task_id=?",Long.class,id)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select version from tasks where id=?",Long.class,id)).isEqualTo(1);
	}
	@Test void partialReleaseKeepsColleagueAndSharedCompletionNamesActor() throws Exception {
		var id=create(List.of(first.getId(),second.getId()));
		assertThat(command(id,"release",firstCookie,"release-first-001","{\"expectedVersion\":0}")).isEqualTo(200);
		assertThat(jdbc.queryForList("select user_id from task_assignees where task_id=?",String.class,id)).containsExactly(second.getId());
		assertThat(command(id,"status",secondCookie,"complete-second-001","{\"expectedVersion\":1,\"status\":\"completed\",\"timeSpentMinutes\":30}")).isEqualTo(200);
		assertThat(jdbc.queryForObject("select completed_by from tasks where id=?",String.class,id)).isEqualTo(second.getId());
		var payload=json.readTree(jdbc.queryForObject("select payload::text from outbox_events where event_type='task.status'",String.class));
		assertThat(payload.path("disableNotification").asBoolean()).isTrue();
		assertThat(payload.path("audienceUserIds").get(0).asText()).isEqualTo(author.getId());
		assertThat(payload.path("audienceUserIds").size()).isEqualTo(1);
	}
	@Test void completionClosesCommentsAndCancellationCannotBeReopened() throws Exception {
		var id=create(List.of(first.getId()));
		assertThat(command(id,"status",firstCookie,"complete-first-001","{\"expectedVersion\":0,\"status\":\"completed\"}")).isEqualTo(200);
		assertThat(command(id,"comments",firstCookie,"comment-closed-001","{\"expectedVersion\":1,\"side\":\"executor\",\"text\":\"Поздно\"}")).isEqualTo(409);
		assertThat(command(id,"status",firstCookie,"reopen-first-001","{\"expectedVersion\":1,\"status\":\"in_progress\"}")).isEqualTo(200);
		assertThat(command(id,"cancel",authorCookie,"cancel-author-001","{\"expectedVersion\":2}")).isEqualTo(200);
		assertThat(command(id,"status",firstCookie,"reopen-cancelled-001","{\"expectedVersion\":3,\"status\":\"in_progress\"}")).isEqualTo(409);
	}
	@Test void facultyCannotReadOrMutateCoreTasks() throws Exception {
		var id=create(List.of(first.getId()));
		mvc.perform(get("/api/v1/tasks/{id}",id).cookie(facultyCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/tasks").cookie(facultyCookie)).andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
		assertThat(command(id,"status",facultyCookie,"faculty-denied-001","{\"expectedVersion\":0,\"status\":\"completed\"}")).isEqualTo(403);
		assertThat(command(id,"cancel",secondCookie,"other-denied-001","{\"expectedVersion\":0}")).isEqualTo(403);
	}
	@Test void duplicateCreateIsReplayedWithoutDuplicatedEffects() throws Exception {
		var id=create(List.of());
		mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","task-create-001").contentType(MediaType.APPLICATION_JSON).content(body(List.of())))
				.andExpect(status().isCreated()).andExpect(header().string("Idempotency-Replayed","true")).andExpect(jsonPath("$.id").value(id));
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events",Long.class)).isEqualTo(1);
	}
	@Test void twentyConcurrentCreatesKeepEveryTask() throws Exception {
		var start=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(20)) {
			var jobs=new java.util.ArrayList<java.util.concurrent.Future<Integer>>();
			for(int index=0;index<20;index++) {
				var key="parallel-create-"+index;
				jobs.add(pool.submit(()->{start.await();return mvc.perform(post("/api/v1/tasks").cookie(authorCookie)
						.header("Origin","http://localhost").header("Idempotency-Key",key)
						.contentType(MediaType.APPLICATION_JSON).content(body(List.of()))).andReturn().getResponse().getStatus();}));
			}
			start.countDown();
			for(var job:jobs) assertThat(job.get()).isEqualTo(201);
		}
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isEqualTo(20);
		assertThat(jdbc.queryForObject("select count(*) from task_status_history",Long.class)).isEqualTo(20);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events",Long.class)).isEqualTo(20);
	}
	@Test void invalidCalendarDateDoesNotCreateTask() throws Exception {
		mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","invalid-date-001").contentType(MediaType.APPLICATION_JSON)
				.content("{\"title\":\"Test task\",\"priority\":\"normal\",\"deadline\":\"2026-02-30\"}"))
				.andExpect(status().isBadRequest());
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isZero();
	}
	@Test void facultyReadsOnlyOwnScopedTaskAndOwnNotes() throws Exception {
		jdbc.update("insert into faculties(id,name) values ('fac_task','Task faculty')");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values (?,'fac_task','helper')",faculty.getId());
		var result=mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","faculty-task-create-001").contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("title","Faculty task","priority","normal","facultyId","fac_task","assigneeIds",List.of(faculty.getId())))))
				.andExpect(status().isCreated()).andReturn().getResponse();
		var id=json.readTree(result.getContentAsString()).path("id").asText();
		jdbc.update("insert into task_comments(id,task_id,author_id,target_assignee_id,side,text) values ('own_note',?,?,?,'coordinator','Own note')",id,author.getId(),faculty.getId());
		jdbc.update("insert into task_comments(id,task_id,author_id,target_assignee_id,side,text) values ('other_note',?,?,?,'coordinator','Other note')",id,author.getId(),first.getId());
		mvc.perform(get("/api/v1/faculty/my-tasks").cookie(facultyCookie)).andExpect(status().isOk())
				.andExpect(jsonPath("$.length()").value(1)).andExpect(jsonPath("$[0].comments.length()").value(1))
				.andExpect(jsonPath("$[0].comments[0].text").value("Own note"));
		mvc.perform(get("/api/faculty/my-tasks").cookie(facultyCookie)).andExpect(status().isOk())
				.andExpect(jsonPath("$.timeZone").value("Europe/Moscow"))
				.andExpect(jsonPath("$.tasks.length()").value(1)).andExpect(jsonPath("$.tasks[0].comments.length()").value(1));
		assertThat(command(id,"status",facultyCookie,"faculty-complete-001","{\"expectedVersion\":0,\"status\":\"completed\"}")).isEqualTo(200);
	}
	@Test void commentReplayDoesNotAppendTwice() throws Exception {
		var id=create(List.of(first.getId()));
		var body="{\"expectedVersion\":0,\"side\":\"executor\",\"text\":\"Первый комментарий\"}";
		assertThat(command(id,"comments",firstCookie,"append-comment-001",body)).isEqualTo(201);
		assertThat(command(id,"comments",firstCookie,"append-comment-001",body)).isEqualTo(201);
		assertThat(jdbc.queryForObject("select count(*) from task_comments where task_id=?",Long.class,id)).isEqualTo(1);
		assertThat(command(id,"comments",firstCookie,"stale-comment-001",body)).isEqualTo(409);
	}
	@Test void outboxFailureRollsBackTaskHistoryAuditAndIdempotency() throws Exception {
		jdbc.execute("""
				create function reject_task_outbox() returns trigger language plpgsql as $$
				begin raise exception 'test failure' using errcode='23514'; end; $$
				""");
		jdbc.execute("create trigger reject_task_outbox before insert on outbox_events for each row when (new.aggregate_type='task') execute function reject_task_outbox()");
		try {
			mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
					.header("Idempotency-Key","rollback-create-001").contentType(MediaType.APPLICATION_JSON).content(body(List.of())))
					.andExpect(status().isConflict());
			for(var table:List.of("tasks","task_status_history","audit_events","idempotency_requests","outbox_events"))
				assertThat(jdbc.queryForObject("select count(*) from "+table,Long.class)).isZero();
		} finally {
			jdbc.execute("drop trigger reject_task_outbox on outbox_events");
			jdbc.execute("drop function reject_task_outbox()");
		}
	}
	@Test void titleEditKeepsReminderIdentityDeliveryMarkersAndTips() throws Exception {
		var request=extendedBody();
		var id=createExtended(request);
		var once=jdbc.queryForObject("select id from task_reminders where task_id=? and type='before_deadline'",String.class,id);
		jdbc.update("update task_reminders set sent_at='2026-10-01T10:00:00Z',active=false,next_due_at=null,version=1 where id=?",once);
		request.remove("tips"); request.remove("reminders"); request.put("title","Новое название"); request.put("expectedVersion",0);
		mvc.perform(patch("/api/v1/tasks/{id}",id).cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","edit-title-001").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
				.andExpect(status().isOk()).andExpect(jsonPath("$.tips[0]").value("Проверить кабель"));
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where task_id=? and enabled",Long.class,id)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select version from task_reminders where id=?",Long.class,once)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select sent_at is not null from task_reminders where id=?",Boolean.class,once)).isTrue();
		request.put("tips",List.of()); request.put("reminders",List.of()); request.put("expectedVersion",1);
		mvc.perform(patch("/api/v1/tasks/{id}",id).cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","remove-reminders-001").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
				.andExpect(status().isOk()).andExpect(jsonPath("$.tips.length()").value(0)).andExpect(jsonPath("$.reminders.length()").value(0));
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where task_id=?",Long.class,id)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where task_id=? and active",Long.class,id)).isZero();
		assertThat(command(id,"status",firstCookie,"complete-after-remove-001","{\"expectedVersion\":2,\"status\":\"completed\"}")).isEqualTo(200);
		assertThat(command(id,"status",firstCookie,"reopen-after-remove-001","{\"expectedVersion\":3,\"status\":\"in_progress\"}")).isEqualTo(200);
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where task_id=? and active",Long.class,id)).isZero();
	}
	@Test void newDeadlineRevisesOnceScheduleAndKeepsRepeatAnchor() throws Exception {
		var request=extendedBody(); var id=createExtended(request);
		var repeatBefore=jdbc.queryForList("select id,anchor_at,next_due_at,version from task_reminders where task_id=? and type='repeat'",id);
		jdbc.update("update task_reminders set sent_at=now(),active=false,next_due_at=null,version=1 where task_id=? and type='before_deadline'",id);
		request.put("expectedVersion",0); request.put("deadline","2026-10-06");
		mvc.perform(patch("/api/v1/tasks/{id}",id).cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","move-deadline-001").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
				.andExpect(status().isOk());
		assertThat(jdbc.queryForList("select id,anchor_at,next_due_at,version from task_reminders where task_id=? and type='repeat'",id)).isEqualTo(repeatBefore);
		assertThat(jdbc.queryForObject("select version from task_reminders where task_id=? and type='before_deadline'",Long.class,id)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select sent_at is null and active from task_reminders where task_id=? and type='before_deadline'",Boolean.class,id)).isTrue();
		assertThat(jdbc.queryForObject("select next_due_at from task_reminders where task_id=? and type='before_deadline'",java.sql.Timestamp.class,id).toInstant())
				.isEqualTo(java.time.Instant.parse("2026-10-06T18:59:59.999Z"));
	}
	@Test void unchangedReminderWithoutIdReusesExistingSchedule() throws Exception {
		var request=extendedBody(); var id=createExtended(request);
		var before=jdbc.queryForList("select id,anchor_at,next_due_at,version from task_reminders where task_id=? order by id",id);
		request.put("expectedVersion",0);
		mvc.perform(patch("/api/v1/tasks/{id}",id).cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","same-schedule-001").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
				.andExpect(status().isOk());
		assertThat(jdbc.queryForList("select id,anchor_at,next_due_at,version from task_reminders where task_id=? order by id",id)).isEqualTo(before);
	}
	@Test void completionPausesAndReopeningDoesNotRepeatSentOnceReminder() throws Exception {
		var id=createExtended(extendedBody());
		jdbc.update("update task_reminders set sent_at=now(),active=false,next_due_at=null where task_id=? and type='before_deadline'",id);
		assertThat(command(id,"status",firstCookie,"complete-with-reminders-001","{\"expectedVersion\":0,\"status\":\"completed\"}")).isEqualTo(200);
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where task_id=? and active",Long.class,id)).isZero();
		assertThat(command(id,"status",firstCookie,"reopen-with-reminders-001","{\"expectedVersion\":1,\"status\":\"in_progress\"}")).isEqualTo(200);
		assertThat(jdbc.queryForList("select type from task_reminders where task_id=? and active",String.class,id)).containsExactly("repeat");
		assertThat(command(id,"cancel",authorCookie,"cancel-with-reminders-001","{\"expectedVersion\":2}")).isEqualTo(200);
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where task_id=? and active",Long.class,id)).isZero();
	}
	@Test void stateSeparatesDiscussionAndCurrentCompletionWithoutErasingHistory() throws Exception {
		var id=createExtended(extendedBody());
		assertThat(command(id,"comments",firstCookie,"state-note-001","{\"expectedVersion\":0,\"side\":\"executor\",\"text\":\"Обсуждение\"}")).isEqualTo(201);
		assertThat(command(id,"status",firstCookie,"state-complete-001","{\"expectedVersion\":1,\"status\":\"completed\",\"completionComment\":\"Готово\"}")).isEqualTo(200);
		var state=mvc.perform(get("/api/state").cookie(authorCookie)).andExpect(status().isOk()).andReturn().getResponse();
		var task=json.readTree(state.getContentAsString()).path("tasks").get(0);
		assertThat(task.path("assignedTo").get(0).asText()).isEqualTo(first.getId());
		assertThat(task.path("completionComments").path(first.getId()).asText()).isEqualTo("Готово");
		assertThat(task.path("assigneeNotes").path(first.getId()).path("history").size()).isEqualTo(1);
		assertThat(task.path("tips").get(0).asText()).isEqualTo("Проверить кабель");
		assertThat(task.path("deadline").asText()).isEqualTo("2026-10-05");
		assertThat(command(id,"status",firstCookie,"state-reopen-001","{\"expectedVersion\":2,\"status\":\"in_progress\"}")).isEqualTo(200);
		assertThat(command(id,"status",firstCookie,"state-complete-002","{\"expectedVersion\":3,\"status\":\"completed\"}")).isEqualTo(200);
		var updated=mvc.perform(get("/api/state").cookie(authorCookie)).andReturn().getResponse();
		var mapped=json.readTree(updated.getContentAsString()).path("tasks").get(0);
		assertThat(mapped.path("completionComments").size()).isZero();
		assertThat(mapped.path("comments").size()).isEqualTo(2);
	}
	@Test void invalidReminderConfigurationRollsBackCreation() throws Exception {
		var request=extendedBody(); request.remove("deadline");
		mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","no-deadline-reminder-001").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
				.andExpect(status().isBadRequest());
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from task_tips",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from task_reminders",Long.class)).isZero();
	}
	private Map<String,Object> extendedBody() {
		var request=new java.util.LinkedHashMap<String,Object>();
		request.put("title","Проверить оборудование"); request.put("priority","normal"); request.put("deadline","2026-10-05");
		request.put("assigneeIds",List.of(first.getId())); request.put("tips",List.of("Проверить кабель","Проверить питание"));
		request.put("reminders",List.of(Map.of("type","before_deadline","value",2,"unit","hours"),
				Map.of("type","repeat","value",1,"unit","days")));
		return request;
	}
	private String createExtended(Map<String,Object> request) throws Exception {
		var result=mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","extended-create-001").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
				.andExpect(status().isCreated()).andReturn().getResponse();
		return json.readTree(result.getContentAsString()).path("id").asText();
	}
	private String create(List<String> assigned) throws Exception {
		var response=mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","task-create-001").contentType(MediaType.APPLICATION_JSON).content(body(assigned)))
				.andExpect(status().isCreated()).andReturn().getResponse();
		return json.readTree(response.getContentAsString()).path("id").asText();
	}
	private String body(List<String> assigned) throws Exception {
		return json.writeValueAsString(Map.of("title","Проверить оборудование","priority","normal","assigneeIds",assigned,"deadline","2026-10-05"));
	}
	private int command(String id,String action,Cookie cookie,String key,String body) throws Exception {
		return mvc.perform(post("/api/v1/tasks/{id}/{action}",id,action).cookie(cookie).header("Origin","http://localhost")
				.header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(body)).andReturn().getResponse().getStatus();
	}
	@Test void taskLogPaginatesSnapshotsAndKeepsEarlierCompletionAfterReopen() throws Exception {
		var id=create(List.of(first.getId()));
		assertThat(command(id,"status",firstCookie,"log-complete-001","{\"expectedVersion\":0,\"status\":\"completed\",\"completionComment\":\"Результат\"}")).isEqualTo(200);
		assertThat(command(id,"status",firstCookie,"log-reopen-001","{\"expectedVersion\":1,\"status\":\"in_progress\"}")).isEqualTo(200);
		jdbc.update("update tasks set title='New current title' where id=?",id);
		var page=json.readTree(mvc.perform(get("/api/v1/tasks/log").cookie(authorCookie).param("limit","1"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1)).andReturn().getResponse().getContentAsString());
		var cursor=page.path("nextCursor").asText();
		assertThat(cursor).isNotBlank();
		mvc.perform(get("/api/v1/tasks/log").cookie(authorCookie).param("cursor",cursor).param("limit","100"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(2))
				.andExpect(jsonPath("$.nextCursor").isEmpty())
				.andExpect(jsonPath("$.items[0].status").value("completed"))
				.andExpect(jsonPath("$.items[0].details.title").value("Проверить оборудование"))
				.andExpect(jsonPath("$.items[0].details.completedBy").value(first.getId()))
				.andExpect(jsonPath("$.items[0].completedByName").value("First"))
				.andExpect(jsonPath("$.items[0].details.comments[0].text").value("Результат"))
				.andExpect(jsonPath("$.items[1].details.completedBy").isEmpty());
	}
	@Test void logAndExportEnforceRolesAndValidateCursorAndLimit() throws Exception {
		mvc.perform(get("/api/v1/tasks/log").cookie(facultyCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/tasks/export").cookie(authorCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/tasks/export").cookie(facultyCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/tasks/log")).andExpect(status().isUnauthorized());
		mvc.perform(get("/api/v1/tasks/log").cookie(authorCookie).param("limit","101")).andExpect(status().isBadRequest());
		mvc.perform(get("/api/v1/tasks/log").cookie(authorCookie).param("cursor","unknown")).andExpect(status().isBadRequest());
	}
	@Test void adminExportIsRealUtf8CsvAndSignalsRemainingPagesWithoutSideEffects() throws Exception {
		var id=create(List.of(first.getId()));
		assertThat(command(id,"status",firstCookie,"export-complete-001","{\"expectedVersion\":0,\"status\":\"completed\"}")).isEqualTo(200);
		var admin=users.saveAndFlush(new UserEntity(305L,"export_admin","Admin","admin"));
		var adminCookie=cookie(admin);
		long outboxBefore=jdbc.queryForObject("select count(*) from outbox_events",Long.class);
		var response=mvc.perform(get("/api/v1/tasks/export").cookie(adminCookie).param("limit","1"))
				.andExpect(status().isOk()).andExpect(header().string("Content-Type","text/csv; charset=UTF-8"))
				.andExpect(header().string("Cache-Control","no-store"))
				.andExpect(header().string("Content-Disposition","attachment; filename=task-log.csv"))
				.andExpect(header().exists("X-Next-Cursor")).andReturn().getResponse();
		assertThat(new String(response.getContentAsByteArray(),java.nio.charset.StandardCharsets.UTF_8)).startsWith("\uFEFF").contains("ID записи");
		mvc.perform(get("/api/v1/tasks/export").cookie(adminCookie).param("cursor",response.getHeader("X-Next-Cursor")))
				.andExpect(status().isOk()).andExpect(header().doesNotExist("X-Next-Cursor"));
		assertThat(jdbc.queryForObject("select count(*) from outbox_events",Long.class)).isEqualTo(outboxBefore);
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isEqualTo(1);
	}
	private Cookie cookie(UserEntity user) { return new Cookie("megabot_session",sessions.rotateFor(user.getId()).rawToken()); }

	@Test void archiveHidesOnlyTerminalTasksAndRecoveryKeepsCompletionAndOldHistory() throws Exception {
		var id=create(List.of(first.getId()));
		assertThat(command(id,"status",firstCookie,"archive-complete-001","{\"expectedVersion\":0,\"status\":\"completed\",\"completionComment\":\"Сохранённый результат\"}")).isEqualTo(200);
		var open=createExtended(Map.of("title","Открытая задача","priority","normal"));
		var admin=maintenanceAdmin();
		var preview=maintenancePreview("archive",admin);
		assertThat(preview.path("count").asInt()).isEqualTo(1);
		var response=mvc.perform(post("/api/v1/tasks/archive/clear").cookie(admin).header("Origin","http://localhost")
				.header("Idempotency-Key","archive-clear-001").contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("fingerprint",preview.path("fingerprint").asText()))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.count").value(1)).andReturn().getResponse();
		var recovery=json.readTree(response.getContentAsString()).path("recoveryId").asText();
		mvc.perform(get("/api/v1/tasks/{id}",id).cookie(authorCookie)).andExpect(status().isNotFound());
		mvc.perform(get("/api/v1/tasks/{id}",open).cookie(authorCookie)).andExpect(status().isOk());
		mvc.perform(get("/api/state").cookie(authorCookie)).andExpect(jsonPath("$.tasks.length()").value(1));
		mvc.perform(get("/api/v1/tasks/recovery/{id}",recovery).cookie(admin)).andExpect(status().isOk())
				.andExpect(jsonPath("$.snapshot[0].comments[0].text").value("Сохранённый результат"));
		assertThat(jdbc.queryForObject("select count(*) from task_status_history where task_id=?",Long.class,id)).isEqualTo(2);
		mvc.perform(post("/api/v1/tasks/recovery/{id}/restore",recovery).cookie(admin).header("Origin","http://localhost")
				.header("Idempotency-Key","archive-restore-001")).andExpect(status().isOk()).andExpect(jsonPath("$.changed").value(true));
		mvc.perform(get("/api/state").cookie(authorCookie)).andExpect(jsonPath("$.tasks.length()").value(2));
		var state=json.readTree(mvc.perform(get("/api/state").cookie(authorCookie)).andReturn().getResponse().getContentAsString());
		var restored=java.util.stream.StreamSupport.stream(state.path("tasks").spliterator(),false)
				.filter(task->task.path("id").asText().equals(id)).findFirst().orElseThrow();
		assertThat(restored.path("completionComments").path(first.getId()).asText()).isEqualTo("Сохранённый результат");
		assertThat(command(id,"status",firstCookie,"old-before-archive-001","{\"expectedVersion\":1,\"status\":\"in_progress\"}")).isEqualTo(409);
		mvc.perform(post("/api/v1/tasks/recovery/{id}/restore",recovery).cookie(admin).header("Origin","http://localhost")
				.header("Idempotency-Key","archive-restore-again")).andExpect(status().isOk()).andExpect(jsonPath("$.changed").value(false));
	}

	@Test void stalePreviewAndResetConfirmationDoNotModifyTasks() throws Exception {
		var id=create(List.of(first.getId())); var admin=maintenanceAdmin();
		var preview=maintenancePreview("season-reset",admin);
		var body=json.writeValueAsString(Map.of("fingerprint",preview.path("fingerprint").asText()));
		mvc.perform(post("/api/v1/tasks/season-reset").cookie(admin).header("Origin","http://localhost")
				.header("Idempotency-Key","reset-no-confirmation").contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isBadRequest());
		assertThat(command(id,"comments",firstCookie,"preview-change-001","{\"expectedVersion\":0,\"side\":\"executor\",\"text\":\"Правка после preview\"}")).isEqualTo(201);
		mvc.perform(post("/api/v1/tasks/season-reset").cookie(admin).header("Origin","http://localhost")
				.header("Idempotency-Key","reset-stale-preview").contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("fingerprint",preview.path("fingerprint").asText(),"confirmation","СБРОСИТЬ СЕЗОН"))))
				.andExpect(status().isConflict());
		assertThat(jdbc.queryForObject("select count(*) from task_recovery_operations",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from tasks where removed_at is null",Long.class)).isEqualTo(1);
	}

	@Test void resetPausesRemindersAndRestoreResumesWithoutRevivingQueuedNotifications() throws Exception {
		var id=createExtended(extendedBody()); var admin=maintenanceAdmin();
		var preview=maintenancePreview("season-reset",admin);
		var request=json.writeValueAsString(Map.of("fingerprint",preview.path("fingerprint").asText(),"confirmation","СБРОСИТЬ СЕЗОН"));
		var response=mvc.perform(post("/api/v1/tasks/season-reset").cookie(admin).header("Origin","http://localhost")
				.header("Idempotency-Key","season-reset-001").contentType(MediaType.APPLICATION_JSON).content(request))
				.andExpect(status().isOk()).andReturn().getResponse();
		var recovery=json.readTree(response.getContentAsString()).path("recoveryId").asText();
		mvc.perform(post("/api/v1/tasks/season-reset").cookie(admin).header("Origin","http://localhost")
				.header("Idempotency-Key","season-reset-001").contentType(MediaType.APPLICATION_JSON).content(request))
				.andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		assertThat(jdbc.queryForObject("select count(*) from task_recovery_operations",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where active",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where status='cancelled'",Long.class)).isEqualTo(1);
		assertThat(command(id,"claim",firstCookie,"hidden-old-button-001","{\"expectedVersion\":0}")).isEqualTo(404);
		mvc.perform(post("/api/v1/tasks/recovery/{id}/restore",recovery).cookie(admin).header("Origin","http://localhost")
				.header("Idempotency-Key","season-restore-001")).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where active and enabled",Long.class)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where status='cancelled'",Long.class)).isEqualTo(1);
	}

	@Test void maintenanceIsAdminOnlyAndSnapshotFailureRollsBackWholeOperation() throws Exception {
		create(List.of()); var admin=maintenanceAdmin();
		mvc.perform(get("/api/v1/tasks/archive/preview").cookie(authorCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/tasks/season-reset/preview").cookie(facultyCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/tasks/recovery/unknown").cookie(authorCookie)).andExpect(status().isForbidden());
		var preview=maintenancePreview("season-reset",admin);
		jdbc.execute("alter table task_recovery_operations add constraint simulated_backup_failure check (false) not valid");
		try {
			mvc.perform(post("/api/v1/tasks/season-reset").cookie(admin).header("Origin","http://localhost")
					.header("Idempotency-Key","reset-backup-failure").contentType(MediaType.APPLICATION_JSON)
					.content(json.writeValueAsString(Map.of("fingerprint",preview.path("fingerprint").asText(),"confirmation","СБРОСИТЬ СЕЗОН"))))
					.andExpect(status().isConflict());
		} finally { jdbc.execute("alter table task_recovery_operations drop constraint simulated_backup_failure"); }
		assertThat(jdbc.queryForObject("select count(*) from task_recovery_operations",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from tasks where removed_at is null and version=0",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from idempotency_requests where request_key='reset-backup-failure'",Long.class)).isZero();
	}

	@Test void concurrentCreateIsNeverSilentlyIncludedInAnOlderResetPreview() throws Exception {
		create(List.of()); var admin=maintenanceAdmin(); var preview=maintenancePreview("season-reset",admin);
		var start=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var reset=pool.submit(()->{
				start.await(); return mvc.perform(post("/api/v1/tasks/season-reset").cookie(admin).header("Origin","http://localhost")
						.header("Idempotency-Key","race-reset-001").contentType(MediaType.APPLICATION_JSON)
						.content(json.writeValueAsString(Map.of("fingerprint",preview.path("fingerprint").asText(),"confirmation","СБРОСИТЬ СЕЗОН"))))
						.andReturn().getResponse().getStatus();
			});
			var create=pool.submit(()->{
				start.await(); return mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
						.header("Idempotency-Key","race-new-task-001").contentType(MediaType.APPLICATION_JSON).content(body(List.of())))
						.andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
			});
			start.countDown(); var id=json.readTree(create.get()).path("id").asText();
			assertThat(reset.get()).isIn(200,409);
			mvc.perform(get("/api/v1/tasks/{id}",id).cookie(authorCookie)).andExpect(status().isOk());
		}
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isEqualTo(2);
	}

	@Test void allFacultyTaskIsSharedButOnlyAssignedMembersSeeItAndOwnNotes() throws Exception {
		var other=users.saveAndFlush(new UserEntity(307L,"faculty_other","Other faculty","faculty_responsible"));
		var unassigned=users.saveAndFlush(new UserEntity(308L,"faculty_unassigned","Unassigned","faculty_helper"));
		jdbc.update("insert into faculties(id,name) values ('scope_a','A'),('scope_b','B')");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values (?,'scope_a','helper'),(?,'scope_b','responsible'),(?,'scope_b','helper')",faculty.getId(),other.getId(),unassigned.getId());
		var id=createExtended(Map.of("title","Общая факультетская задача","priority","normal","facultyId","all","assigneeIds",List.of(faculty.getId(),other.getId())));
		assertThat(jdbc.queryForObject("select faculty_all from tasks where id=?",Boolean.class,id)).isTrue();
		assertThat(jdbc.queryForObject("select faculty_id from tasks where id=?",String.class,id)).isNull();
		var otherCookie=cookie(other);
		mvc.perform(get("/api/faculty/my-tasks").cookie(otherCookie)).andExpect(status().isOk())
				.andExpect(jsonPath("$.tasks[0].facultyId").value("all"));
		mvc.perform(get("/api/v1/tasks/{id}",id).cookie(cookie(unassigned))).andExpect(status().isForbidden());
		assertThat(command(id,"comments",authorCookie,"all-faculty-note-001",json.writeValueAsString(Map.of("expectedVersion",0,"side","coordinator","targetAssigneeId",other.getId(),"text","Только второму")))).isEqualTo(201);
		mvc.perform(get("/api/v1/tasks/{id}",id).cookie(facultyCookie)).andExpect(status().isOk()).andExpect(jsonPath("$.comments.length()").value(0));
		assertThat(command(id,"status",otherCookie,"all-faculty-complete-001","{\"expectedVersion\":1,\"status\":\"completed\"}")).isEqualTo(200);
		mvc.perform(get("/api/v1/tasks/{id}",id).cookie(facultyCookie)).andExpect(jsonPath("$.status").value("completed"))
				.andExpect(jsonPath("$.completedBy").value(other.getId()));
	}

	@Test void allFacultyScopeRejectsCoreInactiveAndUnscopedAssignees() throws Exception {
		var noMembership=users.saveAndFlush(new UserEntity(309L,"no_membership","No membership","faculty_helper"));
		jdbc.update("insert into faculties(id,name,active) values ('inactive_faculty','Inactive',false)");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values (?,'inactive_faculty','helper')",faculty.getId());
		for(var assignee:List.of(first.getId(),faculty.getId(),noMembership.getId())) {
			mvc.perform(post("/api/v1/tasks").cookie(authorCookie).header("Origin","http://localhost")
					.header("Idempotency-Key","invalid-all-"+assignee).contentType(MediaType.APPLICATION_JSON)
					.content(json.writeValueAsString(Map.of("title","All task","priority","normal","facultyId","all","assigneeIds",List.of(assignee)))))
					.andExpect(status().isBadRequest());
		}
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isZero();
	}

	@Test void allFacultyScopeSurvivesUpdateAndCannotBecomeCore() throws Exception {
		jdbc.update("insert into faculties(id,name) values ('all_edit_fac','Edit faculty')");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values (?,'all_edit_fac','helper')",faculty.getId());
		var id=createExtended(Map.of("title","All original","priority","normal","facultyId","all","assigneeIds",List.of(faculty.getId())));
		mvc.perform(patch("/api/v1/tasks/{id}",id).cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","all-to-core-denied").contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("title","Core","priority","normal","expectedVersion",0,"assigneeIds",List.of(first.getId())))))
				.andExpect(status().isBadRequest());
		mvc.perform(patch("/api/v1/tasks/{id}",id).cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","all-edit-accepted").contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("title","All updated","priority","normal","facultyId","all","expectedVersion",0,"assigneeIds",List.of(faculty.getId())))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.facultyId").value("all"));
		assertThat(jdbc.queryForObject("select faculty_all from tasks where id=?",Boolean.class,id)).isTrue();
	}

	@Test void legacyCoreCreateUsesSessionActorMapsNamesAndReplaysDraftReminders() throws Exception {
		jdbc.update("insert into competencies(id,name,scope) values ('legacy_core_c','Техника','core')");
		var request=json.writeValueAsString(Map.of("title","Legacy task","deadline","2026-10-05","assignedTo",first.getId(),
				"creatorId",second.getId(),"competencies",List.of("Техника"),"reminders",List.of(Map.of("id","draft_123","type","repeat","value",1,"unit","days"))));
		var response=mvc.perform(post("/api/task/create").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","legacy-core-create-001").contentType(MediaType.APPLICATION_JSON).content(request))
				.andExpect(status().isOk()).andExpect(jsonPath("$.success").value(true))
				.andExpect(jsonPath("$.task.creatorId").value(author.getId())).andExpect(jsonPath("$.task.competencies[0]").value("Техника"))
				.andExpect(jsonPath("$.task.assignedTo[0]").value(first.getId())).andReturn().getResponse();
		assertThat(json.readTree(response.getContentAsString()).path("task").path("reminders").get(0).path("id").asText()).startsWith("rem_");
		mvc.perform(post("/api/task/create").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","legacy-core-create-001").contentType(MediaType.APPLICATION_JSON).content(request))
				.andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		mvc.perform(post("/api/task/create").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","legacy-core-create-001").contentType(MediaType.APPLICATION_JSON).content(request.replace("Legacy task","Different task")))
				.andExpect(status().isConflict());
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from task_reminders",Long.class)).isEqualTo(1);
	}

	@Test void legacyFacultyCreateKeepsWaitingStateAndRequiresCoreSessionAndAssignments() throws Exception {
		jdbc.update("insert into faculties(id,name) values ('legacy_fac','Faculty')");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values (?,'legacy_fac','helper')",faculty.getId());
		var request=json.writeValueAsString(Map.of("title","Faculty legacy","deadline","2026-10-05","facultyId","all","assignedTo",List.of(faculty.getId()),"requesterId",first.getId()));
		mvc.perform(post("/api/faculty/task/create").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","legacy-faculty-create").contentType(MediaType.APPLICATION_JSON).content(request))
				.andExpect(status().isOk()).andExpect(jsonPath("$.task.status").value("waiting"))
				.andExpect(jsonPath("$.task.facultyId").value("all")).andExpect(jsonPath("$.task.creatorId").value(author.getId()));
		mvc.perform(post("/api/faculty/task/create").cookie(facultyCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","legacy-faculty-denied").contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isForbidden());
		mvc.perform(post("/api/task/create").cookie(authorCookie).header("Origin","http://localhost")
				.header("Idempotency-Key","legacy-invalid-date").contentType(MediaType.APPLICATION_JSON)
				.content("{\"title\":\"Invalid\",\"deadline\":\"2026-02-30\"}")).andExpect(status().isBadRequest());
		assertThat(jdbc.queryForObject("select count(*) from tasks",Long.class)).isEqualTo(1);
	}

	@Test void legacyPartialUpdatePreservesAssignmentsTipsMarkersAndChecksReplayVersionAndActor() throws Exception {
		var request=extendedBody(); request.put("description","Сохранённое описание"); request.put("sow","Сохранённое ТЗ");
		var id=createExtended(request);
		jdbc.update("update task_reminders set last_sent_at='2026-10-01T00:00:00Z',next_due_at='2030-01-01T00:00:00Z' where task_id=? and type='repeat'",id);
		var reminders=jdbc.queryForList("select id,anchor_at,next_due_at,last_sent_at,version from task_reminders where task_id=? order by id",id);
		var assignmentTime=jdbc.queryForObject("select assigned_at from task_assignees where task_id=?",java.sql.Timestamp.class,id);
		var body=Map.<String,Object>of("taskId",id,"version",0,"title","Частичная правка","requesterId",second.getId());
		legacy("/api/task/update",authorCookie,"legacy-partial-update",body).andExpect(status().isOk())
				.andExpect(jsonPath("$.task.title").value("Частичная правка")).andExpect(jsonPath("$.task.description").value("Сохранённое описание"))
				.andExpect(jsonPath("$.task.sow").value("Сохранённое ТЗ")).andExpect(jsonPath("$.task.version").value(1));
		legacy("/api/task/update",authorCookie,"legacy-partial-update",body).andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		legacy("/api/task/update",authorCookie,"legacy-stale-update",body).andExpect(status().isConflict());
		legacy("/api/task/update",secondCookie,"legacy-spoof-author",Map.of("taskId",id,"version",1,"title","Нельзя","requesterId",author.getId()))
				.andExpect(status().isForbidden());
		legacy("/api/task/update",authorCookie,"legacy-version-required",Map.of("taskId",id,"title","Нельзя"))
				.andExpect(status().isBadRequest());
		assertThat(jdbc.queryForList("select id,anchor_at,next_due_at,last_sent_at,version from task_reminders where task_id=? order by id",id)).isEqualTo(reminders);
		assertThat(jdbc.queryForObject("select assigned_at from task_assignees where task_id=?",java.sql.Timestamp.class,id)).isEqualTo(assignmentTime);
		assertThat(jdbc.queryForObject("select count(*) from task_status_history where task_id=?",Long.class,id)).isEqualTo(2);
	}

	@Test void legacyCommentsAndCompletionUseSessionActorAppendOnlyAndDoNotDuplicate() throws Exception {
		var id=create(List.of(first.getId(),second.getId()));
		var comment=Map.<String,Object>of("taskId",id,"version",0,"side","executor","text","Заметка","requesterId",second.getId(),"assigneeId",second.getId());
		legacy("/api/task/comment",firstCookie,"legacy-comment-001",comment).andExpect(status().isOk());
		legacy("/api/task/comment",firstCookie,"legacy-comment-001",comment).andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		assertThat(jdbc.queryForObject("select author_id from task_comments where task_id=?",String.class,id)).isEqualTo(first.getId());
		assertThat(jdbc.queryForObject("select target_assignee_id from task_comments where task_id=?",String.class,id)).isEqualTo(first.getId());
		var completion=Map.<String,Object>of("taskId",id,"version",1,"status","completed","completionComment","Готово","timeSpentMinutes",25,"requesterId",second.getId());
		legacy("/api/task/status",firstCookie,"legacy-completion-001",completion).andExpect(status().isOk())
				.andExpect(jsonPath("$.task.completedBy").value(first.getId())).andExpect(jsonPath("$.task.timeSpentMinutes").value(25));
		legacy("/api/task/status",firstCookie,"legacy-completion-001",completion).andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		legacy("/api/task/comment",firstCookie,"legacy-closed-comment",Map.of("taskId",id,"version",2,"side","executor","text","Поздно"))
				.andExpect(status().isConflict());
		legacy("/api/task/status",firstCookie,"legacy-result-reopen-required",Map.of("taskId",id,"version",2,"status","completed","timeSpentMinutes",50))
				.andExpect(status().isConflict());
		assertThat(jdbc.queryForObject("select count(*) from task_comments where task_id=?",Long.class,id)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where aggregate_id=?",Long.class,id)).isEqualTo(3);
	}

	@Test void legacyFacultyUpdateKeepsAllScopeAndUsesScopedExecutorCommands() throws Exception {
		jdbc.update("insert into faculties(id,name) values ('legacy_update_fac','Faculty')");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values (?,'legacy_update_fac','helper')",faculty.getId());
		var id=createExtended(Map.of("title","Факультетам","priority","normal","facultyId","all","assigneeIds",List.of(faculty.getId())));
		legacy("/api/faculty/task/update",authorCookie,"legacy-faculty-update",Map.of("taskId",id,"version",0,"description","Новые детали"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.task.facultyId").value("all"));
		legacy("/api/task/update",authorCookie,"legacy-wrong-route",Map.of("taskId",id,"version",1,"title","Нельзя"))
				.andExpect(status().isBadRequest());
		legacy("/api/faculty/task/update",facultyCookie,"legacy-faculty-edit-denied",Map.of("taskId",id,"version",1,"title","Нельзя"))
				.andExpect(status().isForbidden());
		legacy("/api/task/comment",facultyCookie,"legacy-faculty-comment",Map.of("taskId",id,"version",1,"side","executor","text","Сделаю"))
				.andExpect(status().isOk());
		legacy("/api/task/status",facultyCookie,"legacy-faculty-status",Map.of("taskId",id,"version",2,"status","in_progress"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.task.status").value("in_progress"));
	}

	@Test void legacyMalformedPatchRollsBackAndEmptyListsExplicitlyClear() throws Exception {
		var id=createExtended(extendedBody());
		for(var payload:List.of(Map.of("taskId",id,"version",0,"deadline","2026-02-30"),
				Map.of("taskId",id,"version",0,"assignedTo",List.of(5)),Map.of("taskId",id,"version",0,"status","completed","timeSpentMinutes",1.5))) {
			legacy(payload.containsKey("status")?"/api/task/status":"/api/task/update",authorCookie,"legacy-invalid-"+payload.hashCode(),payload)
					.andExpect(status().isBadRequest());
		}
		legacy("/api/task/update",authorCookie,"legacy-clear-config",Map.of("taskId",id,"version",0,"tips",List.of(),"reminders",List.of()))
				.andExpect(status().isOk()).andExpect(jsonPath("$.task.tips.length()").value(0)).andExpect(jsonPath("$.task.reminders.length()").value(0));
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where task_id=? and enabled",Long.class,id)).isZero();
		assertThat(jdbc.queryForObject("select version from tasks where id=?",Long.class,id)).isEqualTo(1);
	}

	@Test void legacyConcurrentClaimUsesSessionActorAndReplayHasNoSideEffects() throws Exception {
		var id=create(List.of());
		var start=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await(); return legacy("/api/task/claim",firstCookie,"legacy-claim-first",Map.of("taskId",id,"version",0,"userId",second.getId())).andReturn().getResponse().getStatus();});
			var b=pool.submit(()->{start.await(); return legacy("/api/task/claim",secondCookie,"legacy-claim-second",Map.of("taskId",id,"version",0,"userId",first.getId())).andReturn().getResponse().getStatus();});
			start.countDown();
			var firstStatus=a.get(); var secondStatus=b.get();
			assertThat(List.of(firstStatus,secondStatus)).containsExactlyInAnyOrder(200,409);
			var winner=firstStatus==200?first:second; var winnerCookie=firstStatus==200?firstCookie:secondCookie;
			var key=firstStatus==200?"legacy-claim-first":"legacy-claim-second";
			var spoof=firstStatus==200?second:first;
			legacy("/api/task/claim",winnerCookie,key,Map.of("taskId",id,"version",0,"userId",spoof.getId()))
					.andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"))
					.andExpect(jsonPath("$.task.assignedTo[0]").value(winner.getId()));
			assertThat(jdbc.queryForList("select user_id from task_assignees where task_id=?",String.class,id)).containsExactly(winner.getId());
		}
		assertThat(jdbc.queryForObject("select count(*) from task_status_history where task_id=?",Long.class,id)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where aggregate_id=?",Long.class,id)).isEqualTo(2);
	}
	@Test void legacyReleaseKeepsOtherAssigneeThenReturnsTaskToBoard() throws Exception {
		var id=create(List.of(first.getId(),second.getId()));
		var body=Map.of("taskId",id,"version",0,"userId",second.getId());
		legacy("/api/task/release",firstCookie,"legacy-release-first",body).andExpect(status().isOk())
				.andExpect(jsonPath("$.becameOpen").value(false)).andExpect(jsonPath("$.remainingAssigneeIds[0]").value(second.getId()));
		legacy("/api/task/release",firstCookie,"legacy-release-first",body).andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		legacy("/api/task/release",secondCookie,"legacy-release-stale",Map.of("taskId",id,"version",0)).andExpect(status().isConflict());
		legacy("/api/task/release",firstCookie,"legacy-release-other",Map.of("taskId",id,"version",1,"userId",second.getId())).andExpect(status().isForbidden());
		legacy("/api/task/release",secondCookie,"legacy-release-second",Map.of("taskId",id,"version",1)).andExpect(status().isOk())
				.andExpect(jsonPath("$.becameOpen").value(true)).andExpect(jsonPath("$.remainingAssigneeIds.length()").value(0))
				.andExpect(jsonPath("$.task.status").value("open"));
		assertThat(jdbc.queryForObject("select version from tasks where id=?",Long.class,id)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from task_status_history where task_id=?",Long.class,id)).isEqualTo(3);
	}
	@Test void legacyDeleteCancelsWithoutDeletingHistoryAndRejectsSpoofedAuthor() throws Exception {
		var request=extendedBody(); request.put("assigneeIds",List.of(first.getId()));
		var id=createExtended(request);
		legacy("/api/task/delete",secondCookie,"legacy-cancel-spoof",Map.of("taskId",id,"version",0,"requesterId",author.getId())).andExpect(status().isForbidden());
		legacy("/api/task/delete",authorCookie,"legacy-cancel-stale",Map.of("taskId",id,"version",8)).andExpect(status().isConflict());
		var body=Map.of("taskId",id,"version",0,"requesterId",second.getId());
		legacy("/api/task/delete",authorCookie,"legacy-cancel-author",body).andExpect(status().isOk()).andExpect(jsonPath("$.task.status").value("cancelled"));
		legacy("/api/task/delete",authorCookie,"legacy-cancel-author",body).andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		assertThat(jdbc.queryForObject("select cancelled_by from tasks where id=?",String.class,id)).isEqualTo(author.getId());
		assertThat(jdbc.queryForObject("select count(*) from task_status_history where task_id=?",Long.class,id)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from task_reminders where task_id=? and active",Long.class,id)).isZero();
		legacy("/api/task/claim",firstCookie,"legacy-cancel-claim",Map.of("taskId",id,"version",1)).andExpect(status().isConflict());
		legacy("/api/task/release",firstCookie,"legacy-cancel-release",Map.of("taskId",id,"version",1)).andExpect(status().isConflict());
	}
	@Test void legacyAssignmentRequiresVersionKeyOriginAndCoreClaimScope() throws Exception {
		var id=create(List.of());
		legacy("/api/task/claim",facultyCookie,"legacy-faculty-claim",Map.of("taskId",id,"version",0)).andExpect(status().isForbidden());
		legacy("/api/task/claim",firstCookie,"legacy-claim-no-version",Map.of("taskId",id)).andExpect(status().isBadRequest());
		mvc.perform(post("/api/task/claim").cookie(firstCookie).header("Origin","http://localhost").contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("taskId",id,"version",0)))).andExpect(status().isBadRequest());
		mvc.perform(post("/api/task/claim").cookie(firstCookie).header("Origin","https://evil.example").header("Idempotency-Key","legacy-bad-origin")
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("taskId",id,"version",0)))).andExpect(status().isForbidden());
		assertThat(jdbc.queryForObject("select version from tasks where id=?",Long.class,id)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from task_assignees where task_id=?",Long.class,id)).isZero();
	}
	@Test void manualReminderIsSilentDurableSnapshotAndConcurrentReplayDoesNotDuplicate() throws Exception {
		var id=create(List.of(first.getId(),second.getId()));
		jdbc.update("update users set telegram_id=null where id=?",second.getId());
		assertThat(command(id,"comments",authorCookie,"manual-private-note","{\"expectedVersion\":0,\"side\":\"coordinator\",\"targetAssigneeId\":\""+first.getId()+"\",\"text\":\"Приватная заметка\"}")).isEqualTo(201);
		var body=Map.of("taskId",id,"version",1,"requesterId",second.getId());
		var start=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return legacy("/api/task/notify",authorCookie,"manual-reminder-same",body).andReturn().getResponse();});
			var b=pool.submit(()->{start.await();return legacy("/api/task/notify",authorCookie,"manual-reminder-same",body).andReturn().getResponse();});
			start.countDown(); var ra=a.get(); var rb=b.get();
			assertThat(ra.getStatus()).isEqualTo(200); assertThat(rb.getStatus()).isEqualTo(200);
			assertThat(List.of(ra.getHeader("Idempotency-Replayed")==null?"new":"replay",rb.getHeader("Idempotency-Replayed")==null?"new":"replay")).containsExactlyInAnyOrder("new","replay");
			var result=json.readTree(ra.getContentAsString()); assertThat(result.path("queued").asInt()).isEqualTo(1);
			assertThat(result.path("delivered").asInt()).isZero(); assertThat(result.path("unavailable").asInt()).isEqualTo(1);
		}
		var payload=json.readTree(jdbc.queryForObject("select payload::text from outbox_events where event_type='task.manual_reminder'",String.class));
		assertThat(payload.path("disableNotification").asBoolean()).isTrue();
		assertThat(payload.path("audienceUserIds").size()).isEqualTo(2); assertThat(payload.path("recipientSnapshot").size()).isEqualTo(2);
		assertThat(payload.toString()).doesNotContain("Приватная заметка");
		assertThat(jdbc.queryForObject("select version from tasks where id=?",Long.class,id)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from task_status_history where task_id=?",Long.class,id)).isEqualTo(2);
		legacy("/api/task/notify",authorCookie,"manual-reminder-same",Map.of("taskId",id,"version",0)).andExpect(status().isConflict());
	}
	@Test void manualReminderChecksActorVersionRecipientsAndCancellation() throws Exception {
		var id=create(List.of(first.getId()));
		legacy("/api/task/notify",secondCookie,"manual-spoof-author",Map.of("taskId",id,"version",0,"requesterId",author.getId())).andExpect(status().isForbidden());
		legacy("/api/task/notify",facultyCookie,"manual-faculty-denied",Map.of("taskId",id,"version",0)).andExpect(status().isForbidden());
		legacy("/api/task/notify",authorCookie,"manual-stale-version",Map.of("taskId",id,"version",5)).andExpect(status().isConflict());
		legacy("/api/task/notify",authorCookie,"manual-no-version",Map.of("taskId",id)).andExpect(status().isBadRequest());
		jdbc.update("update users set active=false,deactivated_at=now() where id=?",first.getId());
		legacy("/api/task/notify",authorCookie,"manual-inactive-target",Map.of("taskId",id,"version",0)).andExpect(status().isBadRequest());
		assertThat(command(id,"cancel",authorCookie,"manual-cancel-task","{\"expectedVersion\":0}")).isEqualTo(200);
		legacy("/api/task/notify",authorCookie,"manual-cancelled-target",Map.of("taskId",id,"version",1)).andExpect(status().isConflict());
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where event_type='task.manual_reminder'",Long.class)).isZero();
	}
	@Test void manualReminderWithoutAssignmentAndFailedOutboxLeaveNoPartialRecords() throws Exception {
		var id=create(List.of());
		legacy("/api/task/notify",authorCookie,"manual-unassigned",Map.of("taskId",id,"version",0)).andExpect(status().isBadRequest());
		assertThat(command(id,"claim",firstCookie,"manual-claim-task","{\"expectedVersion\":0}")).isEqualTo(200);
		jdbc.execute("alter table outbox_events add constraint simulated_manual_failure check (event_type<>'task.manual_reminder') not valid");
		try { legacy("/api/task/notify",authorCookie,"manual-outbox-failure",Map.of("taskId",id,"version",1)).andExpect(status().isConflict()); }
		finally { jdbc.execute("alter table outbox_events drop constraint simulated_manual_failure"); }
		assertThat(jdbc.queryForObject("select count(*) from idempotency_requests where request_key='manual-outbox-failure'",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from audit_events where action='manual_reminder'",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where event_type='task.manual_reminder'",Long.class)).isZero();
	}
	@Test void legacyArchivePreviewClearPreservesActiveTasksHistoryAndSupportsRecovery() throws Exception {
		var id=create(List.of(first.getId())); var active=createExtended(extendedBody()); var admin=maintenanceAdmin();
		assertThat(command(id,"status",firstCookie,"legacy-archive-complete","{\"expectedVersion\":0,\"status\":\"completed\"}")).isEqualTo(200);
		var preview=legacyPreview("archive",admin); assertThat(preview.path("count").asInt()).isEqualTo(1);
		assertThat(preview.path("completedCount").asInt()).isEqualTo(1); assertThat(preview.path("cancelledCount").asInt()).isZero();
		var body=Map.of("fingerprint",preview.path("fingerprint").asText(),"taskIds",List.of(id),"requesterId",author.getId());
		var response=legacy("/api/task/archive/clear",admin,"legacy-archive-clear",body).andExpect(status().isOk())
				.andExpect(jsonPath("$.removedCount").value(1)).andExpect(jsonPath("$.remainingCount").value(1)).andReturn().getResponse();
		var recovery=json.readTree(response.getContentAsString()).path("backupId").asText(); assertThat(recovery).startsWith("recovery_");
		legacy("/api/task/archive/clear",admin,"legacy-archive-clear",body).andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		mvc.perform(get("/api/v1/tasks/{id}",active).cookie(authorCookie)).andExpect(status().isOk());
		mvc.perform(get("/api/v1/tasks/{id}",id).cookie(authorCookie)).andExpect(status().isNotFound());
		assertThat(jdbc.queryForObject("select count(*) from task_status_history where task_id=?",Long.class,id)).isEqualTo(2);
		mvc.perform(post("/api/v1/tasks/recovery/{id}/restore",recovery).cookie(admin).header("Origin","http://localhost").header("Idempotency-Key","legacy-archive-restore")).andExpect(status().isOk());
		mvc.perform(get("/api/v1/tasks/{id}",id).cookie(admin)).andExpect(jsonPath("$.status").value("completed"));
	}
	@Test void legacyResetRejectsStaleVersionsIdsMissingFingerprintAndWrongConfirmation() throws Exception {
		var id=create(List.of(first.getId())); var admin=maintenanceAdmin(); var preview=legacyPreview("season-reset",admin);
		legacy("/api/task/season-reset",admin,"legacy-reset-no-fingerprint",Map.of("taskIds",List.of(id),"confirmation","СБРОСИТЬ СЕЗОН")).andExpect(status().isBadRequest());
		legacy("/api/task/season-reset",admin,"legacy-reset-wrong-ids",Map.of("fingerprint",preview.path("fingerprint").asText(),"taskIds",List.of("wrong"),"confirmation","СБРОСИТЬ СЕЗОН")).andExpect(status().isConflict());
		legacy("/api/task/season-reset",admin,"legacy-reset-no-confirmation",Map.of("fingerprint",preview.path("fingerprint").asText())).andExpect(status().isBadRequest());
		assertThat(command(id,"comments",firstCookie,"legacy-reset-change","{\"expectedVersion\":0,\"side\":\"executor\",\"text\":\"Изменение\"}")).isEqualTo(201);
		legacy("/api/task/season-reset",admin,"legacy-reset-stale-version",Map.of("fingerprint",preview.path("fingerprint").asText(),"taskIds",List.of(id),"confirmation","СБРОСИТЬ СЕЗОН")).andExpect(status().isConflict());
		assertThat(jdbc.queryForObject("select count(*) from task_recovery_operations",Long.class)).isZero();
		var current=legacyPreview("season-reset",admin);
		var body=Map.of("fingerprint",current.path("fingerprint").asText(),"confirmation","СБРОСИТЬ СЕЗОН");
		legacy("/api/task/season-reset",admin,"legacy-reset-valid",body).andExpect(status().isOk()).andExpect(jsonPath("$.removedCount").value(1));
		legacy("/api/task/season-reset",admin,"legacy-reset-valid",body).andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		assertThat(jdbc.queryForObject("select count(*) from tasks where removed_at is null",Long.class)).isZero();
	}
	@Test void legacyMaintenancePermissionsGoneEndpointAndEmptyArchiveAreExplicit() throws Exception {
		create(List.of()); var admin=maintenanceAdmin();
		for(var path:List.of("/api/task/archive/preview","/api/task/season-reset/preview","/api/task/log/clear")) {
			legacy(path,authorCookie,"legacy-admin-denied",Map.of("requesterId",json.readTree("{}").toString())).andExpect(status().isForbidden());
			legacy(path,facultyCookie,"legacy-faculty-admin-denied",Map.of()).andExpect(status().isForbidden());
		}
		legacy("/api/task/archive/clear",authorCookie,"legacy-clear-denied",Map.of("fingerprint","0".repeat(64))).andExpect(status().isForbidden());
		legacy("/api/task/season-reset",authorCookie,"legacy-reset-denied",Map.of("fingerprint","0".repeat(64),"confirmation","СБРОСИТЬ СЕЗОН")).andExpect(status().isForbidden());
		legacy("/api/task/log/clear",admin,"legacy-log-gone",Map.of()).andExpect(status().isGone());
		var preview=legacyPreview("archive",admin);
		legacy("/api/task/archive/clear",admin,"legacy-empty-archive",Map.of("fingerprint",preview.path("fingerprint").asText(),"taskIds",List.of()))
				.andExpect(status().isOk()).andExpect(jsonPath("$.removedCount").value(0)).andExpect(jsonPath("$.changed").value(false));
		assertThat(jdbc.queryForObject("select count(*) from task_recovery_operations",Long.class)).isZero();
	}
	@Test void legacyResetCancelsQueuedManualReminderAndRemovedTaskCannotNotify() throws Exception {
		var id=create(List.of(first.getId())); var admin=maintenanceAdmin(); var preview=legacyPreview("season-reset",admin);
		legacy("/api/task/notify",authorCookie,"manual-before-reset",Map.of("taskId",id,"version",0)).andExpect(status().isOk());
		legacy("/api/task/season-reset",admin,"legacy-reset-with-manual",Map.of("fingerprint",preview.path("fingerprint").asText(),"confirmation","СБРОСИТЬ СЕЗОН")).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("select status from outbox_events where event_type='task.manual_reminder'",String.class)).isEqualTo("cancelled");
		legacy("/api/task/notify",authorCookie,"manual-after-reset",Map.of("taskId",id,"version",1)).andExpect(status().isNotFound());
	}
	@Test void legacyCurrentExportIsAdminOnlyPagedEscapedAndSeparateFromHistory() throws Exception {
		var request=extendedBody(); request.put("title","=HYPERLINK(\"evil\")"); request.put("description","<script>\";\nтекст");
		var id=createExtended(request); var other=create(List.of()); var admin=maintenanceAdmin();
		assertThat(command(id,"status",firstCookie,"legacy-export-complete","{\"expectedVersion\":0,\"status\":\"completed\"}")).isEqualTo(200);
		mvc.perform(get("/api/task/export").cookie(authorCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/task/export").cookie(facultyCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/task/export").cookie(admin).param("limit","0")).andExpect(status().isBadRequest());
		mvc.perform(get("/api/task/export").cookie(admin).param("cursor","missing")).andExpect(status().isBadRequest());
		var response=mvc.perform(get("/api/task/export").cookie(admin).param("limit","1")).andExpect(status().isOk())
				.andExpect(header().string("Content-Type","text/csv; charset=UTF-8")).andExpect(header().string("Cache-Control","no-store"))
				.andExpect(header().string("X-Content-Type-Options","nosniff")).andReturn().getResponse();
		var next=response.getHeader("X-Next-Cursor"); assertThat(next).isNotBlank();
		var last=mvc.perform(get("/api/task/export").cookie(admin).param("limit","1").param("cursor",next)).andExpect(status().isOk()).andReturn().getResponse();
		assertThat(last.getHeader("X-Next-Cursor")).isNull();
		var csv=response.getContentAsString(java.nio.charset.StandardCharsets.UTF_8)+last.getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
		assertThat(csv).contains("\"'=HYPERLINK(\"\"evil\"\")\"","<script>\"\";\nтекст",id,other,"Проверить кабель");
		var preview=legacyPreview("archive",admin);
		legacy("/api/task/archive/clear",admin,"legacy-export-clear",Map.of("fingerprint",preview.path("fingerprint").asText())).andExpect(status().isOk());
		var current=mvc.perform(get("/api/task/export").cookie(admin)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
		assertThat(current).contains(other).doesNotContain(id);
		var history=mvc.perform(get("/api/v1/tasks/export").cookie(admin)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
		assertThat(history).contains(id);
	}
	@Test void legacyResetBackupFailureRollsBackTasksQueueAuditAndReplayRecord() throws Exception {
		var id=create(List.of(first.getId())); var admin=maintenanceAdmin(); var preview=legacyPreview("season-reset",admin);
		legacy("/api/task/notify",authorCookie,"manual-before-backup-failure",Map.of("taskId",id,"version",0)).andExpect(status().isOk());
		jdbc.execute("alter table task_recovery_operations add constraint simulated_legacy_backup_failure check (false) not valid");
		try {
			legacy("/api/task/season-reset",admin,"legacy-reset-backup-failure",Map.of("fingerprint",preview.path("fingerprint").asText(),"confirmation","СБРОСИТЬ СЕЗОН"))
					.andExpect(status().isConflict());
		} finally { jdbc.execute("alter table task_recovery_operations drop constraint simulated_legacy_backup_failure"); }
		assertThat(jdbc.queryForObject("select count(*) from task_recovery_operations",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from tasks where removed_at is null and version=0",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select status from outbox_events where event_type='task.manual_reminder'",String.class)).isEqualTo("pending");
		assertThat(jdbc.queryForObject("select count(*) from idempotency_requests where request_key='legacy-reset-backup-failure'",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_type='task_maintenance'",Long.class)).isZero();
	}
	@Test void legacyReminderRacingResetCannotLeaveLiveQueueForRemovedTask() throws Exception {
		var id=create(List.of(first.getId())); var admin=maintenanceAdmin(); var preview=legacyPreview("season-reset",admin); var start=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var notification=pool.submit(()->{start.await();return legacy("/api/task/notify",authorCookie,"manual-reset-race",Map.of("taskId",id,"version",0)).andReturn().getResponse().getStatus();});
			var reset=pool.submit(()->{start.await();return legacy("/api/task/season-reset",admin,"legacy-reset-race",Map.of("fingerprint",preview.path("fingerprint").asText(),"confirmation","СБРОСИТЬ СЕЗОН")).andReturn().getResponse().getStatus();});
			start.countDown(); assertThat(notification.get()).isIn(200,404); assertThat(reset.get()).isEqualTo(200);
		}
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where aggregate_id=? and status in ('pending','retry','processing')",Long.class,id)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from tasks where removed_at is null",Long.class)).isZero();
	}
	@Test void legacyFinalCommandRereadsCancelledStatusAndCurrentSessionRole() throws Exception {
		var id=create(List.of(first.getId()));
		assertThat(command(id,"cancel",authorCookie,"final-command-cancel","{\"expectedVersion\":0}")).isEqualTo(200);
		legacy("/api/task/comment",firstCookie,"final-command-comment",Map.of("taskId",id,"version",0,"side","executor","text","Старый шаг"))
				.andExpect(status().isConflict());
		legacy("/api/task/status",firstCookie,"final-command-complete",Map.of("taskId",id,"version",0,"status","completed","completionComment","Старый шаг"))
				.andExpect(status().isConflict());
		jdbc.update("update users set role='faculty_helper' where id=?",author.getId());
		legacy("/api/task/update",authorCookie,"final-command-current-role",Map.of("taskId",id,"version",1,"title","Подмена роли","requesterId",first.getId()))
				.andExpect(status().isForbidden());
		assertThat(jdbc.queryForObject("select count(*) from task_comments where task_id=?",Long.class,id)).isZero();
		assertThat(jdbc.queryForObject("select status from tasks where id=?",String.class,id)).isEqualTo("cancelled");
	}
	@Test void archivedEventDoesNotHideUnfinishedTaskAndNullableEventIsPreserved() throws Exception {
		jdbc.update("insert into work_events(id,name,status) values ('task_event','Событие','active')");
		var request=extendedBody(); request.put("eventId","task_event"); var id=createExtended(request);
		jdbc.update("update work_events set status='archived' where id='task_event'");
		mvc.perform(get("/api/v1/tasks/{id}",id).cookie(authorCookie)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("assigned"));
		mvc.perform(get("/api/v1/tasks").cookie(authorCookie)).andExpect(jsonPath("$.length()").value(1));
		mvc.perform(get("/api/state").cookie(authorCookie)).andExpect(jsonPath("$.tasks[0].eventId").value("task_event"));
		legacy("/api/task/update",authorCookie,"archived-event-preserve",Map.of("taskId",id,"version",0,"title","После события"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.task.eventId").value("task_event"));
		var remove=new java.util.LinkedHashMap<String,Object>(); remove.put("taskId",id); remove.put("version",1); remove.put("eventId",null);
		legacy("/api/task/update",authorCookie,"archived-event-remove",remove).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("select event_id from tasks where id=?",String.class,id)).isNull();
		legacy("/api/task/update",authorCookie,"archived-event-reassign",Map.of("taskId",id,"version",2,"eventId","task_event"))
				.andExpect(status().isBadRequest());
		assertThat(jdbc.queryForObject("select count(*) from task_status_history where task_id=? and details->>'eventId'='task_event'",Long.class,id)).isEqualTo(2);
	}
	@Test void legacyClaimRequiresMatchingCompetencyBeforeAssignment() throws Exception {
		jdbc.update("insert into competencies(id,name,scope) values ('claim_comp','Блок','core')");
		var request=extendedBody(); request.put("assigneeIds",List.of()); request.put("competencyIds",List.of("claim_comp"));
		var id=createExtended(request); var body=Map.of("taskId",id,"version",0);
		legacy("/api/task/claim",firstCookie,"claim-comp-required",body).andExpect(status().isForbidden());
		assertThat(jdbc.queryForObject("select count(*) from task_assignees where task_id=?",Long.class,id)).isZero();
		jdbc.update("insert into user_competencies(user_id,competency_id) values (?,'claim_comp')",first.getId());
		legacy("/api/task/claim",firstCookie,"claim-comp-required",body).andExpect(status().isOk()).andExpect(jsonPath("$.task.assignedTo[0]").value(first.getId()));
	}
	@Test void legacyFacultyReleaseCannotRemoveColleagueOrClaimFacultyBoard() throws Exception {
		jdbc.update("insert into faculties(id,name) values ('release_fac','Факультет')");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values (?,'release_fac','helper')",faculty.getId());
		var colleague=users.saveAndFlush(new UserEntity(305L,"faculty_colleague","Коллега","faculty_helper"));
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values (?,'release_fac','helper')",colleague.getId());
		var request=extendedBody(); request.put("facultyId","release_fac"); request.put("assigneeIds",List.of(faculty.getId(),colleague.getId()));
		var id=createExtended(request);
		legacy("/api/task/release",facultyCookie,"faculty-own-release",Map.of("taskId",id,"version",0,"userId",colleague.getId()))
				.andExpect(status().isOk()).andExpect(jsonPath("$.becameOpen").value(false))
				.andExpect(jsonPath("$.remainingAssigneeIds[0]").value(colleague.getId()));
		assertThat(jdbc.queryForList("select user_id from task_assignees where task_id=?",String.class,id)).containsExactly(colleague.getId());
		legacy("/api/task/claim",authorCookie,"faculty-core-claim-denied",Map.of("taskId",id,"version",1)).andExpect(status().isForbidden());
		legacy("/api/task/status",facultyCookie,"faculty-released-old-button",Map.of("taskId",id,"version",1,"status","completed"))
				.andExpect(status().isForbidden());
	}
	private tools.jackson.databind.JsonNode legacyPreview(String mode,Cookie admin) throws Exception {
		return json.readTree(legacy("/api/task/"+mode+"/preview",admin,"legacy-preview-read",Map.of()).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
	}
	private org.springframework.test.web.servlet.ResultActions legacy(String path,Cookie actor,String key,Map<String,?> payload) throws Exception {
		return mvc.perform(post(path).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key",key)
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(payload)));
	}
	private Cookie maintenanceAdmin() {
		return cookie(users.saveAndFlush(new UserEntity(306L,"maintenance_admin","Admin","admin")));
	}
	private tools.jackson.databind.JsonNode maintenancePreview(String mode,Cookie admin) throws Exception {
		return json.readTree(mvc.perform(get("/api/v1/tasks/{mode}/preview",mode).cookie(admin)).andExpect(status().isOk())
				.andReturn().getResponse().getContentAsString());
	}
}
