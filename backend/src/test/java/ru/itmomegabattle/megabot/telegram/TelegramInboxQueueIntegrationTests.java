package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;

@SpringBootTest @Import(TestcontainersConfiguration.class) @ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
class TelegramInboxQueueIntegrationTests {
	@Autowired TelegramInbox inbox;@Autowired TelegramInboxQueue queue;
	@Autowired JdbcTemplate jdbc;@Autowired PlatformTransactionManager transactions;
	@BeforeEach void clear() { jdbc.execute("truncate telegram_inbox,bot_messages"); }
	void accept(String bot,long update,long chat) {
		inbox.accept(bot,("{\"update_id\":"+update+",\"message\":{\"chat\":{\"id\":"+chat+"},\"text\":\"/start\"}}")
				.getBytes(StandardCharsets.UTF_8));
	}
	List<TelegramInboxQueue.Lease> claim() { return queue.claim("123",100,Duration.ofSeconds(300)); }
	String status(String id) { return jdbc.queryForObject("select status from telegram_inbox where id=?",String.class,id); }
	void effect() { jdbc.update("insert into bot_messages(id,sender,text,occurred_at) values ('fixture','bot','queued response',now())"); }
	@Test void batchTakesOnlyHeadsAndDifferentBotsRemainSeparate() {
		accept("123",1,51);accept("123",2,51);accept("123",3,52);accept("456",1,51);
		var heads=claim();assertThat(heads).extracting(TelegramInboxQueue.Lease::updateId).containsExactlyInAnyOrder(1L,3L);
		assertThat(heads).allMatch(row->row.attempts()==1 && row.botId().equals("123"));
		assertThat(claim()).isEmpty();
		assertThat(queue.claim("456",1,Duration.ofSeconds(30))).hasSize(1);
		var first=heads.stream().filter(row->row.updateId()==1).findFirst().orElseThrow();
		assertThat(queue.apply(first.id(),first.token(),row->assertThat(row.payload()).contains("/start"))).isTrue();
		assertThat(claim()).extracting(TelegramInboxQueue.Lease::updateId).containsExactly(2L);
	}
	@Test void delayedRetryBlocksFollowersAndPermanentFailureReleasesThem() {
		accept("123",1,51);accept("123",2,51);var first=claim().getFirst();
		assertThat(queue.reject(first.id(),first.token(),"temporary",Duration.ofMinutes(2))).isTrue();
		assertThat(status(first.id())).isEqualTo("retry");assertThat(claim()).isEmpty();
		jdbc.update("update telegram_inbox set available_at=now()-interval '1 second' where id=?",first.id());
		var next=claim().getFirst();assertThat(next.id()).isEqualTo(first.id());assertThat(next.attempts()).isEqualTo(2);
		assertThat(queue.reject(next.id(),next.token(),"unsupported_update",null)).isTrue();
		assertThat(status(first.id())).isEqualTo("failed");
		assertThat(claim()).extracting(TelegramInboxQueue.Lease::updateId).containsExactly(2L);
	}
	@Test void receptionOrderDoesNotAssumeUpdateIdsAlwaysIncrease() {
		accept("123",900,51);accept("123",2,51);
		jdbc.update("update telegram_inbox set received_at=now()-interval '1 day' where update_id=900");
		var first=claim().getFirst();assertThat(first.updateId()).isEqualTo(900);
		assertThat(queue.apply(first.id(),first.token(),row->{})).isTrue();
		assertThat(claim()).extracting(TelegramInboxQueue.Lease::updateId).containsExactly(2L);
	}
	@Test void expiredLeaseIsReclaimedAndOldOwnerCannotApplyOrReject() {
		accept("123",1,51);accept("123",2,51);var old=claim().getFirst();
		jdbc.update("update telegram_inbox set leased_until=now()-interval '1 second' where id=?",old.id());
		assertThat(queue.apply(old.id(),old.token(),row->fail("Expired action must not run"))).isFalse();
		var recovered=claim().getFirst();assertThat(recovered.id()).isEqualTo(old.id());
		assertThat(recovered.token()).isNotEqualTo(old.token());assertThat(recovered.attempts()).isEqualTo(2);
		assertThat(queue.apply(old.id(),old.token(),row->fail("Stale action must not run"))).isFalse();
		assertThat(queue.reject(old.id(),old.token(),"old_failure",null)).isFalse();
		assertThat(queue.apply(recovered.id(),recovered.token(),row->effect())).isTrue();
		assertThat(queue.apply(recovered.id(),recovered.token(),row->fail("Duplicate action must not run"))).isFalse();
		assertThat(jdbc.queryForObject("select count(*) from bot_messages",Integer.class)).isEqualTo(1);
	}
	@Test void lateCommitWithEarlierReceptionCannotStartAnotherLeaseInBusyChat() {
		accept("123",2,51);var first=claim().getFirst();accept("123",1,51);
		// A long concurrent intake transaction can commit later with an earlier received_at.
		jdbc.update("update telegram_inbox set received_at=now()-interval '1 day' where update_id=1");
		assertThat(claim()).isEmpty();
		jdbc.update("update telegram_inbox set leased_until=now()-interval '1 second' where id=?",first.id());
		var recovered=claim().getFirst();assertThat(recovered.id()).isEqualTo(first.id());
		assertThat(queue.apply(recovered.id(),recovered.token(),row->{})).isTrue();
		assertThat(claim()).extracting(TelegramInboxQueue.Lease::updateId).containsExactly(1L);
	}
	@Test void effectsAndCompletionRollbackTogetherThenCanBeRetried() {
		accept("123",1,51);var lease=claim().getFirst();
		assertThatThrownBy(()->queue.apply(lease.id(),lease.token(),row->{effect();throw new IllegalStateException("fixture");}))
				.isInstanceOf(IllegalStateException.class).hasMessage("fixture");
		assertThat(status(lease.id())).isEqualTo("processing");
		assertThat(jdbc.queryForObject("select count(*) from bot_messages",Integer.class)).isZero();
		assertThat(queue.apply(lease.id(),lease.token(),row->effect())).isTrue();
		assertThat(status(lease.id())).isEqualTo("completed");
		assertThat(jdbc.queryForObject("select processed_at is not null and lease_token is null and leased_until is null from telegram_inbox",Boolean.class)).isTrue();
	}
	@Test void leaseLostDuringActionRollsBackEffectsAndCompletion() {
		accept("123",1,51);var lease=claim().getFirst();
		assertThatThrownBy(()->queue.apply(lease.id(),lease.token(),row->{
			effect();jdbc.update("update telegram_inbox set leased_until=now()-interval '1 second' where id=?",lease.id());
		})).isInstanceOf(IllegalStateException.class).hasMessage("Inbox lease expired during processing");
		assertThat(jdbc.queryForObject("select count(*) from bot_messages",Integer.class)).isZero();
		assertThat(status(lease.id())).isEqualTo("processing");
		assertThat(queue.apply(lease.id(),lease.token(),row->{})).isTrue();
	}
	@Test void databaseRejectingCompletionAlsoRollsBackDomainEffects() {
		accept("123",1,51);var lease=claim().getFirst();
		jdbc.execute("alter table telegram_inbox add constraint fixture_reject_completion check (status<>'completed')");
		try {
			assertThatThrownBy(()->queue.apply(lease.id(),lease.token(),row->effect()))
					.isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
			assertThat(status(lease.id())).isEqualTo("processing");
			assertThat(jdbc.queryForObject("select count(*) from bot_messages",Integer.class)).isZero();
		} finally { jdbc.execute("alter table telegram_inbox drop constraint fixture_reject_completion"); }
		assertThat(queue.apply(lease.id(),lease.token(),row->effect())).isTrue();
	}
	@Test @Timeout(60) void concurrentApplyRunsActionExactlyOnce() throws Exception {
		accept("123",1,51);var lease=claim().getFirst();
		try(var pool=Executors.newFixedThreadPool(2)) {
			var ready=new CountDownLatch(2);var go=new CountDownLatch(1);var futures=new ArrayList<Future<Boolean>>();
			for(int i=0;i<2;i++) futures.add(pool.submit(()->{
				ready.countDown();assertThat(go.await(10,TimeUnit.SECONDS)).isTrue();
				return queue.apply(lease.id(),lease.token(),row->effect());
			}));
			try { assertThat(ready.await(10,TimeUnit.SECONDS)).isTrue(); } finally { go.countDown(); }
			int applied=0;for(var future:futures) if(future.get(20,TimeUnit.SECONDS)) applied++;
			assertThat(applied).isEqualTo(1);
			assertThat(jdbc.queryForObject("select count(*) from bot_messages",Integer.class)).isEqualTo(1);
		}
	}
	@Test @Timeout(60) void concurrentClaimsDoNotOverlapOrSkipBusyChatHead() throws Exception {
		for(int chat=1;chat<=4;chat++) { accept("123",chat*10,chat);accept("123",chat*10+1,chat); }
		try(var pool=Executors.newFixedThreadPool(4)) {
			var ready=new CountDownLatch(4);var go=new CountDownLatch(1);
			var futures=new ArrayList<Future<List<TelegramInboxQueue.Lease>>>();
			for(int i=0;i<4;i++) futures.add(pool.submit(()->{ready.countDown();assertThat(go.await(10,TimeUnit.SECONDS)).isTrue();return claim();}));
			try { assertThat(ready.await(10,TimeUnit.SECONDS)).isTrue(); } finally { go.countDown(); }
			var claimed=new ArrayList<TelegramInboxQueue.Lease>();
			for(var future:futures) claimed.addAll(future.get(20,TimeUnit.SECONDS));
			assertThat(claimed).hasSize(4);assertThat(claimed).extracting(TelegramInboxQueue.Lease::chatKey).doesNotHaveDuplicates();
			assertThat(claimed).extracting(TelegramInboxQueue.Lease::updateId).containsExactlyInAnyOrder(10L,20L,30L,40L);
		}
	}
	@Test @Timeout(60) void claimReadsFreshSnapshotAfterWaitingForOtherClaimTransaction() throws Exception {
		accept("123",2,51);accept("123",1,51);
		jdbc.update("update telegram_inbox set received_at=now()-interval '1 day' where update_id=1");
		try(var pool=Executors.newSingleThreadExecutor()) {
			var pending=new ArrayList<Future<List<TelegramInboxQueue.Lease>>>();
			new TransactionTemplate(transactions).executeWithoutResult(tx->{
				jdbc.execute("select pg_advisory_xact_lock(hashtextextended('telegram_inbox_claim:123',0))");
				jdbc.update("update telegram_inbox set status='processing',lease_token='other_claim',leased_until=now()+interval '5 minutes' where update_id=2");
				pending.add(pool.submit(this::claim));
				long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);boolean waiting=false;
				while(System.nanoTime()<deadline) {
					// PostgreSQL caches statistics inside a transaction; refresh the observer, not the queue.
					jdbc.execute("select pg_stat_clear_snapshot()");
					waiting=jdbc.queryForObject("select exists(select 1 from pg_stat_activity where wait_event='advisory' and query like '%telegram_inbox_claim:%')",Boolean.class);
					if(waiting) break;
					try { Thread.sleep(20); } catch(InterruptedException e) { Thread.currentThread().interrupt();throw new AssertionError(e); }
				}
				assertThat(waiting).isTrue();assertThat(pending.getFirst()).isNotDone();
			});
			assertThat(pending.getFirst().get(10,TimeUnit.SECONDS)).isEmpty();
		}
	}
	@Test @Timeout(60) void lockedHeadAndInFlightTransactionPreventFollowingUpdateFromBeingClaimed() throws Exception {
		accept("123",1,51);accept("123",2,51);var lease=claim().getFirst();
		try(var pool=Executors.newSingleThreadExecutor()) {
			new TransactionTemplate(transactions).executeWithoutResult(tx->{
				jdbc.queryForObject("select id from telegram_inbox where id=? for update",String.class,lease.id());
				jdbc.update("update telegram_inbox set leased_until=now()-interval '1 second' where id=?",lease.id());
				try { assertThat(pool.submit(this::claim).get(10,TimeUnit.SECONDS)).isEmpty(); }
				catch(Exception e) { throw new AssertionError(e); }
			});
		}
		assertThat(claim()).extracting(TelegramInboxQueue.Lease::id).containsExactly(lease.id());
	}
	@Test @Timeout(60) void leaseExpiringDuringUnchangedRowLockWaitCannotApplyOrReject() throws Exception {
		for(boolean apply:List.of(true,false)) {
			jdbc.execute("truncate telegram_inbox");accept("123",1,51);var lease=claim().getFirst();
			jdbc.update("update telegram_inbox set leased_until=clock_timestamp()+interval '2 seconds' where id=?",lease.id());
			try(var pool=Executors.newSingleThreadExecutor()) {
				var pending=new ArrayList<Future<Boolean>>();
				new TransactionTemplate(transactions).executeWithoutResult(tx->{
					jdbc.queryForObject("select id from telegram_inbox where id=? for update",String.class,lease.id());
					var started=new CountDownLatch(1);
					pending.add(pool.submit(()->{started.countDown();return apply
						?queue.apply(lease.id(),lease.token(),row->fail("Expired action must not run"))
						:queue.reject(lease.id(),lease.token(),"expired_failure",null); }));
					try { assertThat(started.await(5,TimeUnit.SECONDS)).isTrue(); }
					catch(InterruptedException e) { Thread.currentThread().interrupt();throw new AssertionError(e); }
					// Deliberate real DB-clock expiry while holding a row lock, without changing its tuple.
					jdbc.execute("select pg_sleep(2.1)");
				});
				assertThat(pending.getFirst().get(10,TimeUnit.SECONDS)).isFalse();
				assertThat(status(lease.id())).isEqualTo("processing");
			}
		}
	}
	@Test void processingCommitSurvivesOuterRollbackAndRejectsUnsafeArguments() {
		accept("123",1,51);var applied=new AtomicBoolean();
		new TransactionTemplate(transactions).executeWithoutResult(tx->{
			var lease=claim().getFirst();applied.set(queue.apply(lease.id(),lease.token(),row->effect()));tx.setRollbackOnly();
		});
		assertThat(applied).isTrue();assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("completed");
		for(var duration:List.of(Duration.ZERO,Duration.ofSeconds(-1),Duration.ofSeconds(301)))
			assertThatThrownBy(()->queue.claim("123",1,duration)).isInstanceOf(IllegalArgumentException.class);
		assertThatThrownBy(()->queue.claim("SECRET:abc",1,Duration.ofSeconds(30))).hasMessage("Invalid inbox claim");
		assertThatThrownBy(()->queue.claim("123",101,Duration.ofSeconds(30))).isInstanceOf(IllegalArgumentException.class);
		assertThatThrownBy(()->queue.reject("id","token","SECRET token",null)).hasMessage("Invalid inbox error code");
		assertThatThrownBy(()->queue.reject("id","token","safe",Duration.ofDays(2))).isInstanceOf(IllegalArgumentException.class);
		assertThatThrownBy(()->queue.apply("id","token",null)).hasMessage("Missing inbox action");
	}
}
