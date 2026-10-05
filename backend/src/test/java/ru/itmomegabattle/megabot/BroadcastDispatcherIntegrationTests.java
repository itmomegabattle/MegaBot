package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.notifications.*;
import ru.itmomegabattle.megabot.team.*;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
class BroadcastDispatcherIntegrationTests {
	@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired JdbcTemplate jdbc;
	@Autowired ObjectMapper json;@Autowired UserRepository users;@Autowired PlatformTransactionManager manager;@Autowired ApplicationContext context;
	UserEntity author,recipient;Instant now;TransactionTemplate tx;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,broadcasts,notification_deliveries,delivery_rate_limits cascade");tx=new TransactionTemplate(manager);
		author=users.saveAndFlush(new UserEntity(901L,"dispatcher_author","Автор","organizer"));recipient=users.saveAndFlush(new UserEntity(902L,"dispatcher_recipient","Адресат","organizer"));
		now=jdbc.queryForObject("select clock_timestamp()",java.sql.Timestamp.class).toInstant();
	}
	String delivery(String key,Instant due,String payload) {
		return tx.execute(s->{
			var b="b_"+UUID.randomUUID();var target="t_"+UUID.randomUUID();
			jdbc.update("insert into broadcasts(id,author_id,content,scheduled_at,misfire_policy,expires_at,status) values (?,?,'Текст',?,'send_within_grace',?,'scheduled')",b,author.getId(),java.sql.Timestamp.from(due),java.sql.Timestamp.from(now.plusSeconds(900)));
			jdbc.update("insert into broadcast_targets(id,broadcast_id,revision,target_key,recipient_id,chat_id) values (?,?,1,?,?,?)",target,b,"user:"+recipient.getId(),recipient.getId(),902L);
			var id=queue.enqueue(new DeliveryQueue.NewDelivery(b,key,"broadcast",recipient.getId(),902L,null,payload,true,due,due,now.plusSeconds(900)));
			jdbc.update("update notification_deliveries set broadcast_target_id=? where id=?",target,id);return id;
		});
	}
	String due(String key) { return delivery(key,now.minusSeconds(1),"{\"text\":\"Проверка\"}"); }
	String status(String id) { return jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,id); }
	BroadcastDispatcher worker(TelegramTransport transport) { return new BroadcastDispatcher(queue,quota,transport,json,"12345",DeliveryQuota.Limits.defaults()); }
	@Test void disabledByDefaultAndNetworkAttemptRunsOutsideTransaction() {
		assertThat(context.getBeansOfType(BroadcastDispatcher.class)).isEmpty();var id=due("send");var count=new AtomicInteger();
		var worker=worker(message->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(message.silent()).isTrue();count.incrementAndGet();return TelegramTransport.Outcome.sent(44);});
		assertThat(worker.dispatchOne()).isTrue();assertThat(worker.dispatchOne()).isFalse();assertThat(count).hasValue(1);assertThat(status(id)).isEqualTo("sent");
		assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries where id=?",Long.class,id)).isEqualTo(44);
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts where result_status='sent'",Long.class)).isEqualTo(1);
	}
	@Test void sharedQuotaDefersWithoutNetworkOrConsumingAttempt() {
		var id=due("quota");var decision=quota.reserve("12345",902L,DeliveryQuota.Limits.defaults());assertThat(decision.allowed()).isTrue();
		var count=new AtomicInteger();worker(m->{count.incrementAndGet();return TelegramTransport.Outcome.sent(1);}).dispatchOne();
		assertThat(count).hasValue(0);assertThat(status(id)).isEqualTo("planned");
		assertThat(jdbc.queryForObject("select attempts from notification_deliveries where id=?",Integer.class,id)).isZero();
		assertThat(jdbc.queryForObject("select available_at from notification_deliveries where id=?",java.sql.Timestamp.class,id).toInstant()).isAfter(now);
	}
	@Test void twoProcessesShareQuotaAndBotAndGroupBucketsKeepTheirIntervals() throws Exception {
		var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return quota.reserve("12345",902L,DeliveryQuota.Limits.defaults());});
			var b=pool.submit(()->{gate.await();return quota.reserve("12345",902L,DeliveryQuota.Limits.defaults());});gate.countDown();
			assertThat(a.get(10,TimeUnit.SECONDS).allowed()).isNotEqualTo(b.get(10,TimeUnit.SECONDS).allowed());
		}
		jdbc.update("update delivery_rate_limits set next_at=clock_timestamp()+interval '1 minute' where bucket_key='12345:global'");
		assertThat(quota.reserve("12345",999L,DeliveryQuota.Limits.defaults()).allowed()).isFalse();
		assertThat(quota.reserve("54321",902L,DeliveryQuota.Limits.defaults()).allowed()).isTrue();
		var group=quota.reserve("98765",-100L,DeliveryQuota.Limits.defaults());assertThat(group.allowed()).isTrue();
		var blocked=quota.reserve("98765",-100L,DeliveryQuota.Limits.defaults());assertThat(blocked.allowed()).isFalse();
		assertThat(Duration.between(group.availableAt(),blocked.availableAt())).isEqualTo(Duration.ofSeconds(3));
	}
	@Test void retryAfterPausesBotAndChatAndSurvivesSubsequentWorkerCall() {
		var id=due("flood");var count=new AtomicInteger();var worker=worker(m->{count.incrementAndGet();return TelegramTransport.Outcome.retry("telegram_429",Duration.ofSeconds(120));});
		worker.dispatchOne();assertThat(status(id)).isEqualTo("retry");assertThat(worker.dispatchOne()).isFalse();assertThat(count).hasValue(1);
		assertThat(jdbc.queryForObject("select available_at from notification_deliveries where id=?",java.sql.Timestamp.class,id).toInstant()).isAfterOrEqualTo(now.plusSeconds(120));
		var another=quota.reserve("12345",111L,DeliveryQuota.Limits.defaults());assertThat(another.allowed()).isFalse();assertThat(another.availableAt()).isAfterOrEqualTo(now.plusSeconds(120));
		assertThat(quota.reserve("555",902L,DeliveryQuota.Limits.defaults()).allowed()).isTrue();
	}
	@Test void lostResponseAndUnexpectedTransportExceptionAreUnknownNeverAutomaticallyRepeated() {
		var id=due("lost");var count=new AtomicInteger();var worker=worker(m->{count.incrementAndGet();return TelegramTransport.Outcome.unknown("response_timeout");});
		worker.dispatchOne();worker.dispatchOne();assertThat(status(id)).isEqualTo("unknown");assertThat(count).hasValue(1);
		jdbc.execute("truncate delivery_rate_limits");var second=due("throw");worker(m->{throw new IllegalStateException("secret token");}).dispatchOne();
		assertThat(status(second)).isEqualTo("unknown");assertThat(jdbc.queryForObject("select last_error_code from notification_deliveries where id=?",String.class,second)).isEqualTo("transport_exception_after_start");
	}
	@Test void futureCancelledAndNonBroadcastRowsNeverReachNetwork() {
		var future=delivery("future",now.plusSeconds(60),"{\"text\":\"Позже\"}");var cancelled=due("cancel");queue.cancel(cancelled);
		var other=tx.execute(s->queue.enqueue(new DeliveryQueue.NewDelivery("task","other","task",null,902L,null,"{\"text\":\"Задача\"}",true,now.minusSeconds(1),now.minusSeconds(1),null)));
		assertThat(worker(m->{throw new AssertionError("unexpected send");}).dispatchOne()).isFalse();assertThat(status(future)).isEqualTo("planned");assertThat(status(cancelled)).isEqualTo("cancelled");assertThat(status(other)).isEqualTo("planned");
	}
	@Test void staleOrCancelledLeaseCannotBeDeferredAndDeferralPastExpiryIsTerminal() {
		var id=due("defer");var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();
		assertThat(queue.deferBeforeStart(id,"wrong",now.plusSeconds(10))).isFalse();
		assertThat(queue.deferBeforeStart(id,lease.token(),now.plusSeconds(1000))).isTrue();assertThat(status(id)).isEqualTo("expired");assertThat(queue.start(id,lease.token())).isFalse();
		var second=due("cancelled-lease");var old=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();queue.cancel(second);
		assertThat(queue.deferBeforeStart(second,old.token(),now.plusSeconds(10))).isFalse();
	}
	@Test void twoWorkersOnlyOneNetworkAttemptAndTransactionsAreForbidden() throws Exception {
		var id=due("concurrent");var count=new AtomicInteger();TelegramTransport transport=m->{count.incrementAndGet();return TelegramTransport.Outcome.sent(4);};var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return worker(transport).dispatchOne();});var b=pool.submit(()->{gate.await();return worker(transport).dispatchOne();});gate.countDown();a.get(10,TimeUnit.SECONDS);b.get(10,TimeUnit.SECONDS);
		}
		assertThat(count).hasValue(1);assertThat(status(id)).isEqualTo("sent");
		assertThatThrownBy(()->tx.execute(s->worker(transport).dispatchOne())).isInstanceOf(IllegalStateException.class).hasMessage("dispatcher_requires_no_transaction");
	}
	@Test void permanentFailureAndInvalidPayloadAreTerminalWithoutRetry() {
		var id=due("blocked");worker(m->TelegramTransport.Outcome.failed("telegram_403")).dispatchOne();assertThat(status(id)).isEqualTo("failed");
		var invalid=delivery("invalid",now.minusSeconds(1),"{\"body\":\"wrong\"}");worker(m->{throw new AssertionError("invalid payload sent");}).dispatchOne();assertThat(status(invalid)).isEqualTo("failed");
	}
	@Test void wakeupRunsWithoutTelegramPollingAndStopsClaimsOnShutdown() throws Exception {
		var id=due("wake");var invoked=new CountDownLatch(1);var worker=worker(m->{invoked.countDown();return TelegramTransport.Outcome.sent(70);});
		try(var fixture=new org.springframework.context.annotation.AnnotationConfigApplicationContext()) {
			fixture.registerBean(org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor.class);
			fixture.registerBean(BroadcastDispatcher.class,()->worker);fixture.refresh();
			assertThat(invoked.await(5,TimeUnit.SECONDS)).isTrue();
		}
		assertThat(worker.isRunning()).isFalse();assertThat(status(id)).isEqualTo("sent");
	}
	@Test void drainingDoesNotResendUnknownOrIgnoreCancellationBetweenMessages() throws Exception {
		var a=due("drain-first");var b=due("drain-second");var count=new AtomicInteger();
		var worker=new BroadcastDispatcher(queue,quota,message->{
			assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
			count.incrementAndGet();
			jdbc.queryForList("select id from notification_deliveries where status='planned'",String.class).forEach(queue::cancel);
			return TelegramTransport.Outcome.unknown("response_timeout");
		},json,"12345",new DeliveryQuota.Limits(1000,1000,60000));
		worker.start();
		try {
			worker.wakeup();long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
			while(worker.workerStatus().workInProgress() && System.nanoTime()<deadline)java.util.concurrent.locks.LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(5));
			assertThat(worker.workerStatus().workInProgress()).isFalse();
			worker.wakeup();
		}finally { worker.stop(); }
		assertThat(count).hasValue(1);assertThat(java.util.List.of(status(a),status(b))).containsExactlyInAnyOrder("unknown","cancelled");
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isEqualTo(1);
	}
	@Test void shutdownFinishesCurrentSendWithoutStartingNextDrainedDelivery() throws Exception {
		due("stop-first");due("stop-second");var entered=new CountDownLatch(1);var release=new CountDownLatch(1);var count=new AtomicInteger();
		var worker=new BroadcastDispatcher(queue,quota,message->{
			count.incrementAndGet();entered.countDown();
			try { assertThat(release.await(5,TimeUnit.SECONDS)).isTrue(); }
			catch(InterruptedException e) { Thread.currentThread().interrupt();throw new AssertionError(e); }
			return TelegramTransport.Outcome.sent(71);
		},json,"12345",new DeliveryQuota.Limits(1000,1000,60000));
		worker.start();worker.wakeup();
		try(var pool=Executors.newSingleThreadExecutor()) {
			assertThat(entered.await(5,TimeUnit.SECONDS)).isTrue();var stopped=pool.submit(()->{worker.stop();});
			try {
				long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
				while(worker.isRunning() && System.nanoTime()<deadline)java.util.concurrent.locks.LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(5));
				assertThat(worker.isRunning()).isFalse();
			}finally { release.countDown(); }
			stopped.get(5,TimeUnit.SECONDS);
		}finally { release.countDown();worker.stop(); }
		assertThat(count).hasValue(1);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='sent'",Integer.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='planned' and attempts=0",Integer.class)).isEqualTo(1);
	}
}
