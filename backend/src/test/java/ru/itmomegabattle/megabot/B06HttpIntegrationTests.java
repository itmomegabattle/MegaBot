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
	private Cookie cookie(UserEntity user) { return new Cookie("megabot_session",sessions.rotateFor(user.getId()).rawToken()); }
}
