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
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner;
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class) @SpringBootTest(properties="megabot.meetings.reminder-minutes=0") @AutoConfigureMockMvc
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class MeetingNotificationIntegrationTests {
	@Autowired JdbcTemplate jdbc;@Autowired MockMvc mvc;@Autowired SessionService sessions;@Autowired ObjectMapper json;
	@Autowired MeetingNotificationPlanner planner;@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;
	Cookie host;String meeting;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,meetings,chat_bindings,outbox_events,integration_jobs,idempotency_requests,audit_events,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('h',2100,'host','Организатор','organizer',true),('u',2101,'user','Участник','organizer',true),('v',2102,'next','Новый','organizer',true),('f',2103,'faculty','Факультет','faculty_helper',true)");
		host=new Cookie("megabot_session",sessions.rotateFor("h").rawToken());
	}
	String body(String title,List<String> people,long version,String kind) {
		var date=LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.next(DayOfWeek.MONDAY));
		var body=new LinkedHashMap<String,Object>();body.put("title",title);body.put("kind",kind);body.put("date",date.toString());body.put("time","18:00");
		body.put("durationMinutes",60);body.put("audienceMode","selected");body.put("selectedUserIds",people);body.put("expectedVersion",version);body.put("description","PRIVATE_DESCRIPTION");
		if(kind.equals("setup"))body.put("eventId","event");return json.writeValueAsString(body);
	}
	void create() throws Exception { create("meeting"); }
	void create(String kind) throws Exception {
		var result=mvc.perform(post("/api/v1/meetings").cookie(host).header("Origin","http://localhost").header("Idempotency-Key","meeting-create-001")
				.contentType(MediaType.APPLICATION_JSON).content(body("Планирование",List.of("u"),0,kind))).andExpect(status().isCreated()).andReturn();
		meeting=json.readTree(result.getResponse().getContentAsString()).path("id").asText();
	}
	void update() throws Exception {
		mvc.perform(patch("/api/v1/meetings/{id}",meeting).cookie(host).header("Origin","http://localhost").header("Idempotency-Key","meeting-update-001")
				.contentType(MediaType.APPLICATION_JSON).content(body("Перенесена",List.of("v"),0,"meeting"))).andExpect(status().isOk());
	}
	void cancel(long version) throws Exception {
		mvc.perform(post("/api/v1/meetings/{id}/cancel",meeting).cookie(host).header("Origin","http://localhost").header("Idempotency-Key","meeting-cancel-001")
				.contentType(MediaType.APPLICATION_JSON).content("{\"expectedVersion\":"+version+"}")).andExpect(status().isOk());
	}
	long count(String table) { return jdbc.queryForObject("select count(*) from "+table,Long.class); }
	void group() { jdbc.update("insert into chat_bindings(id,bot_id,chat_id,type,important_thread_id) values ('group','12345',-1001,'important',777)"); }
	BroadcastDispatcher sender(TelegramTransport transport) { return new BroadcastDispatcher(queue,quota,transport,json,"12345",DeliveryQuota.Limits.defaults(),null,null,Clock.systemUTC(),planner); }
	@Test void httpSnapshotReplayMaterializationAndSendingAreSeparateAndGroupIsFirst() throws Exception {
		group();create();
		mvc.perform(post("/api/v1/meetings").cookie(host).header("Origin","http://localhost").header("Idempotency-Key","meeting-create-001")
				.contentType(MediaType.APPLICATION_JSON).content(body("Планирование",List.of("u"),0,"meeting"))).andExpect(header().string("Idempotency-Replayed","true"));
		assertThat(planner.materialize(20,"12345")).isEqualTo(1);assertThat(planner.materialize(20,"12345")).isZero();assertThat(count("notification_deliveries")).isEqualTo(3);
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("completed");assertThat(count("delivery_attempts")).isZero();
		var messages=new ArrayList<TelegramTransport.Message>();var sender=sender(m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();messages.add(m);return TelegramTransport.Outcome.sent(77);});
		assertThat(sender.dispatchOne()).isTrue();assertThat(messages.getFirst().chatId()).isEqualTo(-1001);assertThat(messages.getFirst().threadId()).isEqualTo(777L);
		for(int n=0;n<5;n++) { // Simulate quota time passing in the isolated DB, no sleep or production rate override.
			jdbc.update("update delivery_rate_limits set next_at=now()-interval '1 second'");jdbc.update("update notification_deliveries set available_at=intended_at where status='planned'");sender.dispatchOne();
		}assertThat(messages).hasSize(3);assertThat(messages).allSatisfy(m->{assertThat(m.silent()).isFalse();assertThat(m.text()).contains("Новая встреча","МСК").doesNotContain("PRIVATE_DESCRIPTION");});
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='sent'",Long.class)).isEqualTo(3);
	}
	@Test void updateCancelsOldSnapshotAndRemovedRecipientGetsNoNewMeetingDetails() throws Exception {
		create();planner.materialize(20,"12345");var old=queue.claimSupported(2,Duration.ofSeconds(30));update();
		for(var lease:old)assertThat(queue.start(lease.id(),lease.token())).isFalse();assertThat(count("delivery_attempts")).isZero();
		planner.materialize(20,"12345");var leases=queue.claimSupported(10,Duration.ofSeconds(30));assertThat(leases).hasSize(3);
		var removed=leases.stream().filter(l->l.recipientId().equals("u")).findFirst().orElseThrow();
		assertThat(removed.payload()).contains("больше не приглашены").doesNotContain("Перенесена","PRIVATE_DESCRIPTION","18:00");assertThat(queue.start(removed.id(),removed.token())).isTrue();
		queue.finish(removed.id(),removed.token(),DeliveryQueue.Result.sent(90));
	}
	@Test void cancellationSupersedesUnmaterializedCreateAndCanSendWhileMeetingIsCancelled() throws Exception {
		create();cancel(0);assertThat(planner.materialize(20,"12345")).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from meeting_notification_events where state='cancelled'",Long.class)).isEqualTo(1);
		assertThat(count("notification_deliveries")).isEqualTo(2);var leases=queue.claimSupported(10,Duration.ofSeconds(30));
		for(var lease:leases) { assertThat(lease.payload()).contains("Встреча отменена");assertThat(queue.start(lease.id(),lease.token())).isTrue();queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(99)); }
	}
	@Test void membershipBindingRoleActorAndSourceRevocationsCancelBeforeHttp() throws Exception {
		for(var change:List.of("delete from meeting_invitations where user_id='u'","update users set telegram_id=2201 where id='u'","update users set role='faculty_helper' where id='u'","update users set active=false,deactivated_at=now() where id='h'","update meetings set version=version+1","update outbox_events set status='cancelled'","update meeting_notification_events set state='cancelled'")) {
			prepare();create();planner.materialize(20,"12345");var lease=queue.claimSupported(10,Duration.ofSeconds(30)).stream().filter(l->l.recipientId().equals("u")).findFirst().orElseThrow();jdbc.execute(change);
			assertThat(queue.start(lease.id(),lease.token())).as(change).isFalse();assertThat(count("delivery_attempts")).isZero();
		}
	}
	@Test void frozenTelegramAudienceAndGroupAllowlistCannotExpandOrRedirect() throws Exception {
		group();create();jdbc.update("insert into meeting_invitations(meeting_id,user_id) values (?,'v')",meeting);jdbc.update("update users set telegram_id=9000 where id='u'");
		jdbc.update("insert into chat_bindings(id,bot_id,chat_id,type,important_thread_id) values ('later','12345',-1002,'important',888)");
		planner.materialize(20,"12345");assertThat(count("notification_deliveries")).isEqualTo(2);
		assertThat(jdbc.queryForObject("select unavailable_count from meeting_notification_events",Integer.class)).isEqualTo(1);
		var group=queue.claimSupported(10,Duration.ofSeconds(30)).stream().filter(l->l.chatId()<0).findFirst().orElseThrow();
		jdbc.update("update chat_bindings set important_thread_id=999 where id='group'");assertThat(queue.start(group.id(),group.token())).isFalse();
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where chat_id in (9000,2102,-1002)",Long.class)).isZero();
	}
	@Test void unavailableWrongBotExpiredFutureAndMalformedSourcesFailClosed() throws Exception {
		group();create();jdbc.update("update users set telegram_id=null");planner.materialize(20,"99999");assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select state from meeting_notification_events",String.class)).isEqualTo("unavailable");
		prepare();create();jdbc.update("update outbox_events set available_at=now()-interval '16 minutes'");planner.materialize(20,"12345");assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select state from meeting_notification_events",String.class)).isEqualTo("expired");
		prepare();create();jdbc.update("update outbox_events set available_at=now()+interval '1 hour'");assertThat(planner.materialize(20,"12345")).isZero();
		prepare();create();jdbc.update("update outbox_events set payload=payload-'recipientSnapshot'");planner.materialize(20,"12345");assertThat(count("notification_deliveries")).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
	}
	@Test void atomicRollbackAndTwoMaterializersDoNotConsumeOrDuplicateSource() throws Exception {
		create();jdbc.execute("alter table notification_deliveries add constraint simulated_meeting_link_failure check (meeting_target_id is null) not valid");
		try { assertThatThrownBy(()->planner.materialize(20,"12345")).isInstanceOf(RuntimeException.class); }
		finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_meeting_link_failure"); }
		assertThat(count("meeting_notification_events")).isZero();assertThat(count("meeting_notification_targets")).isZero();assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");
		var start=new CountDownLatch(1);try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{start.await();return planner.materialize(20,"12345");});var b=pool.submit(()->{start.await();return planner.materialize(20,"12345");});start.countDown();
			assertThat(a.get(10,TimeUnit.SECONDS)+b.get(10,TimeUnit.SECONDS)).isEqualTo(1);
		}assertThat(count("notification_deliveries")).isEqualTo(2);
	}
	@Test void unknownIsNotReplayedAndGroupRetryStillRequiresAllowlist() throws Exception {
		group();create();planner.materialize(20,"12345");
		assertThat(queue.claimSupported(10,Duration.ofSeconds(30),"99999")).allSatisfy(l->assertThat(l.chatId()).isPositive());
		var group=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(group.id(),group.token())).isTrue();
		queue.finish(group.id(),group.token(),DeliveryQueue.Result.unknown("response_timeout"));assertThat(planner.materialize(20,"12345")).isZero();
		assertThat(queue.claimSupported(10,Duration.ofSeconds(30))).allSatisfy(l->assertThat(l.id()).isNotEqualTo(group.id()));
		prepare();group();create();planner.materialize(20,"12345");var retry=queue.claimSupported(1,Duration.ofSeconds(30)).getFirst();queue.start(retry.id(),retry.token());queue.finish(retry.id(),retry.token(),DeliveryQueue.Result.retry("telegram_429",Duration.ofSeconds(1)));
		jdbc.update("update notification_deliveries set available_at=now()-interval '1 second' where id=?",retry.id());jdbc.update("delete from chat_bindings");
		var lease=queue.claimSupported(10,Duration.ofSeconds(30)).stream().filter(l->l.id().equals(retry.id())).findFirst().orElseThrow();assertThat(queue.start(lease.id(),lease.token())).isFalse();
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts where delivery_id=?",Long.class,retry.id())).isEqualTo(1);
	}
	@Test void missingAuditAndFinishedMeetingDoNotSendAndOtherOutboxIsUntouched() throws Exception {
		create();jdbc.update("delete from audit_events");planner.materialize(20,"12345");assertThat(count("notification_deliveries")).isZero();assertThat(jdbc.queryForObject("select last_error_code from outbox_events",String.class)).isEqualTo("meeting_actor_not_verified");
		prepare();create();jdbc.update("update meetings set starts_at=now()-interval '2 hours'");planner.materialize(20,"12345");assertThat(count("notification_deliveries")).isZero();
		prepare();create();jdbc.update("update outbox_events set event_type='meeting.rsvp'");assertThat(planner.materialize(20,"12345")).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");
	}
	@Test void allThreeMeetingKindsUseSameQueueWithoutCalendarNetwork() throws Exception {
		for(var kind:List.of("meeting","setup","vibe")) {
			prepare();jdbc.update("insert into work_events(id,name,status) values ('event','Мероприятие','active') on conflict do nothing");create(kind);
			planner.materialize(20,"12345");assertThat(count("notification_deliveries")).isGreaterThanOrEqualTo(2);assertThat(count("integration_jobs")).isEqualTo(1);
			assertThat(jdbc.queryForObject("select status from integration_jobs",String.class)).isEqualTo("pending");
		}
	}
}
