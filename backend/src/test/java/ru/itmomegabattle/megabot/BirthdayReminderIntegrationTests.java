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
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class)
@SpringBootTest(properties={"spring.datasource.hikari.connection-init-sql=SET search_path TO public,pg_catalog",
		"megabot.birthdays.payment-phone=TEST_PHONE","megabot.birthdays.payment-bank=ТестБанк"})
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class BirthdayReminderIntegrationTests {
	@Autowired JdbcTemplate jdbc; @Autowired BirthdayReminderPlanner planner;
	@Autowired DeliveryQueue queue; @Autowired DeliveryQuota quota; @Autowired ObjectMapper json;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,birthday_reminder_occurrences,notification_deliveries,delivery_rate_limits,app_settings cascade");
		jdbc.update("""
				insert into users(id,telegram_id,username,real_name,role,registered) values
				('b',3200,'birthday','Именинник','organizer',true),('u',3201,'user','Участник','organizer',true),
				('a',3202,'admin','Администратор','admin',true),('n',null,'nochat','Нет Telegram','organizer',true),
				('f',3203,'faculty','Факультет','faculty_helper',true),('x',3204,'inactive','Неактивный','organizer',true),
				('r',3205,'unregistered','Не зарегистрирован','organizer',false)
				""");
		jdbc.update("update users set birthday_day=6,birthday_month=10,birthday_year=2001 where id in ('b','f','x','r')");
		jdbc.update("update users set active=false,deactivated_at=now() where id='x'");time("2026-10-04T09:00:00Z");
	}
	@AfterEach void restoreClock() { jdbc.execute("drop function if exists public.clock_timestamp()"); }
	void time(String value) {
		var safe=Instant.parse(value).toString();
		jdbc.execute("create or replace function public.clock_timestamp() returns timestamptz language sql volatile as $$ select timestamptz '"+safe+"' $$");
	}
	long count(String table) { return jdbc.queryForObject("select count(*) from "+table,Long.class); }
	List<DeliveryQueue.Lease> claims() { return queue.claimSupported(10,Duration.ofSeconds(30),"12345"); }
	String status(String id) { return jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,id); }
	BroadcastDispatcher sender(TelegramTransport transport) {
		return new BroadcastDispatcher(queue,quota,transport,json,"12345",DeliveryQuota.Limits.defaults(),null,null,Clock.systemUTC(),null,null,planner);
	}
	void resetQuota() {
		jdbc.update("update delivery_rate_limits set next_at=timestamptz '2000-01-01T00:00:00Z'");
		jdbc.update("update notification_deliveries set available_at=intended_at where status='planned'");
	}
	@Test void defaultStartsAt12MoscowAndSnapshotExcludesBirthdayPersonFacultyAndPrivateBirthYear() {
		time("2026-10-04T07:00:00Z");assertThat(planner.materialize()).isZero();
		time("2026-10-04T08:59:59.999Z");assertThat(planner.materialize()).isZero();assertThat(count("notification_deliveries")).isZero();
		time("2026-10-04T09:00:00Z");assertThat(planner.materialize()).isEqualTo(1);assertThat(planner.materialize()).isZero();
		assertThat(count("birthday_reminder_targets")).isEqualTo(3);assertThat(count("notification_deliveries")).isEqualTo(2);
		assertThat(jdbc.queryForObject("select unavailable_count from birthday_reminder_occurrences",Integer.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select intended_at from birthday_reminder_occurrences",java.sql.Timestamp.class).toInstant()).isEqualTo(Instant.parse("2026-10-04T09:00:00Z"));
		assertThat(claims()).extracting(DeliveryQueue.Lease::recipientId).containsExactlyInAnyOrder("a","u");
		assertThat(jdbc.queryForList("select payload::text from notification_deliveries",String.class)).allSatisfy(p->assertThat(p).contains("Через 2 дня","Именинник","TEST_PHONE","400").doesNotContain("2001","Исполняется"));
	}
	@Test void threeDailyOccurrencesStayIndependentAndNeverReplayEarlierDays() {
		for(var day:List.of("04","05","06")) { time("2026-10-"+day+"T08:59:59.999Z");assertThat(planner.materialize()).isZero();time("2026-10-"+day+"T09:00:00Z");assertThat(planner.materialize()).isEqualTo(1);assertThat(planner.materialize()).isZero(); }
		assertThat(count("birthday_reminder_occurrences")).isEqualTo(3);assertThat(count("notification_deliveries")).isEqualTo(6);
		assertThat(jdbc.queryForList("select days_before::integer from birthday_reminder_occurrences order by days_before",Integer.class)).containsExactly(0,1,2);
		queue.expirePending();assertThat(claims()).hasSize(2);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='expired'",Long.class)).isEqualTo(4);
		time("2026-10-10T09:00:00Z");assertThat(planner.materialize()).isZero();
	}
	@Test void nextDayMidnightExpiresOldDeliveriesWithoutNighttimeCatchup() {
		planner.materialize();time("2026-10-04T20:59:59Z");assertThat(claims()).hasSize(2);
		time("2026-10-04T21:00:00Z");queue.expirePending();assertThat(claims()).isEmpty();assertThat(planner.materialize()).isZero();
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='expired'",Long.class)).isEqualTo(2);
	}
	@Test void clockBackAfterClaimBlocksEarlyStartWithoutCancellingIntent() {
		planner.materialize();var leases=claims();time("2026-10-04T08:59:59Z");
		for(var lease:leases) { assertThat(queue.start(lease.id(),lease.token())).isFalse();assertThat(status(lease.id())).isEqualTo("claimed"); }
		assertThat(count("delivery_attempts")).isZero();time("2026-10-04T09:00:31Z");assertThat(queue.recoverExpiredLeases()).isEqualTo(2);
		var recovered=claims().getFirst();assertThat(queue.start(recovered.id(),recovered.token())).isTrue();queue.finish(recovered.id(),recovered.token(),DeliveryQueue.Result.sent(81));
		assertThat(planner.materialize()).isZero();
	}
	@Test void birthdayChangeDeactivationRoleAndRegistrationBlockOldSnapshotBeforeHttp() {
		for(var change:List.of("update users set birthday_day=7 where id='b'","update users set birthday_day=null,birthday_month=null,birthday_year=null where id='b'",
				"update users set active=false,deactivated_at=now() where id='b'","update users set role='faculty_helper' where id='b'","update users set registered=false where id='b'")) {
			prepare();planner.materialize();var leases=claims();jdbc.execute(change);for(var lease:leases)assertThat(queue.start(lease.id(),lease.token())).as(change).isFalse();
			assertThat(count("delivery_attempts")).isZero();
		}
	}
	@Test void recipientPermissionsBindingAndSelfDeliveryAreCheckedAtStart() {
		for(var change:List.of("update users set telegram_id=9999 where id='u'","update users set role='faculty_helper' where id='u'",
				"update users set registered=false where id='u'","update users set active=false,deactivated_at=now() where id='u'")) {
			prepare();planner.materialize();var u=claims().stream().filter(l->l.recipientId().equals("u")).findFirst().orElseThrow();jdbc.execute(change);
			assertThat(queue.start(u.id(),u.token())).as(change).isFalse();assertThat(count("delivery_attempts")).isZero();
		}
		prepare();planner.materialize();var u=claims().stream().filter(l->l.recipientId().equals("u")).findFirst().orElseThrow();
		jdbc.update("update birthday_reminder_targets set recipient_id='b',chat_id=3200 where id=?",u.birthdayTargetId());
		jdbc.update("update notification_deliveries set recipient_id='b',chat_id=3200 where id=?",u.id());assertThat(queue.start(u.id(),u.token())).isFalse();
	}
	@Test void newMembersAndNewTelegramBindingCannotExpandSameOccurrence() {
		planner.materialize();jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('new',3299,'new','Новый','organizer',true)");
		jdbc.update("update users set telegram_id=3298 where id='n'");assertThat(planner.materialize()).isZero();assertThat(count("birthday_reminder_targets")).isEqualTo(3);
		assertThat(claims()).extracting(DeliveryQueue.Lease::recipientId).containsExactlyInAnyOrder("u","a");
	}
	@Test void unavailableAudienceIsRecordedAndMissingClosedVariantFailsClosed() {
		jdbc.update("update users set telegram_id=null where id<>'b'");planner.materialize();assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select state from birthday_reminder_occurrences",String.class)).isEqualTo("unavailable");
		assertThat(jdbc.queryForObject("select unavailable_count from birthday_reminder_occurrences",Integer.class)).isEqualTo(3);
		prepare();planner.materialize();jdbc.update("update notification_deliveries set payload=payload-'closedText'");for(var lease:claims())assertThat(queue.start(lease.id(),lease.token())).isFalse();
		assertThat(count("delivery_attempts")).isZero();
	}
	@Test void atomicRollbackAndTwoWorkersDoNotDuplicateBirthdayOccurrence() throws Exception {
		jdbc.execute("alter table notification_deliveries add constraint simulated_birthday_failure check (birthday_reminder_target_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize()).isInstanceOf(RuntimeException.class); }
		finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_birthday_failure"); }
		assertThat(count("birthday_reminder_occurrences")).isZero();assertThat(count("birthday_reminder_targets")).isZero();assertThat(count("notification_deliveries")).isZero();
		var gate=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return planner.materialize();});var b=pool.submit(()->{gate.await();return planner.materialize();});gate.countDown();
			assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}assertThat(count("notification_deliveries")).isEqualTo(2);
	}
	@Test void cutoffUsesActualSendTimeEvenForSnapshotCreatedBefore19() {
		time("2026-10-06T09:00:00Z");planner.materialize();time("2026-10-06T15:59:59Z");var lease=claims().getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		assertThat(queue.birthdayTextForSending(lease.id(),lease.token()).orElseThrow()).contains("переводите на","TEST_PHONE");
		time("2026-10-06T16:00:00Z");assertThat(queue.birthdayTextForSending(lease.id(),lease.token()).orElseThrow()).contains("Сбор на подарок завершён","деньги больше не переводите").doesNotContain("TEST_PHONE","400","переводите на");
		queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(82));
	}
	@Test void realDispatcherSelectsClosedTextOn429RetryAndDoesNotResendSuccess() {
		time("2026-10-06T15:59:59Z");var messages=new ArrayList<TelegramTransport.Message>();
		var worker=sender(m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();messages.add(m);return messages.size()==1?TelegramTransport.Outcome.retry("telegram_429",Duration.ofSeconds(2)):TelegramTransport.Outcome.sent(83);});
		assertThat(worker.dispatchOne()).isTrue();assertThat(messages.getFirst().text()).contains("переводите на");
		time("2026-10-06T16:00:00Z");worker.dispatchOne();assertThat(messages).hasSize(1); // Keep the shared 429 block intact.
		time("2026-10-06T16:00:04Z"); // Beyond the bounded jitter and rounded queue Retry-After.
		for(int n=0;n<5;n++) { resetQuota();worker.dispatchOne(); }
		assertThat(messages).hasSize(3);assertThat(messages.subList(1,3)).allSatisfy(m->{assertThat(m.text()).contains("Сбор на подарок завершён").doesNotContain("TEST_PHONE","переводите на");assertThat(m.silent()).isFalse();assertThat(m.chatId()).isPositive();assertThat(m.threadId()).isNull();});
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='sent'",Long.class)).isEqualTo(2);
	}
	@Test void unknownAndStartedLeaseRecoveryNeverReissueBirthdayReminder() {
		planner.materialize();var leases=claims();var uncertain=leases.getFirst();var interrupted=leases.getLast();queue.start(uncertain.id(),uncertain.token());
		queue.finish(uncertain.id(),uncertain.token(),DeliveryQueue.Result.unknown("response_timeout"));queue.start(interrupted.id(),interrupted.token());
		time("2026-10-04T09:00:31Z");assertThat(queue.recoverExpiredLeases()).isEqualTo(1);assertThat(planner.materialize()).isZero();assertThat(claims()).isEmpty();
		assertThat(status(uncertain.id())).isEqualTo("unknown");assertThat(status(interrupted.id())).isEqualTo("unknown");assertThat(count("delivery_attempts")).isEqualTo(2);
	}
	@Test void corruptClosedTextFailsWithoutHttpAndWithoutUnknownResult() {
		time("2026-10-06T09:00:00Z");planner.materialize();jdbc.update("update notification_deliveries set payload=jsonb_set(payload,'{closedText}','\"\"')");
		time("2026-10-06T16:00:00Z");var worker=sender(m->{throw new AssertionError("No HTTP for an invalid closed variant");});
		for(int n=0;n<2;n++) { resetQuota();assertThat(worker.dispatchOne()).isTrue(); }
		assertThat(jdbc.queryForList("select status from notification_deliveries",String.class)).containsOnly("failed");
		assertThat(jdbc.queryForList("select last_error_code from notification_deliveries",String.class)).containsOnly("invalid_delivery_payload");
	}
	@Test void yearBoundaryAndLeapBirthdayUseCalendarDatesWithoutFebruary28Substitution() {
		jdbc.update("update users set birthday_day=1,birthday_month=1 where id='b'");
		for(var day:List.of("2026-12-30","2026-12-31","2027-01-01")) { time(day+"T09:00:00Z");assertThat(planner.materialize()).isEqualTo(1); }
		assertThat(jdbc.queryForList("select distinct birthday_date from birthday_reminder_occurrences",LocalDate.class)).containsExactly(LocalDate.of(2027,1,1));
		prepare();jdbc.update("update users set birthday_day=29,birthday_month=2,birthday_year=null where id='b'");
		for(var day:List.of("2027-02-27","2027-02-28","2027-03-01")) { time(day+"T09:00:00Z");assertThat(planner.materialize()).isZero(); }
		for(var day:List.of("2028-02-27","2028-02-28","2028-02-29")) { time(day+"T09:00:00Z");assertThat(planner.materialize()).isEqualTo(1); }
		assertThat(count("birthday_reminder_occurrences")).isEqualTo(3);
	}
}
