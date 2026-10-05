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
class TaskUpdateDeliveryIntegrationTests {
	@Autowired JdbcTemplate jdbc;@Autowired MockMvc mvc;@Autowired SessionService sessions;
	@Autowired TaskManualPlanner planner;@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired ObjectMapper json;
	Cookie actor;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,faculties,competencies,tasks,outbox_events,audit_events,idempotency_requests,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',1100,'author','Координатор','organizer',true),('u',null,'old','Прежний','organizer',true),('v',1102,'new','Новый','organizer',true)");
		jdbc.update("insert into tasks(id,title,description,sow,priority,status,creator_id) values ('t','Старое название','','','normal','assigned','a')");
		jdbc.update("insert into task_assignees(task_id,user_id) values ('t','u')");actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());
	}
	void update(List<String> assigned,List<String> competencies,String faculty) throws Exception {
		var body=new java.util.LinkedHashMap<String,Object>();body.put("title","Новое название");body.put("description","SECRET_DESCRIPTION");body.put("sow","SECRET_SOW");body.put("priority","normal");
		body.put("expectedVersion",0);body.put("assigneeIds",assigned);body.put("competencyIds",competencies);body.put("facultyId",faculty);
		mvc.perform(patch("/api/v1/tasks/t").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","task-update-001")
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isOk());
	}
	@Test void newExecutorGetsSilentUpdateWhileRemovedExecutorGetsNoNewDetails() throws Exception {
		update(List.of("v"),List.of(),null);update(List.of("v"),List.of(),null);
		assertThat(planner.materialize(20)).isEqualTo(1);assertThat(planner.materialize(20)).isZero();
		assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("v");
		var sender=new BroadcastDispatcher(queue,quota,m->{
			assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(m.chatId()).isEqualTo(1102);assertThat(m.silent()).isTrue();
			assertThat(m.text()).contains("Задача изменена","Новое название").doesNotContain("SECRET");return TelegramTransport.Outcome.sent(91);
		},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(jdbc.queryForObject("select category from notification_deliveries",String.class)).isEqualTo("task_updated");
	}
	@Test void becomingOpenUsesCompetenciesAndDoesNotExpandFrozenAudience() throws Exception {
		jdbc.update("insert into competencies(id,name,scope) values ('c','Компетенция','core')");jdbc.update("insert into user_competencies(user_id,competency_id) values ('v','c')");
		update(List.of(),List.of("c"),null);jdbc.update("insert into user_competencies(user_id,competency_id) values ('u','c')");
		planner.materialize(20);assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("v");
		jdbc.update("delete from user_competencies where user_id='v'");var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
	@Test void versionActorAssignmentBindingAndClosedStateAreRechecked() throws Exception {
		for(var mutation:List.of("update tasks set version=version+1","delete from task_assignees","update users set telegram_id=9999 where id='v'","update tasks set creator_id='u'","update users set active=false,deactivated_at=now() where id='a'","update tasks set status='completed',completed_at=now()","update task_manual_intents set state='cancelled'")) {
			prepare();update(List.of("v"),List.of(),null);planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.execute(mutation);
			assertThat(queue.start(lease.id(),lease.token())).as(mutation).isFalse();assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		}
	}
	@Test void inProgressAndFacultyAllUpdatesUseCurrentEligibility() throws Exception {
		jdbc.update("update users set telegram_id=1101 where id='u'");
		jdbc.update("update tasks set status='in_progress'");update(List.of("u"),List.of(),null);planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		for(var scope:List.of("f","all")) {
			prepare();jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update tasks set faculty_id=?,faculty_all=?",scope.equals("all")?null:scope,scope.equals("all"));
			jdbc.update("update users set role='faculty_helper' where id='v'");jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('v','f','helper')");
			update(List.of("v"),List.of(),scope);planner.materialize(20);jdbc.update("update faculties set active=false where id='f'");
			var claimed=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(claimed.id(),claimed.token())).isFalse();
		}
	}
	@Test void legacyUnauditedExpiredAndFutureSourcesFailClosed() throws Exception {
		update(List.of("v"),List.of(),null);jdbc.update("update outbox_events set payload=payload-'recipientSnapshot'");planner.materialize(20);assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
		prepare();update(List.of("v"),List.of(),null);jdbc.update("delete from audit_events");planner.materialize(20);assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
		prepare();update(List.of("v"),List.of(),null);jdbc.update("update outbox_events set available_at=now()-interval '16 minutes'");planner.materialize(20);assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("expired");
		prepare();update(List.of("v"),List.of(),null);jdbc.update("update outbox_events set available_at=now()+interval '1 hour'");assertThat(planner.materialize(20)).isZero();
	}
	@Test void rollbackTwoWorkersAndUnknownNeverLoseOrDuplicateUpdate() throws Exception {
		update(List.of("v"),List.of(),null);jdbc.execute("alter table notification_deliveries add constraint simulated_update_failure check (task_manual_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class); }finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_update_failure"); }
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");assertThat(jdbc.queryForObject("select count(*) from task_manual_intents",Integer.class)).isZero();
		var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return planner.materialize(20);});var b=pool.submit(()->{start.await();return planner.materialize(20);});start.countDown();assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}
		var sender=new BroadcastDispatcher(queue,quota,m->TelegramTransport.Outcome.unknown("response_timeout"),json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(planner.materialize(20)).isZero();assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("unknown");
	}
	void removeExecutor() throws Exception {
		jdbc.update("update users set telegram_id=1101 where id='u'");update(List.of("v"),List.of(),null);
	}
	@Test void removalUsesOnlyOldTitleAndReplaysNeitherAudience() throws Exception {
		removeExecutor();update(List.of("v"),List.of(),null);assertThat(planner.materialize(20)).isEqualTo(1);assertThat(planner.materialize(20)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isEqualTo(2);
		var sent=new java.util.ArrayList<Long>();var sender=new BroadcastDispatcher(queue,quota,m->{
			assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(m.silent()).isTrue();sent.add(m.chatId());
			if(m.chatId()==1101)assertThat(m.text()).contains("назначение","снято","Старое название").doesNotContain("Новое название","SECRET");
			else assertThat(m.chatId()).isEqualTo(1102);return TelegramTransport.Outcome.sent(92);
		},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();jdbc.update("update delivery_rate_limits set next_at=now()-interval '1 second'");assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(sent).containsExactlyInAnyOrder(1101L,1102L);
		prepare();jdbc.update("update users set telegram_id=1101 where id='u'");update(List.of(),List.of(),null);planner.materialize(20);
		assertThat(jdbc.queryForList("select category from notification_deliveries where recipient_id='u'",String.class)).containsExactlyInAnyOrder("task_updated","task_unassigned");
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isEqualTo(3);
	}
	@Test void removalRechecksReassignmentVersionBindingActorAndClosedState() throws Exception {
		for(var mutation:List.of("insert into task_assignees(task_id,user_id) values ('t','u')","update tasks set version=version+1","update users set telegram_id=9999 where id='u'","update users set active=false,deactivated_at=now() where id='u'","update users set registered=false where id='u'","update tasks set creator_id='v'","update users set active=false,deactivated_at=now() where id='a'","update tasks set status='completed',completed_at=now()","update tasks set status='cancelled',cancelled_at=now()","update task_manual_intents set state='cancelled'","update outbox_events set payload=payload-'removedAssigneeIds'")) {
			prepare();removeExecutor();planner.materialize(20);var removal=queue.claimSupported(10,Duration.ofSeconds(30)).stream().filter(l->jdbc.queryForObject("select category from notification_deliveries where id=?",String.class,l.id()).equals("task_unassigned")).findFirst().orElseThrow();
			jdbc.execute(mutation);assertThat(queue.start(removal.id(),removal.token())).as(mutation).isFalse();assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		}
	}
	@Test void selfRemovalDoesNotNotifyActorAndUnchangedAssignmentCreatesNoRemoval() throws Exception {
		jdbc.update("insert into task_assignees(task_id,user_id) values ('t','a')");update(List.of("u"),List.of(),null);planner.materialize(20);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where category='task_unassigned'",Integer.class)).isZero();
		assertThat(jdbc.queryForObject("select payload->'removedAssigneeIds' from outbox_events",String.class)).isEqualTo("[]");
	}
	@Test void removalSnapshotCannotAddRecipientsOrReplaceOldTitleWithoutAudit() throws Exception {
		for(var mutation:List.of("update outbox_events set payload=jsonb_set(payload,'{previousTitle}','\"FORGED_TITLE\"')","update outbox_events set payload=payload-'removedRecipientSnapshot'","update outbox_events set payload=jsonb_set(payload,'{removedAssigneeIds}','[\"v\"]')","delete from audit_events")) {
			prepare();removeExecutor();jdbc.execute(mutation);planner.materialize(20);
			assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).as(mutation).isEqualTo("failed");assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
		}
	}
	@Test void removalRemainsPrivateForFacultyAllAndDoesNotRequireNewAccess() throws Exception {
		for(var scope:List.of("f","all")) {
			prepare();jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update tasks set faculty_id=?,faculty_all=?",scope.equals("all")?null:scope,scope.equals("all"));
			jdbc.update("update users set role='faculty_helper',telegram_id=case when id='u' then 1101 else telegram_id end where id in ('u','v')");jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper'),('v','f','helper')");
			update(List.of("v"),List.of(),scope);jdbc.update("delete from faculty_memberships where user_id='u'");planner.materialize(20);
			assertThat(jdbc.queryForObject("select payload->>'text' from notification_deliveries where category='task_unassigned'",String.class)).contains("Старое название").doesNotContain("Новое название","SECRET");
			var removal=queue.claimSupported(10,Duration.ofSeconds(30)).stream().filter(l->jdbc.queryForObject("select category from notification_deliveries where id=?",String.class,l.id()).equals("task_unassigned")).findFirst().orElseThrow();assertThat(queue.start(removal.id(),removal.token())).isTrue();
		}
	}
	@Test void twoPlannersCreateOneRemovalAndUnknownIsNotReplayed() throws Exception {
		removeExecutor();var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return planner.materialize(20);});var b=pool.submit(()->{start.await();return planner.materialize(20);});start.countDown();assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where category='task_unassigned'",Integer.class)).isEqualTo(1);
		var sender=new BroadcastDispatcher(queue,quota,m->TelegramTransport.Outcome.unknown("response_timeout"),json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();jdbc.update("update delivery_rate_limits set next_at=now()-interval '1 second'");assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(planner.materialize(20)).isZero();
		assertThat(jdbc.queryForObject("select status from notification_deliveries where category='task_unassigned'",String.class)).isEqualTo("unknown");
	}
	@Test void removalRollbackExpiryAndFutureDoNotPartiallySend() throws Exception {
		removeExecutor();jdbc.execute("alter table notification_deliveries add constraint simulated_removal_failure check (category<>'task_unassigned') not valid");
		try {assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class);}finally {jdbc.execute("alter table notification_deliveries drop constraint simulated_removal_failure");}
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();assertThat(jdbc.queryForObject("select count(*) from task_manual_intents",Integer.class)).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");
		jdbc.update("update outbox_events set available_at=now()+interval '1 hour'");assertThat(planner.materialize(20)).isZero();
		jdbc.update("update outbox_events set available_at=now()-interval '16 minutes'");planner.materialize(20);assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("expired");assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
	}
	@Test void legacyUpdateProducesTheSameRemovalSnapshot() throws Exception {
		jdbc.update("update users set telegram_id=1101 where id='u'");
		for(int replay=0;replay<2;replay++)mvc.perform(post("/api/task/update").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","legacy-removal-001").contentType(MediaType.APPLICATION_JSON)
				.content("{\"taskId\":\"t\",\"version\":0,\"title\":\"Новое название\",\"assignedTo\":[\"v\"]}")).andExpect(status().isOk());
		assertThat(planner.materialize(20)).isEqualTo(1);assertThat(jdbc.queryForObject("select payload->>'text' from notification_deliveries where category='task_unassigned'",String.class)).contains("Старое название").doesNotContain("Новое название");
	}
}
