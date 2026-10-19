package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;

@Import(TestcontainersConfiguration.class)
@SpringBootTest(properties="spring.datasource.hikari.connection-init-sql=SET search_path TO public,pg_catalog")
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
class DeliveryQueueIntegrationTests {
	@Autowired DeliveryQueue queue;
	@Autowired JdbcTemplate jdbc;
	@Autowired PlatformTransactionManager manager;
	TransactionTemplate tx;
	Instant now;
	@BeforeEach void prepare() {
		jdbc.execute("TRUNCATE TABLE notification_deliveries CASCADE");
		tx=new TransactionTemplate(manager);
		now=jdbc.queryForObject("select clock_timestamp()",java.sql.Timestamp.class).toInstant();
	}
	private DeliveryQueue.NewDelivery input(String key,Instant due,Instant available,Instant expiry) {
		return new DeliveryQueue.NewDelivery("operation",key,"task",null,-100L,9L,"{\"text\":\"Проверка\"}",true,due,available,expiry);
	}
	private String enqueue(DeliveryQueue.NewDelivery r) { return tx.execute(s->queue.enqueue(r)); }
	private String due(String key) { return enqueue(input(key,now.minusSeconds(5),now.minusSeconds(5),now.plusSeconds(3600))); }
	private DeliveryQueue.Lease claim() { return queue.claim(1,Duration.ofSeconds(30)).getFirst(); }
	private String status(String id) { return jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,id); }
	private void expireLease(String id) { jdbc.update("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second' where id=?",id); }

	@Test void exactDueAndAvailableBoundariesAndClockRollbackAreIndependentOfJvmZone() {
		var originalZone=java.util.TimeZone.getDefault();
		var intended=Instant.parse("2030-12-31T21:00:00Z"); // Moscow New Year boundary.
		try {
			for(var zone:List.of("UTC","Pacific/Honolulu","Asia/Tokyo")) {
				java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(zone));
				jdbc.execute("truncate notification_deliveries cascade");
				var id=enqueue(input("exact-"+zone,intended,intended,intended.plusSeconds(300)));
				var delayed=enqueue(input("available-"+zone,intended.minusSeconds(60),intended.plusSeconds(1),intended.plusSeconds(300)));
				for(var before:List.of(intended.minusSeconds(1),intended.minusNanos(1000))) {
					fixedDatabaseClock(before);
					assertThat(queue.claim(10,Duration.ofSeconds(30))).as(zone+" before due").isEmpty();
					assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Long.class)).isZero();
				}
				fixedDatabaseClock(intended);
				var leases=queue.claim(10,Duration.ofSeconds(30));
				assertThat(leases).as(zone+" at exact due").hasSize(1);
				var lease=leases.getFirst();assertThat(lease.id()).isEqualTo(id);
				assertThat(lease.intendedAt()).isEqualTo(intended);
				assertThat(status(delayed)).isEqualTo("planned");
				fixedDatabaseClock(intended.minusSeconds(1));
				assertThat(queue.start(id,lease.token())).isFalse();
				assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Long.class)).isZero();
				fixedDatabaseClock(intended);
				assertThat(queue.start(id,lease.token())).isTrue();
				assertThat(jdbc.queryForObject("select request_started_at from notification_deliveries where id=?",java.sql.Timestamp.class,id).toInstant()).isEqualTo(intended);
				assertThat(queue.finish(id,lease.token(),DeliveryQueue.Result.sent(123))).isTrue();
				fixedDatabaseClock(intended.plusSeconds(1).minusNanos(1000));
				assertThat(queue.claim(10,Duration.ofSeconds(30))).isEmpty();
				fixedDatabaseClock(intended.plusSeconds(1));
				assertThat(claim().id()).isEqualTo(delayed);
			}
		} finally {
			java.util.TimeZone.setDefault(originalZone);
			jdbc.execute("drop function if exists public.clock_timestamp()");
		}
	}

	private void fixedDatabaseClock(Instant instant) {
		// Only this disposable PostgreSQL; never change host time or sleep until due.
		jdbc.execute("create or replace function public.clock_timestamp() returns timestamptz language sql volatile as $$ select timestamptz '"+instant+"' $$");
	}

	@Test void enqueueRequiresDomainTransactionAndRollbackLeavesNoDelivery() {
		var r=input("atomic",now,now,null);
		assertThatThrownBy(()->queue.enqueue(r)).isInstanceOf(IllegalTransactionStateException.class);
		tx.executeWithoutResult(s->{queue.enqueue(r);s.setRollbackOnly();});
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isZero();
	}
	@Test void dedupePersistsIdentityRejectsChangedPayloadAndDoesNotResetRetry() {
		var r=input("stable-key",now.minusSeconds(5),now.minusSeconds(5),null); var id=enqueue(r);
		assertThat(enqueue(r)).isEqualTo(id);
		var altered=new DeliveryQueue.NewDelivery(r.operationId(),r.dedupeKey(),r.category(),null,r.chatId(),r.threadId(),"{\"text\":\"Другое\"}",true,r.intendedAt(),r.availableAt(),null);
		assertThatThrownBy(()->enqueue(altered)).isInstanceOf(ApiException.class);
		var lease=claim(); assertThat(queue.start(id,lease.token())).isTrue();
		assertThat(queue.finish(id,lease.token(),DeliveryQueue.Result.retry("429",Duration.ofSeconds(60)))).isTrue();
		var available=jdbc.queryForObject("select available_at from notification_deliveries where id=?",java.sql.Timestamp.class,id);
		assertThat(enqueue(r)).isEqualTo(id); assertThat(status(id)).isEqualTo("retry");
		assertThat(jdbc.queryForObject("select available_at from notification_deliveries where id=?",java.sql.Timestamp.class,id)).isEqualTo(available);
	}
	@Test void twoWorkersClaimDisjointRowsAndNeverClaimFutureOrExpired() throws Exception {
		for(int i=0;i<20;i++) due("parallel-"+i);
		var future=enqueue(input("future-intended",now.plusSeconds(60),now.minusSeconds(5),null));
		var delayed=enqueue(input("future-available",now.minusSeconds(5),now.plusSeconds(60),null));
		var expired=enqueue(input("expired",now.minusSeconds(10),now.minusSeconds(10),now.minusSeconds(1)));
		var start=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return queue.claim(10,Duration.ofSeconds(30));});
			var b=pool.submit(()->{start.await();return queue.claim(10,Duration.ofSeconds(30));});
			start.countDown(); var left=a.get();var right=b.get();
			assertThat(left).hasSize(10);assertThat(right).hasSize(10);
			assertThat(left.stream().map(DeliveryQueue.Lease::id).toList()).doesNotContainAnyElementsOf(right.stream().map(DeliveryQueue.Lease::id).toList());
			assertThat(left.getFirst().threadId()).isEqualTo(9L);assertThat(left.getFirst().silent()).isTrue();
		}
		assertThat(status(future)).isEqualTo("planned");assertThat(status(delayed)).isEqualTo("planned");
		assertThat(queue.expirePending()).isEqualTo(1); assertThat(status(expired)).isEqualTo("expired");
	}
	@Test void startIsAtomicAndWrongTokenCannotStartOrFinish() throws Exception {
		var id=due("start-race");var lease=claim();var start=new CountDownLatch(1);
		assertThat(queue.start(id,"wrong")).isFalse();
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return queue.start(id,lease.token());});
			var b=pool.submit(()->{start.await();return queue.start(id,lease.token());});
			start.countDown();assertThat(List.of(a.get(),b.get())).containsExactlyInAnyOrder(true,false);
		}
		assertThat(queue.finish(id,"wrong",DeliveryQueue.Result.sent(123))).isFalse();
		assertThat(queue.finish(id,lease.token(),DeliveryQueue.Result.sent(123))).isTrue();
		assertThat(queue.finish(id,lease.token(),DeliveryQueue.Result.sent(123))).isFalse();
		assertThat(status(id)).isEqualTo("sent"); assertThat(queue.claim(10,Duration.ofSeconds(30))).isEmpty();
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts where delivery_id=?",Long.class,id)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries where id=?",Long.class,id)).isEqualTo(123);
		assertThat(jdbc.queryForObject("select request_started_at<=response_at and response_at<=sent_at from notification_deliveries where id=?",Boolean.class,id)).isTrue();
	}
	@Test void quotaDeferredOlderScheduleDoesNotStarveBehindNewerDueWork() {
		var older=enqueue(input("older",now.minusSeconds(20),now.minusSeconds(20),null));
		var lease=claim();
		assertThat(queue.deferBeforeStart(older,lease.token(),now.minusSeconds(1))).isTrue();
		var newer=enqueue(input("newer",now.minusSeconds(10),now.minusSeconds(10),null));
		assertThat(claim().id()).isEqualTo(older);
		assertThat(status(newer)).isEqualTo("planned");
	}
	@Test void crashBeforeStartRecoversButExpiredOwnerCannotContinue() {
		var id=due("before-start");var old=claim();expireLease(id);
		assertThat(queue.heartbeat(id,old.token(),Duration.ofSeconds(30))).isFalse();
		assertThat(queue.start(id,old.token())).isFalse();assertThat(queue.recoverExpiredLeases()).isEqualTo(1);
		var fresh=claim();assertThat(fresh.token()).isNotEqualTo(old.token());
		assertThat(queue.start(id,old.token())).isFalse();assertThat(queue.start(id,fresh.token())).isTrue();
		assertThat(queue.finish(id,old.token(),DeliveryQueue.Result.sent(1))).isFalse();
		assertThat(queue.finish(id,fresh.token(),DeliveryQueue.Result.sent(2))).isTrue();
		assertThat(jdbc.queryForObject("select attempts from notification_deliveries where id=?",Integer.class,id)).isEqualTo(1);
	}
	@Test void crashAfterStartBecomesUnknownNeverAutomaticallyRetriesOrAcceptsLateResult() {
		var id=due("after-start");var lease=claim();assertThat(queue.start(id,lease.token())).isTrue();expireLease(id);
		assertThat(queue.finish(id,lease.token(),DeliveryQueue.Result.sent(42))).isFalse();
		assertThat(queue.recoverExpiredLeases()).isEqualTo(1);assertThat(status(id)).isEqualTo("unknown");
		assertThat(queue.claim(10,Duration.ofSeconds(30))).isEmpty();assertThat(queue.recoverExpiredLeases()).isZero();
		assertThat(jdbc.queryForObject("select result_status from delivery_attempts where delivery_id=?",String.class,id)).isEqualTo("unknown");
	}
	@Test void heartbeatCannotReviveOldLeaseAndKeepsOwnership() {
		var id=due("heartbeat");var lease=claim();
		assertThat(queue.heartbeat(id,"wrong",Duration.ofSeconds(60))).isFalse();
		assertThat(queue.heartbeat(id,lease.token(),Duration.ofSeconds(60))).isTrue();
		assertThat(jdbc.queryForObject("select leased_until from notification_deliveries where id=?",java.sql.Timestamp.class,id).toInstant()).isAfter(lease.leasedUntil());
		expireLease(id);assertThat(queue.heartbeat(id,lease.token(),Duration.ofSeconds(60))).isFalse();
	}
	@Test void cancellationBeforeStartPreventsSendWhileInFlightSuccessRemainsSent() {
		var id=due("cancel-before");var lease=claim();assertThat(queue.cancel(id)).isTrue();assertThat(queue.cancel(id)).isFalse();
		assertThat(queue.start(id,lease.token())).isFalse();assertThat(status(id)).isEqualTo("cancelled");
		var inFlight=due("cancel-after");var started=claim();assertThat(queue.start(inFlight,started.token())).isTrue();
		assertThat(queue.cancel(inFlight)).isTrue();assertThat(status(inFlight)).isEqualTo("sending");
		assertThat(queue.finish(inFlight,started.token(),DeliveryQueue.Result.sent(55))).isTrue();assertThat(status(inFlight)).isEqualTo("sent");
		assertThat(jdbc.queryForObject("select cancel_requested from notification_deliveries where id=?",Boolean.class,inFlight)).isTrue();
	}
	@Test void retryRespectsRetryAfterExpiresAtAndCancellation() {
		var id=due("retry-after");var lease=claim();assertThat(queue.start(id,lease.token())).isTrue();
		var before=jdbc.queryForObject("select clock_timestamp()",java.sql.Timestamp.class).toInstant();
		assertThat(queue.finish(id,lease.token(),DeliveryQueue.Result.retry("429",Duration.ofSeconds(31)))).isTrue();
		assertThat(jdbc.queryForObject("select available_at from notification_deliveries where id=?",java.sql.Timestamp.class,id).toInstant()).isAfterOrEqualTo(before.plusSeconds(31));
		assertThat(queue.claim(1,Duration.ofSeconds(30))).isEmpty();
		var soon=enqueue(input("grace-end",now.minusSeconds(5),now.minusSeconds(5),now.plusSeconds(20)));var shortLease=claim();
		assertThat(queue.start(soon,shortLease.token())).isTrue();assertThat(queue.finish(soon,shortLease.token(),DeliveryQueue.Result.retry("429",Duration.ofSeconds(60)))).isTrue();
		assertThat(status(soon)).isEqualTo("expired");
		var cancelled=due("cancel-retry");var c=claim();assertThat(queue.start(cancelled,c.token())).isTrue();assertThat(queue.cancel(cancelled)).isTrue();
		assertThat(queue.finish(cancelled,c.token(),DeliveryQueue.Result.retry("429",Duration.ofSeconds(60)))).isTrue();assertThat(status(cancelled)).isEqualTo("cancelled");
	}
	@Test void eightDefiniteFailuresStopRetriesAndTerminalResultsAreNotReclaimed() {
		var id=due("retry-limit");
		for(int i=0;i<8;i++) {
			var lease=claim();assertThat(queue.start(id,lease.token())).isTrue();
			assertThat(queue.finish(id,lease.token(),DeliveryQueue.Result.retry("unavailable",Duration.ofSeconds(2)))).isTrue();
			if(i<7) jdbc.update("update notification_deliveries set available_at=clock_timestamp()-interval '1 second' where id=?",id);
		}
		assertThat(status(id)).isEqualTo("failed");assertThat(queue.claim(10,Duration.ofSeconds(30))).isEmpty();
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts where delivery_id=?",Long.class,id)).isEqualTo(8);
	}
	@Test void permanentFailureAndAmbiguousTransportNeverRetry() {
		var failed=due("blocked");var f=claim();assertThat(queue.start(failed,f.token())).isTrue();
		assertThat(queue.finish(failed,f.token(),DeliveryQueue.Result.failed("403"))).isTrue();
		var unknown=due("lost-response");var u=claim();assertThat(queue.start(unknown,u.token())).isTrue();
		assertThat(queue.finish(unknown,u.token(),DeliveryQueue.Result.unknown("response_lost"))).isTrue();
		assertThat(status(failed)).isEqualTo("failed");assertThat(status(unknown)).isEqualTo("unknown");assertThat(queue.claim(10,Duration.ofSeconds(30))).isEmpty();
	}
	@Test void invalidInputsAreRejectedBeforeChangingState() {
		assertThatThrownBy(()->queue.claim(0,Duration.ofSeconds(30))).isInstanceOf(ApiException.class);
		assertThatThrownBy(()->queue.claim(101,Duration.ofSeconds(30))).isInstanceOf(ApiException.class);
		assertThatThrownBy(()->queue.claim(1,Duration.ofMillis(500))).isInstanceOf(ApiException.class);
		assertThatThrownBy(()->queue.claim(1,Duration.ofSeconds(121))).isInstanceOf(ApiException.class);
		var id=due("invalid-result");var lease=claim();assertThat(queue.start(id,lease.token())).isTrue();
		assertThatThrownBy(()->queue.finish(id,lease.token(),DeliveryQueue.Result.sent(0))).isInstanceOf(ApiException.class);
		assertThatThrownBy(()->queue.finish(id,lease.token(),DeliveryQueue.Result.retry("429",Duration.ofSeconds(-1)))).isInstanceOf(ApiException.class);
		assertThat(status(id)).isEqualTo("sending");
	}
}
