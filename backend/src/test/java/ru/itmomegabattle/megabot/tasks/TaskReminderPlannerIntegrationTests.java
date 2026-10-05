package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.time.*;
import java.util.List;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.*;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class) @SpringBootTest @ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TaskReminderPlannerIntegrationTests {
	@Autowired JdbcTemplate jdbc;@Autowired TaskReminderPlanner planner;@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;
	@Autowired ObjectMapper json;@Autowired TaskReminderService reminders;@Autowired PlatformTransactionManager manager;Instant now;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,tasks,task_reminder_occurrences,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('u',1101,'u','Исполнитель','organizer',true)");
		jdbc.update("insert into tasks(id,title,priority,status) values ('t','Проверить оборудование','normal','assigned')");
		jdbc.update("insert into task_assignees(task_id,user_id) values ('t','u')");now=jdbc.queryForObject("select clock_timestamp()",java.sql.Timestamp.class).toInstant();
	}
	void reminder(String type,Instant anchor,Instant due) {
		jdbc.update("insert into task_reminders(id,task_id,type,value,unit,anchor_at,next_due_at) values ('r','t',?,1,'hours',?,?)",type,java.sql.Timestamp.from(anchor),java.sql.Timestamp.from(due));
	}
	void repeat() { reminder("repeat",now.minusSeconds(36002),now.minusSeconds(32402)); }
	String delivery() { return jdbc.queryForObject("select id from notification_deliveries order by created_at desc limit 1",String.class); }
	String status(String id) { return jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,id); }
	@Test void repeatSkipsMissedTicksWithoutDriftAndMaterializationIsDurableAndIdempotent() {
		repeat();assertThat(planner.materialize(20)).isEqualTo(1);assertThat(planner.materialize(20)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from task_reminder_occurrences",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select intended_at from task_reminder_occurrences",java.sql.Timestamp.class).toInstant()).isEqualTo(now.minusSeconds(2));
		assertThat(jdbc.queryForObject("select next_due_at from task_reminders",java.sql.Timestamp.class).toInstant()).isEqualTo(now.plusSeconds(3598));
		assertThat(jdbc.queryForObject("select last_sent_at from task_reminders",java.sql.Timestamp.class)).isNull();
		assertThat(jdbc.queryForObject("select disable_notification from notification_deliveries",Boolean.class)).isTrue();
	}
	@Test void beforeDeadlineIsConsumedOnceButSentMarkersRequireActualProviderConfirmation() {
		reminder("before_deadline",now.plusSeconds(3598),now.minusSeconds(2));planner.materialize(20);
		assertThat(jdbc.queryForObject("select next_due_at from task_reminders",java.sql.Timestamp.class)).isNull();
		var worker=new BroadcastDispatcher(queue,quota,m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();return TelegramTransport.Outcome.sent(90);},json,"12345",DeliveryQuota.Limits.defaults(),planner);
		assertThat(worker.dispatchOne()).isTrue();assertThat(status(delivery())).isEqualTo("sent");assertThat(worker.dispatchOne()).isFalse();
		assertThat(jdbc.queryForObject("select sent_at from task_reminders",java.sql.Timestamp.class)).isNotNull();
	}
	@Test void expiredTickIsRecordedButNotQueuedAndFutureNeverMaterializesEarly() {
		reminder("before_deadline",now.plusSeconds(1000),now.minusSeconds(2600));assertThat(planner.materialize(20)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select state from task_reminder_occurrences",String.class)).isEqualTo("expired");assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isZero();
		jdbc.update("update task_reminders set version=version+1,next_due_at=?",java.sql.Timestamp.from(now.plusSeconds(60)));assertThat(planner.materialize(20)).isZero();
	}
	@Test void twoPlannersAndAtomicRollbackDoNotCreateDuplicateOrConsumeFailedTick() throws Exception {
		repeat();jdbc.execute("alter table notification_deliveries add constraint simulated_occurrence_failure check (task_occurrence_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class); }
		finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_occurrence_failure"); }
		assertThat(jdbc.queryForObject("select count(*) from task_reminder_occurrences",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select next_due_at from task_reminders",java.sql.Timestamp.class).toInstant()).isEqualTo(now.minusSeconds(32402));
		var gate=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return planner.materialize(20);});var b=pool.submit(()->{gate.await();return planner.materialize(20);});gate.countDown();
			assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isEqualTo(1);
	}
	@Test void completionChangedVersionBindingAndAssignmentCancelBeforeAttempt() {
		for(String change:List.of("update tasks set version=version+1","update users set telegram_id=2202","delete from task_assignees","update task_reminders set active=false,version=version+1","update tasks set status='completed',completed_at=now()")) {
			prepare();repeat();planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();jdbc.execute(change);
			assertThat(queue.start(lease.id(),lease.token())).as(change).isFalse();assertThat(status(lease.id())).isEqualTo("cancelled");
			assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Long.class)).isZero();
		}
	}
	@Test void missingTelegramIsUnavailableAndFacultyWithoutMembershipCannotReceiveCoreTask() {
		repeat();jdbc.update("update users set telegram_id=null");planner.materialize(20);
		assertThat(jdbc.queryForObject("select unavailable_count from task_reminder_occurrences",Integer.class)).isEqualTo(1);assertThat(jdbc.queryForObject("select state from task_reminder_occurrences",String.class)).isEqualTo("unavailable");
		prepare();repeat();planner.materialize(20);jdbc.update("update users set role='faculty_helper'");var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
	@Test void ambiguousSendNeverUpdatesMarkersOrReplaysSameOccurrence() {
		repeat();planner.materialize(20);var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();queue.start(lease.id(),lease.token());queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.unknown("response_timeout"));
		assertThat(planner.materialize(20)).isZero();assertThat(queue.claimSupported(1,Duration.ofSeconds(30))).isEmpty();assertThat(jdbc.queryForObject("select last_sent_at from task_reminders",java.sql.Timestamp.class)).isNull();
	}
	@Test void legitimateEditRearmsOnlyDefinitelyUnstartedSnapshotAndDoesNotReplayUnknown() {
		repeat();planner.materialize(20);var old=delivery();var tx=new TransactionTemplate(manager);
		tx.executeWithoutResult(s->{jdbc.update("update tasks set title='Новый заголовок',version=version+1");reminders.lifecycle("t","assigned");});
		assertThat(planner.materialize(20)).isEqualTo(1);assertThat(status(old)).isEqualTo("cancelled");
		var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(lease.payload()).contains("Новый заголовок");queue.start(lease.id(),lease.token());queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.unknown("lost"));
		tx.executeWithoutResult(s->{jdbc.update("update tasks set version=version+1");reminders.lifecycle("t","assigned");});assertThat(planner.materialize(20)).isZero();
	}
	@Test void assignedFacultyRecipientRequiresActiveMatchingMembershipIncludingAllScope() {
		jdbc.update("insert into faculties(id,name) values ('f','Факультет')");jdbc.update("update users set role='faculty_helper'");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper')");jdbc.update("update tasks set faculty_all=true");repeat();planner.materialize(20);
		var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(99));
		prepare();jdbc.update("insert into faculties(id,name) values ('f','Факультет') on conflict do nothing");jdbc.update("update users set role='faculty_helper'");
		jdbc.update("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('u','f','helper')");jdbc.update("update tasks set faculty_id='f'");repeat();planner.materialize(20);jdbc.update("update faculties set active=false where id='f'");
		var second=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(second.id(),second.token())).isFalse();
	}
	@Test void freshTickCancelsOlderPendingButLeavesUnknownEvidenceAndNegativeBindingIsUnavailable() {
		repeat();planner.materialize(20);var old=delivery();
		jdbc.update("update task_reminders set version=version+1,next_due_at=?",java.sql.Timestamp.from(now.minusSeconds(2)));planner.materialize(20);assertThat(status(old)).isEqualTo("cancelled");
		var lease=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();queue.start(lease.id(),lease.token());queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.unknown("lost"));
		jdbc.update("update task_reminders set version=version+1,next_due_at=?",java.sql.Timestamp.from(now.minusSeconds(2)));jdbc.update("update users set telegram_id=-100");planner.materialize(20);
		assertThat(status(lease.id())).isEqualTo("unknown");assertThat(queue.claimSupported(1,Duration.ofSeconds(30))).isEmpty();
		assertThat(jdbc.queryForObject("select unavailable_count from task_reminder_occurrences order by created_at desc limit 1",Integer.class)).isEqualTo(1);
	}
}
