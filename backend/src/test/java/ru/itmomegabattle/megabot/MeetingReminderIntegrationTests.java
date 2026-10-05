package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.time.*;
import java.time.temporal.TemporalAdjusters;
import java.util.*;
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
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;
import ru.itmomegabattle.megabot.notifications.DeliveryQuota;
import ru.itmomegabattle.megabot.notifications.BroadcastDispatcher;
import ru.itmomegabattle.megabot.notifications.TelegramTransport;
import tools.jackson.databind.ObjectMapper;
import org.testcontainers.junit.jupiter.Testcontainers;

@Import(TestcontainersConfiguration.class) @SpringBootTest @AutoConfigureMockMvc
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class MeetingReminderIntegrationTests {
	@Autowired JdbcTemplate jdbc; @Autowired MockMvc mvc; @Autowired SessionService sessions;
	@Autowired ObjectMapper json; @Autowired MeetingNotificationPlanner planner; @Autowired DeliveryQueue queue;
	@Autowired DeliveryQuota quota;
	Cookie host; String meeting;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,meetings,chat_bindings,outbox_events,integration_jobs,idempotency_requests,audit_events,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('h',2100,'host','Организатор','organizer',true),('u',2101,'user','Участник','organizer',true),('v',2102,'other','Другой','organizer',true)");
		host=new Cookie("megabot_session",sessions.rotateFor("h").rawToken());
	}
	String body(List<String> people,long version) {
		var date=LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.next(DayOfWeek.MONDAY));
		return json.writeValueAsString(Map.of("title","Встреча","kind","meeting","date",date.toString(),"time","18:00","durationMinutes",60,
				"audienceMode","selected","selectedUserIds",people,"expectedVersion",version,"description","PRIVATE_DESCRIPTION"));
	}
	void create() throws Exception { create(body(List.of("u"),0)); }
	void create(String content) throws Exception {
		var result=mvc.perform(post("/api/v1/meetings").cookie(host).header("Origin","http://localhost").header("Idempotency-Key","reminder-create-001")
				.contentType(MediaType.APPLICATION_JSON).content(content)).andExpect(status().isCreated()).andReturn();
		meeting=json.readTree(result.getResponse().getContentAsString()).path("id").asText();
	}
	void due() {
		jdbc.update("update outbox_events set status='cancelled' where event_type<>'meeting.reminder'");
		jdbc.update("update outbox_events set available_at=clock_timestamp()-interval '1 second' where event_type='meeting.reminder'");
	}
	List<DeliveryQueue.Lease> claims() { return queue.claimSupported(10,Duration.ofSeconds(30),"12345"); }
	long count(String table) { return jdbc.queryForObject("select count(*) from "+table,Long.class); }
	void cancel() throws Exception {
		mvc.perform(post("/api/v1/meetings/{id}/cancel",meeting).cookie(host).header("Origin","http://localhost").header("Idempotency-Key","reminder-cancel-001")
				.contentType(MediaType.APPLICATION_JSON).content("{\"expectedVersion\":0}")).andExpect(status().isOk());
	}
	@Test void hourBeforeStartIsDurableAtomicAndReplayDoesNotDuplicateIt() throws Exception {
		create();
		assertThat(jdbc.queryForObject("select extract(epoch from m.starts_at-o.available_at)::bigint from meetings m join outbox_events o on o.aggregate_id=m.id where o.event_type='meeting.reminder'",Long.class)).isEqualTo(3600);
		assertThat(count("outbox_events")).isEqualTo(2); assertThat(count("integration_jobs")).isEqualTo(1);
		mvc.perform(post("/api/v1/meetings").cookie(host).header("Origin","http://localhost").header("Idempotency-Key","reminder-create-001")
				.contentType(MediaType.APPLICATION_JSON).content(body(List.of("u"),0))).andExpect(header().string("Idempotency-Replayed","true"));
		assertThat(count("outbox_events")).isEqualTo(2);
		jdbc.update("update outbox_events set status='cancelled' where event_type='meeting.created'");
		assertThat(planner.materialize(20,"12345")).isZero(); assertThat(count("notification_deliveries")).isZero();
		due(); assertThat(planner.materialize(20,"12345")).isEqualTo(1); assertThat(planner.materialize(20,"12345")).isZero();
		var leases=claims(); assertThat(leases).hasSize(2);
		for(var lease:leases) {
			assertThat(lease.payload()).contains("Напоминание о встрече","МСК").doesNotContain("PRIVATE_DESCRIPTION");
			assertThat(queue.start(lease.id(),lease.token())).isTrue(); queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(55));
		} assertThat(claims()).isEmpty();
	}
	@Test void editCreatesNewVersionWithoutReminderToRemovedMember() throws Exception {
		create();
		mvc.perform(patch("/api/v1/meetings/{id}",meeting).cookie(host).header("Origin","http://localhost").header("Idempotency-Key","reminder-update-001")
				.contentType(MediaType.APPLICATION_JSON).content(body(List.of("v"),0))).andExpect(status().isOk());
		assertThat(count("outbox_events")).isEqualTo(4); due(); assertThat(planner.materialize(20,"12345")).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from meeting_notification_events where state='cancelled'",Long.class)).isEqualTo(1);
		assertThat(claims()).extracting(DeliveryQueue.Lease::recipientId).containsExactlyInAnyOrder("h","v");
	}
	@Test void meetingCreatedLessThanAnHourAheadDoesNotSendRetroactiveReminder() throws Exception {
		var starts=ZonedDateTime.now(ZoneId.of("Europe/Moscow")).plusMinutes(30).withSecond(0).withNano(0);
		create(json.writeValueAsString(Map.of("title","Скоро встреча","kind","vibe","date",starts.toLocalDate().toString(),
				"time",starts.toLocalTime().toString(),"durationMinutes",60,"audienceMode","selected","selectedUserIds",List.of("u"),"expectedVersion",0)));
		assertThat(count("outbox_events")).isEqualTo(1);
		assertThat(jdbc.queryForObject("select event_type from outbox_events",String.class)).isEqualTo("meeting.created");
		assertThat(planner.materialize(20,"12345")).isEqualTo(1);
		assertThat(claims()).allSatisfy(l->assertThat(l.payload()).contains("Новая встреча").doesNotContain("Напоминание"));
	}
	@Test void cancellationBlocksPendingAndAlreadyClaimedReminders() throws Exception {
		create(); cancel(); due(); planner.materialize(20,"12345"); assertThat(count("notification_deliveries")).isZero();
		prepare(); create(); due(); planner.materialize(20,"12345"); var leases=claims(); cancel();
		for(var lease:leases)assertThat(queue.start(lease.id(),lease.token())).isFalse();
		assertThat(count("delivery_attempts")).isZero();
	}
	@Test void startedMeetingAndMissedGraceDoNotSendStaleReminder() throws Exception {
		for(var sql:List.of("update meetings set starts_at=clock_timestamp()-interval '1 minute'",
				"update outbox_events set available_at=clock_timestamp()-interval '16 minutes' where event_type='meeting.reminder'")) {
			prepare(); create(); due(); jdbc.execute(sql); planner.materialize(20,"12345");
			assertThat(count("notification_deliveries")).isZero();
			assertThat(jdbc.queryForObject("select state from meeting_notification_events",String.class)).isEqualTo("expired");
		}
		prepare(); create(); due(); planner.materialize(20,"12345"); var leases=claims();
		jdbc.update("update meetings set starts_at=clock_timestamp()-interval '1 second'");
		for(var lease:leases)assertThat(queue.start(lease.id(),lease.token())).isFalse();
		assertThat(count("delivery_attempts")).isZero();
	}
	@Test void recipientAndGroupSnapshotsCannotExpandOrRedirect() throws Exception {
		jdbc.update("insert into chat_bindings(id,bot_id,chat_id,type,important_thread_id) values ('g','12345',-1001,'important',777)");
		create(); due(); jdbc.update("insert into meeting_invitations(meeting_id,user_id) values (?,'v')",meeting);
		jdbc.update("update users set telegram_id=9999 where id='u'");
		jdbc.update("insert into chat_bindings(id,bot_id,chat_id,type,important_thread_id) values ('new','12345',-1002,'important',888)");
		planner.materialize(20,"12345"); var leases=claims(); assertThat(leases).hasSize(2);
		assertThat(leases).extracting(DeliveryQueue.Lease::chatId).containsExactlyInAnyOrder(2100L,-1001L);
		jdbc.update("update chat_bindings set important_thread_id=999 where id='g'");
		var group=leases.stream().filter(l->l.chatId()<0).findFirst().orElseThrow(); assertThat(queue.start(group.id(),group.token())).isFalse();
	}
	@Test void missingOrForgedAuditProvenanceFailsClosed() throws Exception {
		for(var sql:List.of("delete from audit_events","update outbox_events set payload=jsonb_set(payload,'{originAction}','\"cancelled\"') where event_type='meeting.reminder'")) {
			prepare(); create(); due(); jdbc.execute(sql); planner.materialize(20,"12345");
			assertThat(count("notification_deliveries")).isZero();
			assertThat(jdbc.queryForObject("select status from outbox_events where event_type='meeting.reminder'",String.class)).isEqualTo("failed");
		}
	}
	@Test void rollbackAndConcurrentWorkersDoNotConsumeOrDuplicateReminder() throws Exception {
		create(); due(); jdbc.execute("alter table notification_deliveries add constraint simulated_reminder_failure check (meeting_target_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize(20,"12345")).isInstanceOf(RuntimeException.class); }
		finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_reminder_failure"); }
		assertThat(count("meeting_notification_events")).isZero(); assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select status from outbox_events where event_type='meeting.reminder'",String.class)).isEqualTo("pending");
		var start=new CountDownLatch(1); try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return planner.materialize(20,"12345");});
			var b=pool.submit(()->{start.await();return planner.materialize(20,"12345");}); start.countDown();
			assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		} assertThat(count("notification_deliveries")).isEqualTo(2);
	}
	@Test void unknownIsNeverAutomaticallyReplayedAndRetryChecksMembership() throws Exception {
		create(); due(); planner.materialize(20,"12345"); var leases=claims(); var unknown=leases.getFirst();
		assertThat(queue.start(unknown.id(),unknown.token())).isTrue(); queue.finish(unknown.id(),unknown.token(),DeliveryQueue.Result.unknown("response_timeout"));
		var retry=leases.getLast(); assertThat(queue.start(retry.id(),retry.token())).isTrue();
		queue.finish(retry.id(),retry.token(),DeliveryQueue.Result.retry("telegram_429",Duration.ofSeconds(1)));
		jdbc.update("update notification_deliveries set available_at=clock_timestamp()-interval '1 second' where id=?",retry.id());
		jdbc.update("delete from meeting_invitations where user_id=?",retry.recipientId());
		assertThat(planner.materialize(20,"12345")).isZero(); var next=claims(); assertThat(next).hasSize(1);
		assertThat(queue.start(next.getFirst().id(),next.getFirst().token())).isFalse();
		assertThat(jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,unknown.id())).isEqualTo("unknown");
		assertThat(count("delivery_attempts")).isEqualTo(2);
	}
	@Test void existingDispatcherSendsReminderOutsideTransactionWithoutCalendarNetwork() throws Exception {
		create(); due(); var messages=new ArrayList<TelegramTransport.Message>();
		var sender=new BroadcastDispatcher(queue,quota,m->{
			assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
			messages.add(m); return TelegramTransport.Outcome.sent(88);
		},json,"12345",DeliveryQuota.Limits.defaults(),null,null,Clock.systemUTC(),planner);
		for(int n=0;n<4;n++) {
			jdbc.update("update delivery_rate_limits set next_at=clock_timestamp()-interval '1 second'");
			jdbc.update("update notification_deliveries set available_at=intended_at where status='planned'");
			sender.dispatchOne();
		}
		assertThat(messages).hasSize(2).allSatisfy(m->assertThat(m.text()).contains("Напоминание о встрече"));
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='sent'",Long.class)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select status from integration_jobs",String.class)).isEqualTo("pending");
	}
}
