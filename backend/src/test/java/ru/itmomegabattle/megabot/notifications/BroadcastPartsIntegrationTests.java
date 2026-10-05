package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
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
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.auth.*;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class) @SpringBootTest(properties="megabot.broadcast.request-max=100") @AutoConfigureMockMvc
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class BroadcastPartsIntegrationTests {
	@Autowired JdbcTemplate jdbc; @Autowired BroadcastService broadcasts; @Autowired DeliveryJournalService journal;
	@Autowired DeliveryQueue queue; @Autowired DeliveryQuota quota; @Autowired BroadcastExpiryPlanner expiry;
	@Autowired ObjectMapper json; @Autowired MockMvc mvc; @Autowired SessionService sessions;
	AuthenticatedUser actor=new AuthenticatedUser("a","author","Автор","organizer");
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,broadcasts,broadcast_group_targets,notification_deliveries,delivery_rate_limits,idempotency_requests,audit_events cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',4400,'author','Автор','organizer',true),('r',4401,'recipient','Адресат','organizer',true),('n',null,'unavailable','Недоступен','organizer',true)");
	}
	String create(String text) { return (String)broadcasts.create(new BroadcastController.Mutation("",text,"people",List.of("r"),null,null,"now",null,"Europe/Moscow","send_late",true,null),actor).get("id"); }
	BroadcastDispatcher worker(TelegramTransport transport) { return new BroadcastDispatcher(queue,quota,transport,json,"12345",new DeliveryQuota.Limits(1000,1000,60000)); }
	List<DeliveryQueue.Lease> claim() { return queue.claimBroadcasts(10,Duration.ofSeconds(30),"12345"); }
	String status(String id) { return (String)broadcasts.get(id,actor).get("status"); }
	void sent(DeliveryQueue.Lease lease) { assertThat(queue.start(lease.id(),lease.token())).isTrue();assertThat(queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(100))).isTrue(); }
	@Test void partsAreAtomicOrderedAndOneRecipientIsNotReportedSentAfterFirstPart() {
		var text="x".repeat(8001);var id=create(text);assertThat(broadcasts.get(id,actor).get("targetCount")).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isEqualTo(3);
		assertThat(jdbc.queryForObject("select volume_count from broadcast_creation_limits where author_id='a'",Long.class)).isEqualTo(3);
		var first=claim();assertThat(first).hasSize(1);sent(first.getFirst());assertThat(status(id)).isEqualTo("partial");
		var sentTexts=new ArrayList<String>();sentTexts.add(json.readTree(first.getFirst().payload()).path("text").asText());
		var worker=worker(m->{assertThat(m.silent()).isTrue();sentTexts.add(m.text());return TelegramTransport.Outcome.sent(101);});
		for(int i=0;i<5;i++)worker.dispatchOne();assertThat(String.join("",sentTexts)).isEqualTo(text);assertThat(status(id)).isEqualTo("sent");
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isEqualTo(3);
		assertThat(broadcasts.get(id,actor).get("deliveryCounts")).isEqualTo(Map.of("sent",1L));
	}
	@Test void twoWorkersCannotSendLaterPartWhileFirstIsClaimedOrSending() throws Exception {
		create("a".repeat(8001));var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			Callable<List<DeliveryQueue.Lease>> command=()->{gate.await();return claim();};var a=pool.submit(command);var b=pool.submit(command);gate.countDown();
			var combined=new ArrayList<DeliveryQueue.Lease>();combined.addAll(a.get(10,TimeUnit.SECONDS));combined.addAll(b.get(10,TimeUnit.SECONDS));assertThat(combined).hasSize(1);
			assertThat(queue.start(combined.getFirst().id(),combined.getFirst().token())).isTrue();assertThat(claim()).isEmpty();
			assertThat(queue.finish(combined.getFirst().id(),combined.getFirst().token(),DeliveryQueue.Result.sent(103))).isTrue();assertThat(claim()).hasSize(1);
		}
	}
	@Test void unknownStopsNextPartAndExplicitRetryCopiesOnlyThatPart() {
		var id=create("a".repeat(4000)+"b".repeat(4000)+"c");var calls=new AtomicInteger();var unknown=worker(m->{calls.incrementAndGet();return TelegramTransport.Outcome.unknown("response_timeout");});
		assertThat(unknown.dispatchOne()).isTrue();assertThat(unknown.dispatchOne()).isFalse();assertThat(status(id)).isEqualTo("unknown");
		var original=jdbc.queryForObject("select id from notification_deliveries where part_number=1",String.class);
		var retry=journal.retry(id,original,new DeliveryJournalController.Retry(0L,true),actor);
		assertThat(jdbc.queryForObject("select part_count from notification_deliveries where id=?",Integer.class,retry.get("id"))).isEqualTo(3);
		jdbc.execute("truncate delivery_rate_limits");var text=new ArrayList<String>();var worker=worker(m->{text.add(m.text());return TelegramTransport.Outcome.sent(104);});
		for(int i=0;i<6;i++)worker.dispatchOne();assertThat(text).containsExactly("a".repeat(4000),"b".repeat(4000),"c");
		assertThat(calls).hasValue(1);assertThat(status(id)).isEqualTo("sent");assertThat(broadcasts.get(id,actor).get("targetCount")).isEqualTo(1);
		assertThat(json.writeValueAsString(journal.list(id,actor,50,null))).contains("partNumber","partCount","retryOf");
	}
	@Test void retryAfterDoesNotSkipToLaterPartOrResendEarlierSuccesses() {
		var id=create("a".repeat(4000)+"b".repeat(4000)+"c");sent(claim().getFirst());
		var calls=new AtomicInteger();var worker=worker(m->{calls.incrementAndGet();assertThat(m.text()).isEqualTo("b".repeat(4000));return TelegramTransport.Outcome.retry("telegram_429",Duration.ofSeconds(120));});
		worker.dispatchOne();assertThat(worker.dispatchOne()).isFalse();assertThat(calls).hasValue(1);
		jdbc.execute("truncate delivery_rate_limits");jdbc.update("update notification_deliveries set available_at=clock_timestamp()-interval '1 second' where status='retry'");
		var seen=new ArrayList<String>();var resumed=worker(m->{seen.add(m.text());return TelegramTransport.Outcome.sent(105);});for(int i=0;i<5;i++)resumed.dispatchOne();
		assertThat(seen).containsExactly("b".repeat(4000),"c");assertThat(status(id)).isEqualTo("sent");
	}
	@Test void cancellationAfterPartialSuccessKeepsHistoryAndPreventsRest() {
		var id=create("a".repeat(8001));sent(claim().getFirst());broadcasts.cancel(id,0L,actor);
		assertThat(worker(m->{throw new AssertionError("cancelled part");}).dispatchOne()).isFalse();
		assertThat(status(id)).isEqualTo("cancelled");assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='sent'",Integer.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='cancelled'",Integer.class)).isEqualTo(2);
	}
	@Test void expiredRemainingPartsGiveOnePartialAuthorNoticeNotSeveralRecipients() {
		var id=create("a".repeat(8001));sent(claim().getFirst());
		jdbc.update("update broadcasts set expires_at=clock_timestamp()-interval '1 second',scheduled_at=clock_timestamp()-interval '16 minutes' where id=?",id);
		jdbc.update("update notification_deliveries set intended_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 second' where status='planned'");
		queue.expirePending();assertThat(expiry.materialize(20)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select payload->>'text' from notification_deliveries where category='broadcast_expired'",String.class)).contains("Подтверждена только часть текста: 1").doesNotContain("Подтверждено Telegram:");
		assertThat(broadcasts.get(id,actor).get("targetCount")).isEqualTo(1);
	}
	@Test void legacyAndV1AcceptLongTextButRejectOversizeBeforeAnyWrites() throws Exception {
		var cookie=new Cookie("megabot_session",sessions.rotateFor("a").rawToken());
		for(var path:List.of("/api/v1/broadcasts","/api/team/broadcast")) {
			var body=Map.of("body","x".repeat(4001),"recipientMode","people","recipientIds",List.of("r"),"dispatchMode","now");
			mvc.perform(post(path).cookie(cookie).header("Origin","http://localhost").header("Idempotency-Key","long-"+path.hashCode()).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().is2xxSuccessful());
			var oversized=Map.of("body","x".repeat(40001),"recipientMode","people","recipientIds",List.of("r"),"dispatchMode","now");
			mvc.perform(post(path).cookie(cookie).header("Origin","http://localhost").header("Idempotency-Key","large-"+path.hashCode()).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(oversized))).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadRequest());
		}
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Integer.class)).isEqualTo(2);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isEqualTo(4);
	}
	@Test void failureSavingMiddlePartRollsBackSourceTargetsQuotaAndAudit() {
		jdbc.execute("create function reject_middle_part() returns trigger language plpgsql as $$ begin if NEW.part_number=2 then raise exception 'test-only middle part failure'; end if; return NEW; end $$");
		jdbc.execute("create trigger reject_middle_part before update on notification_deliveries for each row execute function reject_middle_part()");
		try {
			assertThatThrownBy(()->create("a".repeat(8001))).isInstanceOf(org.springframework.dao.DataAccessException.class);
			for(var table:List.of("broadcasts","broadcast_targets","notification_deliveries","broadcast_creation_limits","audit_events"))
				assertThat(jdbc.queryForObject("select count(*) from "+table,Integer.class)).as(table).isZero();
		} finally {
			jdbc.execute("drop trigger reject_middle_part on notification_deliveries");
			jdbc.execute("drop function reject_middle_part()");
		}
	}
	@Test void blockedRecipientDoesNotStopOthersAndUnavailableDoesNotMultiplyAudience() {
		var id=(String)broadcasts.create(new BroadcastController.Mutation("","a".repeat(8001),"people",List.of("a","r","n"),null,null,"now",null,"Europe/Moscow","send_late",true,null),actor).get("id");
		var first=claim();assertThat(first).hasSize(2);
		for(var lease:first) {
			assertThat(queue.start(lease.id(),lease.token())).isTrue();
			assertThat(queue.finish(lease.id(),lease.token(),lease.recipientId().equals("r")?DeliveryQueue.Result.unknown("response_timeout"):DeliveryQueue.Result.sent(109))).isTrue();
		}
		var next=claim();assertThat(next).hasSize(1);assertThat(next.getFirst().recipientId()).isEqualTo("a");sent(next.getFirst());sent(claim().getFirst());
		assertThat(claim()).isEmpty();assertThat(broadcasts.get(id,actor).get("targetCount")).isEqualTo(3);
		assertThat(broadcasts.get(id,actor).get("deliveryCounts")).isEqualTo(Map.of("sent",1L,"unknown",1L,"unavailable",1L));
	}
	@Test void groupPartsPreserveApprovalTopicAndRevocationBlocksRemainingParts() {
		jdbc.update("insert into broadcast_group_targets(id,label,bot_id,chat_id,message_thread_id,active,approved_by) values ('g','Группа','12345',-100123,7,true,'a')");
		var id=(String)broadcasts.create(new BroadcastController.Mutation("","a".repeat(8001),"groups",null,null,null,"now",null,"Europe/Moscow","send_late",true,null,List.of("g")),actor).get("id");
		assertThat(worker(m->{assertThat(m.threadId()).isEqualTo(7);return TelegramTransport.Outcome.sent(107);}).dispatchOne()).isTrue();
		jdbc.update("update broadcast_group_targets set active=false,version=version+1 where id='g'");
		var worker=worker(m->{throw new AssertionError("revoked group part");});worker.dispatchOne();assertThat(worker.dispatchOne()).isFalse();assertThat(status(id)).isEqualTo("partial");
	}
}
