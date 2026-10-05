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
class TaskStatusDeliveryIntegrationTests {
	@Autowired JdbcTemplate jdbc;@Autowired MockMvc mvc;@Autowired SessionService sessions;
	@Autowired TaskManualPlanner planner;@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired ObjectMapper json;
	Cookie actor;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,faculties,competencies,tasks,outbox_events,audit_events,idempotency_requests,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',1100,'author','Координатор','organizer',true),('u',1101,'actor','Исполнитель','organizer',true),('v',null,'other','Другой','organizer',true)");
		jdbc.update("insert into tasks(id,title,description,sow,priority,status,creator_id) values ('t','Оборудование','SECRET_DESCRIPTION','SECRET_SOW','normal','assigned','a')");
		jdbc.update("insert into task_assignees(task_id,user_id) values ('t','u')");actor=new Cookie("megabot_session",sessions.rotateFor("u").rawToken());
	}
	void change(String status) throws Exception {
		mvc.perform(post("/api/v1/tasks/t/status").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","task-status-001")
				.contentType(MediaType.APPLICATION_JSON).content("{\"status\":\""+status+"\",\"expectedVersion\":0,\"completionComment\":\"SECRET_COMMENT\"}"))
				.andExpect(status().isOk());
	}
	@Test void completedHttpReplayAndFakeSendNameActualExecutorWithoutPrivateDetails() throws Exception {
		change("completed");change("completed");assertThat(planner.materialize(20)).isEqualTo(1);assertThat(planner.materialize(20)).isZero();
		assertThat(jdbc.queryForObject("select category from notification_deliveries",String.class)).isEqualTo("task_status");
		assertThat(jdbc.queryForObject("select task_status from task_manual_intents",String.class)).isEqualTo("completed");
		var sender=new BroadcastDispatcher(queue,quota,m->{
			assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(m.silent()).isTrue();assertThat(m.chatId()).isEqualTo(1100);
			assertThat(m.text()).contains("Задача завершена","Оборудование","Исполнитель").doesNotContain("SECRET");return TelegramTransport.Outcome.sent(90);
		},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("sent");
	}
	@Test void intermediateStatusesAlsoNotifyOnlyCoordinator() throws Exception {
		for(var state:List.of("waiting","in_progress")) {
			prepare();change(state);planner.materialize(20);assertThat(jdbc.queryForObject("select recipient_id from notification_deliveries",String.class)).isEqualTo("a");
			var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		}
	}
	@Test void versionStateActorAssignmentAndCoordinatorBindingAreRechecked() throws Exception {
		for(var mutation:List.of("update tasks set version=version+1","update tasks set status='assigned',completed_at=null,completed_by=null","update tasks set completed_by='v'","delete from task_assignees","update users set role='faculty_helper' where id='u'","update users set active=false,deactivated_at=now() where id='u'","update users set telegram_id=9999 where id='a'","update tasks set creator_id='v'","update task_manual_intents set state='cancelled'","update outbox_events set status='cancelled'")) {
			prepare();change("completed");planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.execute(mutation);
			assertThat(queue.start(lease.id(),lease.token())).as(mutation).isFalse();assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		}
	}
	@Test void selfCompletionDoesNotNotifySelfAndFacultyRequiresActorMembership() throws Exception {
		jdbc.update("update tasks set creator_id='u'");change("completed");planner.materialize(20);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
		prepare();jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update tasks set faculty_id='f'");jdbc.update("update users set role='faculty_helper' where id='u'");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper')");change("completed");planner.materialize(20);jdbc.update("update faculties set active=false where id='f'");
		var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
	@Test void invalidUnauditedFutureExpiredAndUnavailableSourcesNeverSend() throws Exception {
		change("completed");jdbc.update("update outbox_events set payload=jsonb_set(payload,'{status}','\"cancelled\"')");planner.materialize(20);assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");prepare();
		change("completed");jdbc.update("delete from audit_events");planner.materialize(20);assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
		prepare();change("completed");jdbc.update("update outbox_events set payload=payload-'recipientSnapshot'");planner.materialize(20);assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
		prepare();change("completed");jdbc.update("update outbox_events set available_at=now()+interval '1 hour'");assertThat(planner.materialize(20)).isZero();
		prepare();change("completed");jdbc.update("update outbox_events set available_at=now()-interval '16 minutes'");planner.materialize(20);assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("expired");
		prepare();change("completed");jdbc.update("update users set telegram_id=null where id='a'");planner.materialize(20);assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("unavailable");
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
	}
	@Test void rollbackAndTwoWorkersDoNotConsumeOrDuplicateStatusSource() throws Exception {
		change("completed");jdbc.execute("alter table notification_deliveries add constraint simulated_status_failure check (task_manual_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class); }finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_status_failure"); }
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");assertThat(jdbc.queryForObject("select count(*) from task_manual_intents",Integer.class)).isZero();
		var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return planner.materialize(20);});var b=pool.submit(()->{start.await();return planner.materialize(20);});start.countDown();assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isEqualTo(1);
	}
	@Test void unknownStatusNotificationIsNotAutomaticallyReplayed() throws Exception {
		change("completed");var sender=new BroadcastDispatcher(queue,quota,m->TelegramTransport.Outcome.unknown("response_timeout"),json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		assertThat(sender.dispatchOne()).isTrue();change("completed");assertThat(sender.dispatchOne()).isFalse();assertThat(planner.materialize(20)).isZero();
		assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("unknown");assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isEqualTo(1);
	}
	void openTask() {jdbc.update("delete from task_assignees");jdbc.update("update tasks set status='open'");}
	void assignment(String action) throws Exception {
		mvc.perform(post("/api/v1/tasks/t/"+action).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","assignment-001").contentType(MediaType.APPLICATION_JSON).content("{\"expectedVersion\":0}")).andExpect(status().isOk());
	}
	@Test void claimAndReleaseReplayNotifyOnlyCoordinatorWithActualActor() throws Exception {
		for(var action:List.of("claim","release")) {
			prepare();if(action.equals("claim"))openTask();assignment(action);assignment(action);assertThat(planner.materialize(20)).isEqualTo(1);assertThat(planner.materialize(20)).isZero();
			assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("a");assertThat(jdbc.queryForObject("select category from notification_deliveries",String.class)).isEqualTo("task_assignment");
			var sender=new BroadcastDispatcher(queue,quota,m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(m.chatId()).isEqualTo(1100);assertThat(m.silent()).isTrue();assertThat(m.text()).contains("Оборудование","Исполнитель",action.equals("claim")?"взята":"отказался").doesNotContain("SECRET");return TelegramTransport.Outcome.sent(99);},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
			assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("sent");
		}
	}
	@Test void releaseWithOtherExecutorsPreservesStatusAndNeverNotifiesThem() throws Exception {
		for(var state:List.of("assigned","waiting","in_progress")) {
			prepare();jdbc.update("insert into task_assignees(task_id,user_id) values ('t','v')");jdbc.update("update tasks set status=?",state);assignment("release");planner.materialize(20);
			assertThat(jdbc.queryForObject("select status from tasks",String.class)).isEqualTo(state);assertThat(jdbc.queryForList("select user_id from task_assignees",String.class)).containsExactly("v");assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("a");
			var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		}
	}
	@Test void assignmentVersionActorCoordinatorBindingAndReversalAreRechecked() throws Exception {
		for(var action:List.of("claim","release"))for(var mutation:List.of("update tasks set version=version+1","update tasks set status='cancelled',cancelled_at=now()","update users set active=false,deactivated_at=now() where id='u'","update users set role='faculty_helper' where id='u'","update tasks set creator_id='v'","update users set telegram_id=9999 where id='a'","update users set registered=false where id='a'","update task_manual_intents set state='cancelled'","update outbox_events set status='cancelled'",action.equals("claim")?"delete from task_assignees":"insert into task_assignees(task_id,user_id) values ('t','u')")) {
			prepare();if(action.equals("claim"))openTask();assignment(action);planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.execute(mutation);assertThat(queue.start(lease.id(),lease.token())).as(action+mutation).isFalse();assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		}
	}
	@Test void claimRequiresCompetencyAtCommandAndAtSend() throws Exception {
		openTask();jdbc.update("insert into competencies(id,name,scope) values ('c','Компетенция','core')");jdbc.update("insert into task_competencies(task_id,competency_id) values ('t','c')");
		mvc.perform(post("/api/v1/tasks/t/claim").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","denied-001").contentType(MediaType.APPLICATION_JSON).content("{\"expectedVersion\":0}")).andExpect(status().isForbidden());assertThat(jdbc.queryForObject("select count(*) from outbox_events",Integer.class)).isZero();
		jdbc.update("insert into user_competencies(user_id,competency_id) values ('u','c')");assignment("claim");planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.update("delete from user_competencies");assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
	@Test void selfAssignmentDoesNotNotifyAndFacultyReleaseRequiresCurrentMembership() throws Exception {
		jdbc.update("update tasks set creator_id='u'");assignment("release");planner.materialize(20);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where recipient_id='u'",Integer.class)).isZero();
		assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("a");
		for(var scope:List.of("f","all")) {
			prepare();jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update tasks set faculty_id=?,faculty_all=?",scope.equals("all")?null:scope,scope.equals("all"));jdbc.update("update users set role='faculty_helper' where id='u'");jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper')");
			assignment("release");planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.update("delete from faculty_memberships");assertThat(queue.start(lease.id(),lease.token())).isFalse();
		}
	}
	@Test void assignmentInvalidUnauditedFutureExpiredAndMissingTargetFailClosed() throws Exception {
		for(var action:List.of("claim","release")) {
			for(var mutation:List.of("delete from audit_events","update outbox_events set payload=payload-'recipientSnapshot'","update outbox_events set payload=jsonb_set(payload,'{status}','\"completed\"')")) {
				prepare();if(action.equals("claim"))openTask();assignment(action);jdbc.execute(mutation);planner.materialize(20);assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
			}
			prepare();if(action.equals("claim"))openTask();assignment(action);jdbc.update("update outbox_events set available_at=now()+interval '1 hour'");assertThat(planner.materialize(20)).isZero();jdbc.update("update outbox_events set available_at=now()-interval '16 minutes'");planner.materialize(20);assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("expired");
			prepare();if(action.equals("claim"))openTask();jdbc.update("update users set telegram_id=null where id='a'");assignment(action);planner.materialize(20);assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("unavailable");
		}
	}
	@Test void assignmentRollbackTwoWorkersAndUnknownDoNotLoseOrDuplicateSource() throws Exception {
		for(var action:List.of("claim","release")) {
			prepare();if(action.equals("claim"))openTask();assignment(action);jdbc.execute("alter table notification_deliveries add constraint simulated_assignment_failure check (category<>'task_assignment') not valid");
			try {assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class);}finally {jdbc.execute("alter table notification_deliveries drop constraint simulated_assignment_failure");}
			assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");assertThat(jdbc.queryForObject("select count(*) from task_manual_intents",Integer.class)).isZero();
			var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {var a=pool.submit(()->{start.await();return planner.materialize(20);});var b=pool.submit(()->{start.await();return planner.materialize(20);});start.countDown();assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);}
			var sender=new BroadcastDispatcher(queue,quota,m->TelegramTransport.Outcome.unknown("response_timeout"),json,"12345",DeliveryQuota.Limits.defaults(),null,planner);assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(planner.materialize(20)).isZero();assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("unknown");
		}
	}
	@Test void legacyClaimAndReleaseUseTheSameSnapshotAndLatestVersionWins() throws Exception {
		openTask();for(var action:List.of("claim","release"))for(int replay=0;replay<2;replay++)mvc.perform(post("/api/task/"+action).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","legacy-"+action+"-001").contentType(MediaType.APPLICATION_JSON).content("{\"taskId\":\"t\",\"version\":"+(action.equals("claim")?0:1)+"}")).andExpect(status().isOk());
		assertThat(planner.materialize(20)).isEqualTo(2);assertThat(jdbc.queryForObject("select state from task_manual_intents where action='claim'",String.class)).isEqualTo("cancelled");assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("a");assertThat(jdbc.queryForObject("select task_status from task_manual_intents where action='release'",String.class)).isEqualTo("open");
	}
	void additionalTarget(String role) {jdbc.update("update users set telegram_id=1102,role=? where id='v'",role);}
	@Test void claimIncludesFrozenAdminsAndDeduplicatesAdminCoordinator() throws Exception {
		openTask();additionalTarget("admin");jdbc.update("update users set role='admin' where id='a'");assignment("claim");assignment("claim");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('z',1103,'late','Поздний','admin',true)");planner.materialize(20);
		assertThat(jdbc.queryForList("select recipient_id from notification_deliveries order by recipient_id",String.class)).containsExactly("a","v");
		assertThat(jdbc.queryForObject("select payload->'recipientSnapshot'->0->>'kind' from outbox_events",String.class)).isEqualTo("coordinator");
		var sent=new java.util.ArrayList<Long>();var sender=new BroadcastDispatcher(queue,quota,m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(m.silent()).isTrue();assertThat(m.text()).contains("взята","Исполнитель").doesNotContain("SECRET");sent.add(m.chatId());return TelegramTransport.Outcome.sent(101);},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
		for(int i=0;i<2;i++){jdbc.update("update delivery_rate_limits set next_at=now()-interval '1 second'");assertThat(sender.dispatchOne()).isTrue();}assertThat(sender.dispatchOne()).isFalse();assertThat(sent).containsExactlyInAnyOrder(1100L,1102L);
	}
	void competenciesForReopening() {
		jdbc.update("insert into competencies(id,name,scope) values ('c','Звук','core'),('d','Свет','core')");jdbc.update("insert into task_competencies(task_id,competency_id) values ('t','c'),('t','d')");jdbc.update("insert into user_competencies(user_id,competency_id) values ('v','d')");
	}
	@Test void reopenedTaskUsesAnyMatchingCompetencyAndFrozenAudienceWithoutPrivateDetails() throws Exception {
		additionalTarget("organizer");competenciesForReopening();jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('z',1103,'wrong','Не подходит','admin',true)");assignment("release");assignment("release");
		jdbc.update("insert into user_competencies(user_id,competency_id) values ('z','c')");planner.materialize(20);
		assertThat(jdbc.queryForList("select recipient_id from notification_deliveries order by recipient_id",String.class)).containsExactly("a","v");
		assertThat(jdbc.queryForObject("select payload->>'text' from notification_deliveries where recipient_id='a'",String.class)).contains("отказался");
		assertThat(jdbc.queryForObject("select payload->>'text' from notification_deliveries where recipient_id='v'",String.class)).contains("Задача снова свободна","Оборудование").doesNotContain("SECRET");
		var lease=queue.claimSupported(10,Duration.ofSeconds(30)).stream().filter(l->l.chatId()==1102).findFirst().orElseThrow();assertThat(queue.start(lease.id(),lease.token())).isTrue();
	}
	@Test void noRequirementReopensForCoreOnlyButPartialReleaseDoesNotBroadcast() throws Exception {
		additionalTarget("organizer");jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('f',1103,'faculty','Факультет','faculty_helper',true)");assignment("release");planner.materialize(20);
		assertThat(jdbc.queryForList("select recipient_id from notification_deliveries order by recipient_id",String.class)).containsExactly("a","v");
		prepare();additionalTarget("organizer");jdbc.update("insert into task_assignees(task_id,user_id) values ('t','v')");assignment("release");planner.materialize(20);assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("a");
		prepare();additionalTarget("faculty_helper");jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update users set role='faculty_helper' where id='u'");jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper'),('v','f','helper')");jdbc.update("update tasks set faculty_id='f'");assignment("release");planner.materialize(20);assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("a");
	}
	@Test void additionalRecipientsRecheckFrozenKindRoleCompetencyBindingAndState() throws Exception {
		for(var action:List.of("claim","release"))for(var mutation:List.of("update users set active=false,deactivated_at=now() where id='v'","update users set registered=false where id='v'","update users set telegram_id=9999 where id='v'","update tasks set version=version+1","update tasks set status='cancelled',cancelled_at=now()",action.equals("claim")?"update users set role='organizer' where id='v'":"delete from user_competencies",action.equals("claim")?"delete from task_assignees":"insert into task_assignees(task_id,user_id) values ('t','v')")) {
			prepare();additionalTarget(action.equals("claim")?"admin":"organizer");if(action.equals("claim"))openTask();else competenciesForReopening();assignment(action);planner.materialize(20);
			var lease=queue.claimSupported(10,Duration.ofSeconds(30)).stream().filter(l->l.chatId()==1102).findFirst().orElseThrow();jdbc.execute(mutation);assertThat(queue.start(lease.id(),lease.token())).as(action+mutation).isFalse();assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		}
	}
	@Test void missingOrUnknownAssignmentKindFailsClosedAndCannotTurnAdminIntoCoordinator() throws Exception {
		for(var mutation:List.of("update outbox_events set payload=jsonb_set(payload,'{recipientSnapshot,1,kind}','\"other\"')","update outbox_events set payload=payload#-'{recipientSnapshot,1,kind}'")) {
			prepare();openTask();additionalTarget("admin");assignment("claim");jdbc.execute(mutation);planner.materialize(20);assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
		}
		prepare();openTask();additionalTarget("admin");assignment("claim");planner.materialize(20);var lease=queue.claimSupported(10,Duration.ofSeconds(30)).stream().filter(l->l.chatId()==1102).findFirst().orElseThrow();jdbc.update("update users set role='organizer' where id='v'");jdbc.update("update tasks set creator_id='v'");assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
	@Test void extraAudienceRollbackTwoWorkersAndUnknownRemainAtomic() throws Exception {
		for(var action:List.of("claim","release")) {
			prepare();additionalTarget(action.equals("claim")?"admin":"organizer");if(action.equals("claim"))openTask();assignment(action);jdbc.execute("alter table notification_deliveries add constraint simulated_extra_target_failure check (recipient_id<>'v') not valid");
			try {assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class);}finally{jdbc.execute("alter table notification_deliveries drop constraint simulated_extra_target_failure");}
			assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");
			var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)){var a=pool.submit(()->{start.await();return planner.materialize(20);});var b=pool.submit(()->{start.await();return planner.materialize(20);});start.countDown();assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);}assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isEqualTo(2);
			var sender=new BroadcastDispatcher(queue,quota,m->TelegramTransport.Outcome.unknown("response_timeout"),json,"12345",DeliveryQuota.Limits.defaults(),null,planner);for(int i=0;i<2;i++){jdbc.update("update delivery_rate_limits set next_at=now()-interval '1 second'");assertThat(sender.dispatchOne()).isTrue();}assertThat(sender.dispatchOne()).isFalse();assertThat(planner.materialize(20)).isZero();assertThat(jdbc.queryForList("select status from notification_deliveries",String.class)).containsExactly("unknown","unknown");
		}
	}
	void comment(String side,String target) throws Exception {
		var body=new java.util.LinkedHashMap<String,Object>();body.put("side",side);body.put("targetAssigneeId",target);body.put("text","SECRET_PRIVATE_COMMENT");body.put("expectedVersion",0);
		mvc.perform(post("/api/v1/tasks/t/comments").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","comment-notice-001").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isCreated());
	}
	void cancelTask() throws Exception {actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());assignment("cancel");}
	@Test void privateCommentReplaySendsOnlyToItsIntendedParticipant() throws Exception {
		for(var side:List.of("executor","coordinator")) {
			prepare();additionalTarget("organizer");jdbc.update("insert into task_assignees(task_id,user_id) values ('t','v')");if(side.equals("coordinator"))actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());comment(side,side.equals("coordinator")?"u":null);comment(side,side.equals("coordinator")?"u":null);
			assertThat(planner.materialize(20)).isEqualTo(1);assertThat(planner.materialize(20)).isZero();assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly(side.equals("executor")?"a":"u");
			var sender=new BroadcastDispatcher(queue,quota,m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(m.silent()).isTrue();assertThat(m.chatId()).isEqualTo(side.equals("executor")?1100:1101);assertThat(m.text()).contains("Новый комментарий","Оборудование").doesNotContain("SECRET");return TelegramTransport.Outcome.sent(102);},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);
			assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("sent");
		}
	}
	@Test void generalCoordinatorCommentFreezesAssignmentsAndNeverNotifiesAuthor() throws Exception {
		actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());additionalTarget("organizer");jdbc.update("insert into task_assignees(task_id,user_id) values ('t','a')");comment("coordinator",null);jdbc.update("insert into task_assignees(task_id,user_id) values ('t','v')");planner.materialize(20);assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("u");
	}
	@Test void cancellationReplayNotifiesExecutorsAndAdminCancellationNotifiesCoordinator() throws Exception {
		cancelTask();assignment("cancel");assertThat(planner.materialize(20)).isEqualTo(1);assertThat(planner.materialize(20)).isZero();assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly("u");
		var sender=new BroadcastDispatcher(queue,quota,m->{assertThat(m.silent()).isTrue();assertThat(m.text()).contains("Задача отменена","Координатор").doesNotContain("SECRET");return TelegramTransport.Outcome.sent(103);},json,"12345",DeliveryQuota.Limits.defaults(),null,planner);assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();
		prepare();additionalTarget("admin");actor=new Cookie("megabot_session",sessions.rotateFor("v").rawToken());assignment("cancel");planner.materialize(20);assertThat(jdbc.queryForList("select recipient_id from notification_deliveries order by recipient_id",String.class)).containsExactly("a","u");
		assertThat(jdbc.queryForObject("select task_status from task_manual_intents",String.class)).isEqualTo("cancelled");
	}
	@Test void commentsAndCancellationRecheckActorVersionBindingAssignmentAndSource() throws Exception {
		for(var action:List.of("comment","cancel"))for(var mutation:List.of("update tasks set version=version+1","update users set active=false,deactivated_at=now() where id='a'","update users set telegram_id=9999 where id='u'","delete from task_assignees","update task_manual_intents set state='cancelled'","update outbox_events set status='cancelled'",action.equals("comment")?"delete from task_comments":"update tasks set cancelled_by='v'",action.equals("comment")?"update tasks set status='waiting'":"update tasks set status='assigned',cancelled_at=null,cancelled_by=null")) {
			prepare();if(action.equals("comment")){actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());comment("coordinator","u");}else cancelTask();planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.execute(mutation);assertThat(queue.start(lease.id(),lease.token())).as(action+mutation).isFalse();assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		}
	}
	@Test void privateCommentCannotRetargetOtherExecutorAndFacultyMembershipIsRequired() throws Exception {
		additionalTarget("organizer");jdbc.update("insert into task_assignees(task_id,user_id) values ('t','v')");actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());comment("coordinator","u");planner.materialize(20);jdbc.update("update notification_deliveries set recipient_id='v',chat_id=1102");var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();
		for(var scope:List.of("f","all"))for(var action:List.of("comment","cancel")) {
			prepare();jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update tasks set faculty_id=?,faculty_all=?",scope.equals("all")?null:scope,scope.equals("all"));jdbc.update("update users set role='faculty_helper' where id='u'");jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper')");if(action.equals("comment")){actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());comment("coordinator","u");}else cancelTask();planner.materialize(20);var claimed=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.update("delete from faculty_memberships");assertThat(queue.start(claimed.id(),claimed.token())).isFalse();
		}
	}
	@Test void commentCancelMalformedUnauditedFutureExpiryAndMissingBindingFailClosed() throws Exception {
		for(var action:List.of("comment","cancel")) {
			for(var mutation:List.of("delete from audit_events","update outbox_events set payload=payload-'recipientSnapshot'","update outbox_events set payload=jsonb_set(payload,'{status}','\"completed\"')")) {
				prepare();if(action.equals("comment"))comment("executor",null);else cancelTask();jdbc.execute(mutation);planner.materialize(20);assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
			}
			prepare();if(action.equals("comment"))comment("executor",null);else cancelTask();jdbc.update("update outbox_events set available_at=now()+interval '1 hour'");assertThat(planner.materialize(20)).isZero();jdbc.update("update outbox_events set available_at=now()-interval '16 minutes'");planner.materialize(20);assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("expired");
			prepare();if(action.equals("comment"))comment("executor",null);else cancelTask();jdbc.update("update users set telegram_id=null where id=?",action.equals("comment")?"a":"u");planner.materialize(20);assertThat(jdbc.queryForObject("select state from task_manual_intents",String.class)).isEqualTo("unavailable");
		}
	}
	@Test void commentCancelRollbackTwoPlannersAndUnknownNeverReplay() throws Exception {
		for(var action:List.of("comment","cancel")) {
			prepare();if(action.equals("comment"))comment("executor",null);else cancelTask();jdbc.execute("alter table notification_deliveries add constraint simulated_mutation_failure check (task_manual_id is null) not valid");try{assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class);}finally{jdbc.execute("alter table notification_deliveries drop constraint simulated_mutation_failure");}
			assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
			var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)){var a=pool.submit(()->{start.await();return planner.materialize(20);});var b=pool.submit(()->{start.await();return planner.materialize(20);});start.countDown();assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);}
			var sender=new BroadcastDispatcher(queue,quota,m->TelegramTransport.Outcome.unknown("response_timeout"),json,"12345",DeliveryQuota.Limits.defaults(),null,planner);assertThat(sender.dispatchOne()).isTrue();assertThat(sender.dispatchOne()).isFalse();assertThat(planner.materialize(20)).isZero();assertThat(jdbc.queryForObject("select status from notification_deliveries",String.class)).isEqualTo("unknown");
		}
	}
	@Test void legacyCommentAndCancelShareNotificationFlowWithoutHistoricalGuessing() throws Exception {
		for(var action:List.of("comment","delete")) {
			prepare();if(action.equals("delete"))actor=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());for(int replay=0;replay<2;replay++)mvc.perform(post("/api/task/"+action).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key","legacy-event-001").contentType(MediaType.APPLICATION_JSON).content("{\"taskId\":\"t\",\"version\":0,\"side\":\"executor\",\"text\":\"SECRET_PRIVATE_COMMENT\"}")).andExpect(status().isOk());
			assertThat(planner.materialize(20)).isEqualTo(1);assertThat(jdbc.queryForList("select recipient_id from notification_deliveries",String.class)).containsExactly(action.equals("comment")?"a":"u");
		}
	}
}
