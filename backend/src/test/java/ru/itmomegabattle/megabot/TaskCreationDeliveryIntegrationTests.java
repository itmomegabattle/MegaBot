package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.notifications.*;
import ru.itmomegabattle.megabot.tasks.TaskManualPlanner;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class) @SpringBootTest @AutoConfigureMockMvc
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TaskCreationDeliveryIntegrationTests {
	@Autowired JdbcTemplate jdbc;@Autowired MockMvc mvc;@Autowired SessionService sessions;
	@Autowired TaskManualPlanner planner;@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired ObjectMapper json;
	Cookie actor;String task;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,faculties,tasks,outbox_events,audit_events,idempotency_requests,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',1100,'actor','Координатор','organizer',true),('u',1101,'user','Исполнитель','organizer',true),('v',1102,'other','Другой','organizer',true)");
		actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());
	}
	String create(boolean open,String faculty,List<String> competencies) throws Exception {
		var body=new java.util.LinkedHashMap<String,Object>();body.put("title","Проверить оборудование");body.put("description","SECRET_DESCRIPTION");body.put("sow","SECRET_SOW");
		body.put("priority","normal");body.put("facultyId",faculty);body.put("assigneeIds",open?List.of():List.of("u"));body.put("competencyIds",competencies);
		var response=mvc.perform(post("/api/v1/tasks").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","task-creation-001")
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isCreated()).andReturn().getResponse();
		task=json.readTree(response.getContentAsString()).path("id").asText();return task;
	}
	long deliveries() { return jdbc.queryForObject("select count(*) from notification_deliveries",Long.class); }
	String sourceStatus() { return jdbc.queryForObject("select status from outbox_events where event_type='task.created'",String.class); }
	@Test void assignedHttpReplayMaterializesOnceAndSendsOnlySilentMinimalText() throws Exception {
		var id=create(false,null,List.of());assertThat(create(false,null,List.of())).isEqualTo(id);
		assertThat(planner.materialize(20)).isEqualTo(1);assertThat(planner.materialize(20)).isZero();assertThat(deliveries()).isEqualTo(1);
		assertThat(sourceStatus()).isEqualTo("completed");assertThat(jdbc.queryForObject("select category from notification_deliveries",String.class)).isEqualTo("task_created");
		assertThat(jdbc.queryForObject("select action from task_manual_intents",String.class)).isEqualTo("created");
		var sender=new BroadcastDispatcher(queue,quota,m->{
			assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(m.silent()).isTrue();assertThat(m.chatId()).isEqualTo(1101);
			assertThat(m.text()).contains("Вам назначена задача","Проверить оборудование").doesNotContain("SECRET");return TelegramTransport.Outcome.sent(88);
		},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("sent");
	}
	@Test void openTaskUsesCompetencySnapshotWithoutAuthorOrLaterCompetencyAdditions() throws Exception {
		jdbc.update("insert into competencies(id,name,scope) values ('c','Компетенция','core')");jdbc.update("insert into user_competencies(user_id,competency_id) values ('u','c')");
		create(true,null,List.of("c"));jdbc.update("insert into user_competencies(user_id,competency_id) values ('v','c')");
		planner.materialize(20);assertThat(deliveries()).isEqualTo(1);assertThat(jdbc.queryForObject("select recipient_id from notification_deliveries",String.class)).isEqualTo("u");
		assertThat(jdbc.queryForObject("select payload->>'text' from notification_deliveries",String.class)).contains("Новая открытая задача");
		jdbc.update("delete from user_competencies where user_id='u'");var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
	@Test void openTaskWithoutCompetenciesTargetsCurrentCoreOnly() throws Exception {
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('f',1103,'faculty','Факультет','faculty_helper',true)");
		create(true,null,List.of());planner.materialize(20);assertThat(jdbc.queryForList("select recipient_id from notification_deliveries order by recipient_id",String.class)).containsExactly("u","v");
	}
	@Test void currentVersionAssignmentBindingActorAndStatusAreCheckedBeforeNetwork() throws Exception {
		for(var change:List.of("update tasks set version=version+1","delete from task_assignees","update users set telegram_id=9999 where id='u'","update users set role='faculty_helper' where id='u'","update users set active=false,deactivated_at=now() where id='a'","update tasks set status='completed',completed_at=now()","update tasks set status='cancelled',cancelled_at=now()","update task_manual_intents set state='cancelled'","update outbox_events set event_type='task.updated'")) {
			prepare();create(false,null,List.of());planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.execute(change);
			assertThat(queue.start(lease.id(),lease.token())).as(change).isFalse();assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		}
	}
	@Test void facultyAndAllFacultyRequireActiveMembership() throws Exception {
		for(var scope:List.of("f","all")) {
			prepare();jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update users set role='faculty_helper' where id='u'");
			jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper')");create(false,scope,List.of());planner.materialize(20);assertThat(deliveries()).isEqualTo(1);
			jdbc.update("update faculties set active=false where id='f'");var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();
		}
	}
	@Test void legacySnapshotsFailClosedAndExpiryFutureUnavailableDoNotSend() throws Exception {
		create(false,null,List.of());jdbc.update("update outbox_events set payload=payload-'recipientSnapshot'");planner.materialize(20);assertThat(sourceStatus()).isEqualTo("failed");assertThat(deliveries()).isZero();
		prepare();create(false,null,List.of());jdbc.update("delete from audit_events");planner.materialize(20);assertThat(sourceStatus()).isEqualTo("failed");
		prepare();create(false,null,List.of());jdbc.update("update outbox_events set payload=jsonb_set(payload,'{audienceUserIds}','[\"v\"]'::jsonb)");planner.materialize(20);assertThat(sourceStatus()).isEqualTo("failed");assertThat(deliveries()).isZero();
		prepare();create(false,null,List.of());jdbc.update("update outbox_events set available_at=now()-interval '16 minutes'");planner.materialize(20);assertThat(deliveries()).isZero();assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("expired");
		prepare();create(false,null,List.of());jdbc.update("update outbox_events set available_at=now()+interval '1 hour'");assertThat(planner.materialize(20)).isZero();assertThat(sourceStatus()).isEqualTo("pending");
		prepare();create(false,null,List.of());jdbc.update("update users set telegram_id=null where id='u'");planner.materialize(20);assertThat(deliveries()).isZero();assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("unavailable");
	}
	@Test void rollbackAndConcurrentPlannersNeverLoseOrDuplicateCreation() throws Exception {
		create(false,null,List.of());jdbc.execute("alter table notification_deliveries add constraint simulated_creation_failure check (task_manual_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class); }finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_creation_failure"); }
		assertThat(sourceStatus()).isEqualTo("pending");assertThat(deliveries()).isZero();assertThat(jdbc.queryForObject("select count(*) from task_manual_intents",Integer.class)).isZero();
		var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return planner.materialize(20);});var b=pool.submit(()->{start.await();return planner.materialize(20);});start.countDown();assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}assertThat(deliveries()).isEqualTo(1);
	}
	@Test void unknownCreationIsNeverReplayedAndOtherTaskEventsRemainPending() throws Exception {
		create(false,null,List.of());var sender=new BroadcastDispatcher(queue,quota,m->TelegramTransport.Outcome.unknown("response_timeout"),json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		sender.dispatchOne();create(false,null,List.of());assertThat(planner.materialize(20)).isZero();assertThat(sender.dispatchOne()).isFalse();assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("unknown");
		prepare();create(false,null,List.of());jdbc.update("update outbox_events set event_type='task.unsupported'");assertThat(planner.materialize(20)).isZero();assertThat(sourceStatusForAny()).isEqualTo("pending");
	}
	String sourceStatusForAny() { return jdbc.queryForObject("select status from outbox_events",String.class); }
}
