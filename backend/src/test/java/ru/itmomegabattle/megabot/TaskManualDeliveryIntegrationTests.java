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
class TaskManualDeliveryIntegrationTests {
	@Autowired JdbcTemplate jdbc;@Autowired MockMvc mvc;@Autowired SessionService sessions;
	@Autowired TaskManualPlanner planner;@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired ObjectMapper json;
	Cookie actor;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,faculties,tasks,outbox_events,audit_events,idempotency_requests,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',1100,'actor','Координатор','organizer',true),('u',1101,'user','Исполнитель','organizer',true),('v',1102,'new','Новый','organizer',true)");
		jdbc.update("insert into tasks(id,title,description,sow,priority,status,creator_id) values ('t','Проверить оборудование','Секретное описание','Секретное ТЗ','normal','assigned','a')");
		jdbc.update("insert into task_assignees(task_id,user_id) values ('t','u')");actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());
	}
	String notifyTask() throws Exception {
		var response=mvc.perform(post("/api/task/notify").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","manual-delivery-001")
				.contentType(MediaType.APPLICATION_JSON).content("{\"taskId\":\"t\",\"version\":0}"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.delivered").value(0)).andReturn().getResponse();
		return json.readTree(response.getContentAsString()).path("outboxId").asText();
	}
	String sourceStatus() { return jdbc.queryForObject("select status from outbox_events where event_type='task.manual_reminder'",String.class); }
	long deliveries() { return jdbc.queryForObject("select count(*) from notification_deliveries",Long.class); }
	@Test void httpReplayFrozenAudienceAndProviderConfirmationAreSeparate() throws Exception {
		var source=notifyTask();jdbc.update("insert into task_assignees(task_id,user_id) values ('t','v')");
		assertThat(planner.materialize(20)).isEqualTo(1);assertThat(sourceStatus()).isEqualTo("completed");assertThat(deliveries()).isEqualTo(1);
		assertThat(jdbc.queryForObject("select recipient_id from notification_deliveries",String.class)).isEqualTo("u");
		assertThat(jdbc.queryForObject("select task_manual_id from notification_deliveries",String.class)).isEqualTo(source);
		assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("planned");
		assertThat(notifyTask()).isEqualTo(source);assertThat(planner.materialize(20)).isZero();
		var sender=new BroadcastDispatcher(queue,quota,m->{
			assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(m.text()).contains("Проверить оборудование").doesNotContain("Секретное");
			assertThat(m.silent()).isTrue();assertThat(m.chatId()).isEqualTo(1101);return TelegramTransport.Outcome.sent(77);
		},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();
		assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("sent");
	}
	@Test void currentActorRecipientTaskAndIntentAreRecheckedBeforeFirstAttempt() throws Exception {
		for(var change:List.of("update users set active=false,deactivated_at=now() where id='a'","update users set active=false,deactivated_at=now() where id='u'","update users set telegram_id=2202 where id='u'","delete from task_assignees","update tasks set creator_id='v'","update tasks set version=version+1","update tasks set status='cancelled',cancelled_at=now()","update task_manual_intents set state='cancelled'","update outbox_events set status='cancelled'")) {
			prepare();notifyTask();planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.execute(change);
			assertThat(queue.start(lease.id(),lease.token())).as(change).isFalse();
			assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("cancelled");
			assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Long.class)).isZero();
		}
	}
	@Test void unavailableAndStaleSnapshotsNeverQueueButExplicitCompletedTaskIsAllowed() throws Exception {
		notifyTask();jdbc.update("update users set telegram_id=null where id='u'");planner.materialize(20);
		assertThat(deliveries()).isZero();assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("unavailable");
		assertThat(jdbc.queryForObject("select unavailable_count from task_manual_intents",Integer.class)).isEqualTo(1);
		prepare();notifyTask();jdbc.update("update tasks set version=version+1");planner.materialize(20);assertThat(deliveries()).isZero();
		assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("cancelled");
		prepare();jdbc.update("update tasks set status='completed',completed_at=now()");notifyTask();planner.materialize(20);
		var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
	}
	@Test void expiredRemovedAndFutureSourcesDoNotProduceDelivery() throws Exception {
		notifyTask();jdbc.update("update outbox_events set available_at=now()-interval '16 minutes'");planner.materialize(20);assertThat(deliveries()).isZero();
		assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("expired");
		prepare();notifyTask();jdbc.update("insert into task_recovery_operations(id,mode,actor_id,preview_fingerprint,snapshot,task_count,created_at) values ('removal','archive','a','fixture','[]',1,now())");
		jdbc.update("update tasks set removed_at=now(),removal_operation_id='removal'");planner.materialize(20);assertThat(sourceStatus()).isEqualTo("cancelled");assertThat(deliveries()).isZero();
		prepare();notifyTask();jdbc.update("update outbox_events set available_at=now()+interval '1 hour'");assertThat(planner.materialize(20)).isZero();assertThat(sourceStatus()).isEqualTo("pending");
	}
	@Test void unknownIsNotReplayedByPlannerHttpReplayOrSender() throws Exception {
		notifyTask();var sender=new BroadcastDispatcher(queue,quota,m->TelegramTransport.Outcome.unknown("response_timeout"),json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();notifyTask();assertThat(planner.materialize(20)).isZero();assertThat(sender.dispatchOne()).isFalse();
		assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("unknown");assertThat(deliveries()).isEqualTo(1);
	}
	@Test void atomicRollbackAndTwoWorkersDoNotConsumeOrDuplicateSource() throws Exception {
		notifyTask();jdbc.execute("alter table notification_deliveries add constraint simulated_manual_link_failure check (task_manual_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class); }
		finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_manual_link_failure"); }
		assertThat(sourceStatus()).isEqualTo("pending");assertThat(deliveries()).isZero();assertThat(jdbc.queryForObject("select count(*) from task_manual_intents",Long.class)).isZero();
		var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return planner.materialize(20);});var b=pool.submit(()->{start.await();return planner.materialize(20);});start.countDown();
			assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}assertThat(deliveries()).isEqualTo(1);
	}
	@Test void malformedOrUnauditedSourceFailsClosedAndOtherEventsAreNotConsumed() throws Exception {
		notifyTask();jdbc.update("update outbox_events set payload='{}'::jsonb");planner.materialize(20);assertThat(sourceStatus()).isEqualTo("failed");assertThat(deliveries()).isZero();
		prepare();notifyTask();jdbc.update("delete from audit_events");planner.materialize(20);assertThat(sourceStatus()).isEqualTo("failed");assertThat(deliveries()).isZero();
		prepare();notifyTask();jdbc.update("update outbox_events set event_type='task.unsupported'");assertThat(planner.materialize(20)).isZero();assertThat(deliveries()).isZero();
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");
	}
	@Test void facultySnapshotRequiresCurrentMatchingActiveMembership() throws Exception {
		jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update tasks set faculty_id='f'");jdbc.update("update users set role='faculty_helper' where id='u'");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper')");notifyTask();planner.materialize(20);
		assertThat(deliveries()).isEqualTo(1);jdbc.update("update faculties set active=false where id='f'");
		var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
}
