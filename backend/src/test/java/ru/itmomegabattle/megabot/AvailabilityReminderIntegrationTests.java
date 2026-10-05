package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner;
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;

// Own Testcontainers DB/context. Shadow only this DB's clock, never OS/production time.
@Import(TestcontainersConfiguration.class)
@SpringBootTest(properties="spring.datasource.hikari.connection-init-sql=SET search_path TO public,pg_catalog")
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class AvailabilityReminderIntegrationTests {
	@Autowired JdbcTemplate jdbc; @Autowired AvailabilityReminderPlanner planner;
	@Autowired DeliveryQueue queue; @Autowired DeliveryQuota quota; @Autowired ObjectMapper json;
	final LocalDate week=LocalDate.of(2026,10,5);
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,availability_weeks,availability_reminder_occurrences,notification_deliveries,delivery_rate_limits,app_settings cascade");
		jdbc.update("""
				insert into users(id,telegram_id,username,real_name,role,registered,active) values
				('a',3100,'admin','Администратор','admin',true,true),('u',3101,'user','Участник','organizer',true,true),
				('n',null,'nochat','Без Telegram','organizer',true,true),('c',3102,'complete','Заполнил','organizer',true,true),
				('f',3103,'faculty','Помощник','faculty_helper',true,true),('x',3104,'inactive','Неактивный','organizer',true,true),
				('r',3105,'unregistered','Не зарегистрирован','organizer',false,true)
				""");
		jdbc.update("update users set active=false,deactivated_at=now() where id='x'");
		out("c"); time("2026-10-04T15:00:00Z");
	}
	@AfterEach void restoreClock() { jdbc.execute("drop function if exists public.clock_timestamp()"); }
	void time(String instant) {
		var safe=Instant.parse(instant).toString();
		jdbc.execute("create or replace function public.clock_timestamp() returns timestamptz language sql volatile as $$ select timestamptz '"+safe+"' $$");
	}
	void out(String user) {
		jdbc.update("insert into availability_weeks(id,user_id,week_start,out_of_week) values (?,?,?,true) on conflict (user_id,week_start) do update set out_of_week=true", "week_"+user,user,week);
	}
	long count(String table) { return jdbc.queryForObject("select count(*) from "+table,Long.class); }
	List<DeliveryQueue.Lease> claims() { return queue.claimSupported(10,Duration.ofSeconds(30),"12345"); }
	String status(String id) { return jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,id); }
	@Test void sunday18MoscowCreatesOneFrozenAudienceAndNeverStartsEarly() {
		time("2026-10-04T14:59:59.999Z"); assertThat(planner.materialize()).isZero(); assertThat(count("notification_deliveries")).isZero();
		time("2026-10-04T15:00:00Z"); assertThat(planner.materialize()).isEqualTo(1); assertThat(planner.materialize()).isZero();
		assertThat(count("availability_reminder_occurrences")).isEqualTo(1); assertThat(count("availability_reminder_targets")).isEqualTo(3);
		assertThat(jdbc.queryForObject("select unavailable_count from availability_reminder_occurrences",Integer.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select intended_at from availability_reminder_occurrences",java.sql.Timestamp.class).toInstant()).isEqualTo(Instant.parse("2026-10-04T15:00:00Z"));
		var leases=claims(); assertThat(leases).extracting(DeliveryQueue.Lease::recipientId).containsExactlyInAnyOrder("a","u");
		time("2026-10-04T14:59:59Z"); for(var lease:leases)assertThat(queue.start(lease.id(),lease.token())).isFalse();
		assertThat(count("delivery_attempts")).isZero();
		assertThat(leases).allSatisfy(l->assertThat(status(l.id())).isEqualTo("claimed"));
		time("2026-10-04T15:00:31Z");assertThat(queue.recoverExpiredLeases()).isEqualTo(2);
		var recovered=claims().getFirst();assertThat(queue.start(recovered.id(),recovered.token())).isTrue();
		queue.finish(recovered.id(),recovered.token(),DeliveryQueue.Result.sent(78));
	}
	@Test void recoveryUntil21IsAllowedButAt21AndFollowingDaysItExpires() {
		time("2026-10-04T17:59:59Z"); assertThat(planner.materialize()).isEqualTo(1); assertThat(claims()).hasSize(2);
		time("2026-10-04T18:00:00Z"); queue.expirePending(); assertThat(claims()).isEmpty();
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='expired'",Long.class)).isEqualTo(2);
		for(var instant:List.of("2026-10-04T18:00:00Z","2026-10-05T09:00:00Z")) {
			prepare();time(instant);assertThat(planner.materialize()).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
			assertThat(jdbc.queryForObject("select state from availability_reminder_occurrences",String.class)).isEqualTo("expired");
		}
	}
	@Test void submittedWeekBeforeStartSuppressesDeliveryAndDoesNotRearmAfterClearing() {
		planner.materialize(); var leases=claims(); out("u");
		var u=leases.stream().filter(l->l.recipientId().equals("u")).findFirst().orElseThrow();
		assertThat(queue.start(u.id(),u.token())).isFalse(); assertThat(status(u.id())).isEqualTo("cancelled");
		jdbc.update("update availability_weeks set out_of_week=false where user_id='u'");
		assertThat(planner.materialize()).isZero(); assertThat(count("notification_deliveries")).isEqualTo(2);
	}
	@Test void fullActiveDaysAndAvailableSlotsUseSharedCompletenessRule() {
		jdbc.update("insert into availability_weeks(id,user_id,week_start) values ('wu','u',?)",week);
		for(int day=0;day<5;day++) {
			jdbc.update("insert into availability_days(id,week_id,week_start,day_date,status) values (?, 'wu', ?, ?, ?)","d"+day,week,week.plusDays(day),day==4?"available":"unavailable");
		}
		planner.materialize(); var leases=claims(); assertThat(leases).hasSize(2); // available without a slot is incomplete.
		jdbc.update("insert into availability_slots(day_id,start_minute) values ('d4',1080)");
		var u=leases.stream().filter(l->l.recipientId().equals("u")).findFirst().orElseThrow(); assertThat(queue.start(u.id(),u.token())).isFalse();
	}
	@Test void roleRegistrationActivationAndTelegramBindingAreRecheckedBeforeHttp() {
		for(var change:List.of("update users set role='faculty_helper' where id='u'","update users set registered=false where id='u'",
				"update users set active=false,deactivated_at=now() where id='u'","update users set telegram_id=9999 where id='u'")) {
			prepare();planner.materialize();var u=claims().stream().filter(l->l.recipientId().equals("u")).findFirst().orElseThrow();jdbc.execute(change);
			assertThat(queue.start(u.id(),u.token())).as(change).isFalse();assertThat(count("delivery_attempts")).isZero();
		}
	}
	@Test void newMembersAndNewTelegramBindingsNeverExpandExistingSnapshot() {
		planner.materialize();jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('new',3999,'new','Новый','organizer',true)");
		jdbc.update("update users set telegram_id=3900 where id='n'");jdbc.update("update availability_weeks set out_of_week=false where user_id='c'");
		assertThat(planner.materialize()).isZero(); assertThat(count("availability_reminder_targets")).isEqualTo(3);
		assertThat(claims()).extracting(DeliveryQueue.Lease::recipientId).containsExactlyInAnyOrder("a","u");
	}
	@Test void atomicRollbackAndTwoPlannersCannotDuplicateWeeklyOccurrence() throws Exception {
		jdbc.execute("alter table notification_deliveries add constraint simulated_slots_failure check (availability_reminder_target_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize()).isInstanceOf(RuntimeException.class); }
		finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_slots_failure"); }
		assertThat(count("availability_reminder_occurrences")).isZero(); assertThat(count("availability_reminder_targets")).isZero(); assertThat(count("notification_deliveries")).isZero();
		var gate=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return planner.materialize();});var b=pool.submit(()->{gate.await();return planner.materialize();});gate.countDown();
			assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		} assertThat(count("notification_deliveries")).isEqualTo(2);
	}
	@Test void actualDispatcherUsesExistingQuotaAndRecordsProviderConfirmationOutsideTransaction() {
		var messages=new ArrayList<TelegramTransport.Message>();
		var sender=new BroadcastDispatcher(queue,quota,m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();messages.add(m);return TelegramTransport.Outcome.sent(77);},
				json,"12345",DeliveryQuota.Limits.defaults(),null,null,Clock.systemUTC(),null,planner);
		for(int n=0;n<4;n++) {
			jdbc.update("update delivery_rate_limits set next_at=timestamptz '2000-01-01T00:00:00Z'");
			jdbc.update("update notification_deliveries set available_at=intended_at where status='planned'"); sender.dispatchOne();
		}
		assertThat(messages).hasSize(2).allSatisfy(m->{assertThat(m.chatId()).isPositive();assertThat(m.threadId()).isNull();assertThat(m.silent()).isFalse();assertThat(m.text()).contains("Сегодня воскресенье");});
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='sent' and telegram_message_id=77",Long.class)).isEqualTo(2);
	}
	@Test void unknownAndRetryRemainIndependentAndNeverResendSuccessfulAudience() {
		planner.materialize(); var leases=claims(); var uncertain=leases.getFirst();var retry=leases.getLast();
		queue.start(uncertain.id(),uncertain.token());queue.finish(uncertain.id(),uncertain.token(),DeliveryQueue.Result.unknown("response_timeout"));
		queue.start(retry.id(),retry.token());queue.finish(retry.id(),retry.token(),DeliveryQueue.Result.retry("telegram_429",Duration.ofSeconds(1)));
		time("2026-10-04T15:00:02Z");out(retry.recipientId());assertThat(planner.materialize()).isZero(); var next=claims(); assertThat(next).hasSize(1);
		assertThat(queue.start(next.getFirst().id(),next.getFirst().token())).isFalse();assertThat(status(uncertain.id())).isEqualTo("unknown");assertThat(count("delivery_attempts")).isEqualTo(2);
	}
	@Test void yearBoundaryKeepsAbsoluteMondayAndDoesNotReplayMissedWeeks() {
		time("2026-12-27T15:00:00Z");planner.materialize(); assertThat(jdbc.queryForObject("select week_start from availability_reminder_occurrences",LocalDate.class)).isEqualTo(LocalDate.of(2026,12,28));
		time("2027-01-03T15:00:00Z");planner.materialize();queue.expirePending();assertThat(count("availability_reminder_occurrences")).isEqualTo(2);
		assertThat(claims()).hasSize(3); // c has submitted October only, not the new January week.
		time("2027-02-01T09:00:00Z");assertThat(planner.materialize()).isEqualTo(1);assertThat(count("availability_reminder_occurrences")).isEqualTo(3);
		assertThat(jdbc.queryForObject("select count(*) from availability_reminder_occurrences where state='expired'",Long.class)).isEqualTo(1);
	}
	@Test void leaseRecoveryBeforeHttpCanResumeButStartedAttemptBecomesUnknown() {
		for(boolean started:List.of(false,true)) {
			prepare();planner.materialize();var original=queue.claimSupported(1,Duration.ofSeconds(30),"12345").getFirst();
			if(started)assertThat(queue.start(original.id(),original.token())).isTrue();
			time("2026-10-04T15:00:31Z");assertThat(queue.recoverExpiredLeases()).isEqualTo(1);
			assertThat(queue.start(original.id(),original.token())).isFalse();assertThat(planner.materialize()).isZero();
			assertThat(count("availability_reminder_occurrences")).isEqualTo(1);assertThat(count("notification_deliveries")).isEqualTo(2);
			if(started) {
				assertThat(status(original.id())).isEqualTo("unknown");assertThat(claims()).noneMatch(l->l.id().equals(original.id()));
			} else {
				var recovered=claims().stream().filter(l->l.id().equals(original.id())).findFirst().orElseThrow();
				assertThat(queue.start(recovered.id(),recovered.token())).isTrue();queue.finish(recovered.id(),recovered.token(),DeliveryQueue.Result.sent(89));
			}
		}
	}
}
