package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
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
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class)
@SpringBootTest(properties={"spring.datasource.hikari.connection-init-sql=SET search_path TO public,pg_catalog",
		"megabot.delivery.enabled=false"})
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class BroadcastExpiryIntegrationTests {
	@Autowired JdbcTemplate jdbc; @Autowired BroadcastExpiryPlanner planner; @Autowired BroadcastService broadcasts;
	@Autowired DeliveryQueue queue; @Autowired DeliveryQuota quota; @Autowired ObjectMapper json; @Autowired PlatformTransactionManager manager;
	AuthenticatedUser actor=new AuthenticatedUser("a","author","Автор","organizer");
	Instant due=Instant.parse("2026-10-05T06:45:00Z"),expiry=Instant.parse("2026-10-05T07:00:00Z");
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,broadcasts,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',4200,'author','Автор','organizer',true),('r',4201,'recipient','Адресат','organizer',true),('s',4202,'sent','Успех','organizer',true),('u',4203,'unknown','Неизвестно','organizer',true),('n',null,'nochat','Без чата','organizer',true)");
		jdbc.update("insert into broadcasts(id,author_id,title,content,scheduled_at,expires_at,misfire_policy,status) values ('b','a','Объявление','Секретный текст',?,?,'send_within_grace','scheduled')",java.sql.Timestamp.from(due),java.sql.Timestamp.from(expiry));
		time(expiry.toString());target("r","planned");
	}
	@AfterEach void restoreClock() {
		jdbc.execute("drop trigger if exists reject_expiry_delivery on notification_deliveries");
		jdbc.execute("drop function if exists reject_expiry_delivery()");jdbc.execute("drop function if exists public.clock_timestamp()");
	}
	void time(String value) {
		jdbc.execute("create or replace function public.clock_timestamp() returns timestamptz language sql volatile as $$ select timestamptz '"+Instant.parse(value)+"' $$");
	}
	String target(String person,String status) {
		return new TransactionTemplate(manager).execute(s->{
			var chat=jdbc.queryForObject("select telegram_id from users where id=?",Long.class,person);
			jdbc.update("insert into broadcast_targets(id,broadcast_id,revision,target_key,recipient_id,chat_id,availability) values (?,'b',1,?,?,?,?)","t"+person,"user:"+person,person,chat,chat==null?"unavailable":"ready");
			if(chat==null)return null;
			var id=queue.enqueue(new DeliveryQueue.NewDelivery("b","b:"+person,"broadcast",person,chat,null,"{\"text\":\"Секретный текст\"}",true,due,due,expiry));
			jdbc.update("update notification_deliveries set broadcast_target_id=?,status=? where id=?","t"+person,status,id);return id;
		});
	}
	long count(String table) { return jdbc.queryForObject("select count(*) from "+table,Long.class); }
	String noticeDelivery() { return jdbc.queryForObject("select id from notification_deliveries where category='broadcast_expired'",String.class); }
	String status(String id) { return jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,id); }
	BroadcastDispatcher worker(TelegramTransport transport) {
		return new BroadcastDispatcher(queue,quota,transport,json,"12345",DeliveryQuota.Limits.defaults(),null,null,Clock.systemUTC(),null,null,null,planner);
	}
	void materialize() { queue.expirePending();assertThat(planner.materialize(20)).isEqualTo(1); }
	@Test void notBeforeExpiryThenOneAuthorNoticeWithHonestPartialAndUnknownCounts() {
		var sent=target("s","sent");target("u","unknown");target("n",null);
		time("2026-10-05T06:59:59Z");assertThat(planner.materialize(20)).isZero();queue.expirePending();assertThat(count("broadcast_expiry_notices")).isZero();
		time(expiry.toString());materialize();assertThat(planner.materialize(20)).isZero();
		var text=jdbc.queryForObject("select payload->>'text' from notification_deliveries where category='broadcast_expired'",String.class);
		assertThat(text).contains("Объявление","Срок истёк для оставшихся отправок: 1","Подтверждено Telegram: 1","Результат неизвестен (сообщение могло прийти): 1","Telegram недоступен: 1").doesNotContain("Секретный текст");
		var count=new AtomicInteger();var worker=worker(m->{assertThat(m.chatId()).isEqualTo(4200);assertThat(m.threadId()).isNull();count.incrementAndGet();return TelegramTransport.Outcome.sent(90);});
		assertThat(worker.dispatchOne()).isTrue();assertThat(worker.dispatchOne()).isFalse();assertThat(count).hasValue(1);
		assertThat(status(sent)).isEqualTo("sent");assertThat(status(noticeDelivery())).isEqualTo("sent");assertThat(count("broadcast_expiry_notices")).isEqualTo(1);
		assertThat(broadcasts.get("b",actor).get("targetCount")).isEqualTo(4);
	}
	@Test void noExpiryNoticeForCancelledFullySentUnavailableOrSupersededRevision() {
		for(var change:List.of("update broadcasts set status='cancelled' where id='b'","update notification_deliveries set status='sent'",
				"update notification_deliveries set status='cancelled'","update broadcasts set content_revision=2 where id='b'")) {
			prepare();jdbc.execute(change);queue.expirePending();assertThat(planner.materialize(20)).as(change).isZero();
		}
	}
	@Test void waitForInFlightResultAndNeverCallUnknownConfirmed() {
		target("u","planned");time("2026-10-05T06:59:59Z");
		var lease=queue.claimBroadcasts(10,Duration.ofSeconds(30)).stream().filter(l->l.recipientId().equals("u")).findFirst().orElseThrow();
		assertThat(queue.start(lease.id(),lease.token())).isTrue();time(expiry.toString());
		queue.expirePending();assertThat(planner.materialize(20)).isZero();
		assertThat(queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.unknown("response_timeout"))).isTrue();
		assertThat(planner.materialize(20)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select payload->>'text' from notification_deliveries where category='broadcast_expired'",String.class)).contains("Результат неизвестен").doesNotContain("Подтверждено Telegram");
	}
	@Test void unavailableAuthorIsRecordedWithoutSendingOrRearmingOnLaterBinding() {
		for(var change:List.of("update users set telegram_id=null where id='a'","update users set registered=false where id='a'",
				"update users set active=false,deactivated_at=now() where id='a'","update users set role='faculty_helper' where id='a'")) {
			prepare();jdbc.execute(change);materialize();assertThat(jdbc.queryForObject("select state from broadcast_expiry_notices",String.class)).isEqualTo("unavailable");
			assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where category='broadcast_expired'",Integer.class)).isZero();
			jdbc.update("update users set telegram_id=4200,active=true,deactivated_at=null,registered=true,role='organizer' where id='a'");assertThat(planner.materialize(20)).isZero();
		}
	}
	@Test void authorBindingRoleActivationAndRevisionGatesCancelClaimedNotice() {
		for(var change:List.of("update users set telegram_id=4999 where id='a'","update users set telegram_id=null where id='a'",
				"update users set role='faculty_helper' where id='a'","update users set active=false,deactivated_at=now() where id='a'",
				"update users set registered=false where id='a'","update broadcasts set content_revision=2 where id='b'")) {
			prepare();materialize();var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();jdbc.execute(change);
			assertThat(queue.start(lease.id(),lease.token())).as(change).isFalse();assertThat(status(lease.id())).isEqualTo("cancelled");assertThat(count("delivery_attempts")).isZero();
		}
	}
	@Test void cancelCommandCancelsNoticeAndDetailRemainsPrivateSafeAndDoesNotInflateRecipients() {
		materialize();var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();
		var detail=broadcasts.get("b",actor);assertThat(detail.get("targetCount")).isEqualTo(1);
		assertThat(json.writeValueAsString(detail.get("expiryNotice"))).contains("claimed").doesNotContain("4200","chatId","payload","lease","token");
		assertThatThrownBy(()->broadcasts.get("b",new AuthenticatedUser("r","recipient","Адресат","organizer"))).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
		broadcasts.cancel("b",0L,actor);assertThat(status(lease.id())).isEqualTo("cancelled");assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
	@Test void atomicRollbackAndConcurrentPlannersProduceOneNotice() throws Exception {
		queue.expirePending();jdbc.execute("create function reject_expiry_delivery() returns trigger language plpgsql as $$ begin if new.category='broadcast_expired' then raise exception 'test rejection'; end if; return new; end $$");
		jdbc.execute("create trigger reject_expiry_delivery before insert on notification_deliveries for each row execute function reject_expiry_delivery()");
		assertThatThrownBy(()->planner.materialize(20)).isInstanceOf(RuntimeException.class);assertThat(count("broadcast_expiry_notices")).isZero();
		jdbc.execute("drop trigger reject_expiry_delivery on notification_deliveries");var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return planner.materialize(20);});var b=pool.submit(()->{gate.await();return planner.materialize(20);});gate.countDown();
			assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}
		assertThat(count("broadcast_expiry_notices")).isEqualTo(1);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where category='broadcast_expired'",Integer.class)).isEqualTo(1);
	}
	@Test void reschedulingBeforeAnyRecipientAttemptRevokesOldNoticeAndHidesOldRevision() {
		materialize();var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();
		broadcasts.update("b",new BroadcastController.Mutation("Новое","Новый текст","people",List.of("r"),null,null,
				"scheduled",expiry.plusSeconds(120),"Europe/Moscow","send_late",false,0L),actor);
		assertThat(status(lease.id())).isEqualTo("cancelled");assertThat(queue.start(lease.id(),lease.token())).isFalse();
		assertThat(broadcasts.get("b",actor).get("expiryNotice")).isNull();assertThat(planner.materialize(20)).isZero();
	}
	@Test void linkedRetryCountsOneRecipientAndDoesNotTreatParentUnknownAsAnotherTarget() {
		var parent=jdbc.queryForObject("select id from notification_deliveries where recipient_id='r'",String.class);
		jdbc.update("update notification_deliveries set status='unknown' where id=?",parent);
		new TransactionTemplate(manager).executeWithoutResult(s->{
			var child=queue.enqueue(new DeliveryQueue.NewDelivery("b","manual-child","broadcast","r",4201,null,"{\"text\":\"Секретный текст\"}",true,due,due,expiry));
			jdbc.update("update notification_deliveries set broadcast_target_id='tr',retry_of=?,status='expired' where id=?",parent,child);
		});
		assertThat(planner.materialize(20)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select payload->>'text' from notification_deliveries where category='broadcast_expired'",String.class)).contains("Срок истёк для оставшихся отправок: 1","сообщение могло прийти ранее","не доказывает недоставку предыдущей").doesNotContain("Результат неизвестен");
		assertThat(broadcasts.get("b",actor).get("targetCount")).isEqualTo(1);
	}
	@Test void retryAfterAndUnknownUseExistingQueueWithoutRepeatedNotice() {
		materialize();var sends=new AtomicInteger();var worker=worker(m->{sends.incrementAndGet();return TelegramTransport.Outcome.retry("telegram_429",Duration.ofSeconds(10));});
		worker.dispatchOne();assertThat(status(noticeDelivery())).isEqualTo("retry");assertThat(worker.dispatchOne()).isFalse();assertThat(sends).hasValue(1);
		time("2026-10-05T07:00:11Z");worker(m->{sends.incrementAndGet();return TelegramTransport.Outcome.unknown("response_timeout");}).dispatchOne();
		assertThat(status(noticeDelivery())).isEqualTo("unknown");assertThat(worker.dispatchOne()).isFalse();assertThat(sends).hasValue(2);assertThat(planner.materialize(20)).isZero();
	}
	@Test void expiredNoticeAndOldBacklogNeverBecomeNewDelayedMessages() {
		time("2026-10-06T07:00:00Z");materialize();assertThat(jdbc.queryForObject("select state from broadcast_expiry_notices",String.class)).isEqualTo("expired");
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where category='broadcast_expired'",Integer.class)).isZero();
		prepare();materialize();time("2026-10-06T07:00:00Z");assertThat(worker(m->{throw new AssertionError("late notice");}).dispatchOne()).isFalse();
		assertThat(status(noticeDelivery())).isEqualTo("expired");assertThat(planner.materialize(20)).isZero();
	}
	@Test void movedClockAfterClaimBlocksEarlyNoticeWithoutDiscardingIntent() {
		materialize();var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();time("2026-10-05T06:59:59Z");
		assertThat(queue.start(lease.id(),lease.token())).isFalse();assertThat(status(lease.id())).isEqualTo("claimed");
		time("2026-10-05T07:00:31Z");assertThat(queue.recoverExpiredLeases()).isEqualTo(1);
		assertThat(worker(m->TelegramTransport.Outcome.sent(91)).dispatchOne()).isTrue();assertThat(status(lease.id())).isEqualTo("sent");
	}
	@Test void oversizedLegacyTitleStaysWithinTransportLimitAndBadBatchFails() {
		jdbc.update("update broadcasts set title=? where id='b'","💙".repeat(3000));materialize();
		assertThat(worker(m->{assertThat(m.text().length()).isLessThan(4000);return TelegramTransport.Outcome.sent(92);}).dispatchOne()).isTrue();
		assertThatThrownBy(()->planner.materialize(0)).isInstanceOf(IllegalArgumentException.class);
	}
}
