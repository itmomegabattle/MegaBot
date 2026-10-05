package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.team.UserEntity;
import ru.itmomegabattle.megabot.team.UserRepository;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.JsonNode;

@Import(TestcontainersConfiguration.class)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
class BroadcastHttpIntegrationTests {
	@Autowired MockMvc mvc; @Autowired JdbcTemplate jdbc; @Autowired ObjectMapper json;
	@Autowired UserRepository users; @Autowired SessionService sessions; @Autowired DeliveryQueue queue;
	UserEntity author,recipient,other,admin,faculty;Cookie authorCookie,recipientCookie,otherCookie,adminCookie,facultyCookie;Instant now;
	@BeforeEach void prepare() {
		jdbc.execute("TRUNCATE TABLE users, faculties, competencies, broadcasts, notification_deliveries, idempotency_requests, audit_events, availability_weeks CASCADE");
		author=users.saveAndFlush(new UserEntity(801L,"broadcast_author","Автор","organizer"));recipient=users.saveAndFlush(new UserEntity(802L,"broadcast_recipient","Адресат","organizer"));
		other=users.saveAndFlush(new UserEntity(803L,"broadcast_other","Другой","organizer"));admin=users.saveAndFlush(new UserEntity(804L,"broadcast_admin","Админ","admin"));
		faculty=users.saveAndFlush(new UserEntity(805L,"broadcast_faculty","Факультет","faculty_helper"));
		authorCookie=cookie(author);recipientCookie=cookie(recipient);otherCookie=cookie(other);adminCookie=cookie(admin);facultyCookie=cookie(faculty);
		now=jdbc.queryForObject("select clock_timestamp()",java.sql.Timestamp.class).toInstant();
	}
	private Cookie cookie(UserEntity user) { return new Cookie("megabot_session",sessions.rotateFor(user.getId()).rawToken()); }
	private Map<String,Object> request() {
		var r=new java.util.LinkedHashMap<String,Object>();r.put("title","Объявление");r.put("body","Текст");r.put("recipientMode","people");
		r.put("recipientIds",List.of(recipient.getId()));r.put("scheduledAt",now.plusSeconds(120).toString());r.put("zoneId","Europe/Moscow");return r;
	}
	private org.springframework.test.web.servlet.ResultActions create(Map<String,?> body,Cookie actor,String key) throws Exception {
		return mvc.perform(post("/api/v1/broadcasts").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)));
	}
	private String createId(Map<String,?> body) throws Exception { return json.readTree(create(body,authorCookie,"broadcast-create").andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("id").asText(); }
	private org.springframework.test.web.servlet.ResultActions patch(String id,Map<String,?> body,Cookie actor,String key) throws Exception {
		return mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch("/api/v1/broadcasts/{id}",id).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)));
	}
	private org.springframework.test.web.servlet.ResultActions cancel(String id,int version,Cookie actor,String key) throws Exception {
		return mvc.perform(post("/api/v1/broadcasts/{id}/cancel",id).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("expectedVersion",version))));
	}
	private Map<String,Object> immediate() { var r=request();r.remove("scheduledAt");r.put("dispatchMode","now");return r; }
	private org.springframework.test.web.servlet.ResultActions reschedule(String id,long version,Instant due,Cookie actor,String key) throws Exception {
		return mvc.perform(post("/api/v1/broadcasts/{id}/reschedule",id).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key",key)
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("expectedVersion",version,"scheduledAt",due.toString()))));
	}
	@Test void timeOnlyTransferPreservesFrozenAudiencePartsSilentAndPolicy() throws Exception {
		var r=request();r.put("recipientMode","all");r.remove("recipientIds");r.put("body","я".repeat(8500));r.put("silent",true);r.put("misfirePolicy","skip");
		jdbc.update("update users set telegram_id=null where id=?",other.getId());
		var id=createId(r);
		var oldTargets=jdbc.queryForList("select target_key,recipient_id,chat_id,message_thread_id,bot_id,group_target_id,approval_version,part_count from broadcast_targets where broadcast_id=? order by target_key",id);
		users.saveAndFlush(new UserEntity(899L,"newcomer","Новый","organizer"));
		jdbc.update("update users set telegram_id=898 where id=?",other.getId());
		var due=now.plusSeconds(600);
		reschedule(id,0,due,authorCookie,"time-only").andExpect(status().isOk()).andExpect(jsonPath("$.version").value(1)).andExpect(jsonPath("$.contentRevision").value(2))
				.andExpect(jsonPath("$.recipientMode").value("all")).andExpect(jsonPath("$.misfirePolicy").value("skip")).andExpect(jsonPath("$.targetCount").value(oldTargets.size()));
		assertThat(jdbc.queryForList("select target_key,recipient_id,chat_id,message_thread_id,bot_id,group_target_id,approval_version,part_count from broadcast_targets where broadcast_id=? and revision=2 order by target_key",id)).isEqualTo(oldTargets);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=? and t.revision=2 and (not d.disable_notification or d.intended_at<>? or d.expires_at<>?)",Long.class,id,java.sql.Timestamp.from(due),java.sql.Timestamp.from(due.plusSeconds(5)))).isZero();
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=? and t.revision=1 and d.status<>'cancelled'",Long.class,id)).isZero();
		reschedule(id,0,due,authorCookie,"time-only").andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_id=? and action='rescheduled'",Long.class,id)).isEqualTo(1);
	}
	@Test void timeOnlyTransferInvalidatesClaimAndRejectsStaleForeignStartedExpiredAndInvalidTime() throws Exception {
		var id=createId(immediate());var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();
		reschedule(id,0,now.plusSeconds(600),otherCookie,"foreign-time").andExpect(status().isForbidden());
		reschedule(id,0,now.minusSeconds(1),authorCookie,"invalid-time").andExpect(status().isBadRequest());
		reschedule(id,0,now.plusSeconds(366L*86400),authorCookie,"far-time").andExpect(status().isBadRequest());
		reschedule(id,0,now.plusSeconds(600),authorCookie,"claimed-time").andExpect(status().isOk());
		assertThat(queue.start(lease.id(),lease.token())).isFalse();assertThat(queue.claimBroadcasts(1,Duration.ofSeconds(30))).isEmpty();
		reschedule(id,0,now.plusSeconds(900),authorCookie,"stale-time").andExpect(status().isConflict());
		jdbc.update("update broadcasts set scheduled_at=clock_timestamp()-interval '60 seconds',expires_at=clock_timestamp()-interval '1 second' where id=?",id);
		reschedule(id,1,now.plusSeconds(900),authorCookie,"expired-time").andExpect(status().isConflict());
	}
	@Test void timeOnlyTransferRacingStartCannotReissueStartedMessage() throws Exception {
		var id=createId(immediate());var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return reschedule(id,0,now.plusSeconds(600),authorCookie,"time-race").andReturn().getResponse().getStatus();});
			var b=pool.submit(()->{gate.await();return queue.start(lease.id(),lease.token());});gate.countDown();
			var transferred=a.get(10,java.util.concurrent.TimeUnit.SECONDS);var started=b.get(10,java.util.concurrent.TimeUnit.SECONDS);
			assertThat(transferred==200 && !started || transferred==409 && started).isTrue();
			assertThat(jdbc.queryForObject("select content_revision from broadcasts where id=?",Long.class,id)).isEqualTo(transferred==200?2L:1L);
		}
	}
	@Test void timeOnlyTransferRollsBackOldCancellationOnNewDeliveryFailure() throws Exception {
		var id=createId(request());jdbc.execute("alter table broadcast_targets add constraint simulated_transfer_failure check (revision=1) not valid");
		try { reschedule(id,0,now.plusSeconds(600),authorCookie,"failed-time").andExpect(status().isConflict()); }
		finally { jdbc.execute("alter table broadcast_targets drop constraint simulated_transfer_failure"); }
		assertThat(jdbc.queryForObject("select version from broadcasts where id=?",Long.class,id)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='planned'",Long.class)).isEqualTo(1);
	}

	@Test void sharedCreationLimitCountsBothRoutesAndReplayDoesNotSpendAgain() throws Exception {
		for(int i=0;i<10;i++) {
			if(i%2==0)create(request(),authorCookie,"shared-limit-"+i).andExpect(status().isCreated());
			else legacy(legacyRequest(),authorCookie,"shared-limit-"+i).andExpect(status().isAccepted());
		}
		create(request(),authorCookie,"shared-limit-0").andExpect(status().isCreated()).andExpect(header().string("Idempotency-Replayed","true"));
		legacy(legacyRequest(),authorCookie,"shared-limit-1").andExpect(status().isAccepted()).andExpect(header().string("Idempotency-Replayed","true"));
		create(request(),authorCookie,"shared-limit-over").andExpect(status().isTooManyRequests());legacy(legacyRequest(),authorCookie,"shared-legacy-over").andExpect(status().isTooManyRequests());
		assertThat(jdbc.queryForObject("select request_count from broadcast_creation_limits where author_id=?",Long.class,author.getId())).isEqualTo(10);
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Long.class)).isEqualTo(10);
		create(request(),adminCookie,"independent-author").andExpect(status().isCreated());
	}
	@Test void creationVolumeAndWindowResetAreDurableAndUnavailableDoesNotSpendVolume() throws Exception {
		create(request(),authorCookie,"quota-initial").andExpect(status().isCreated());
		jdbc.update("update broadcast_creation_limits set volume_count=500 where author_id=?",author.getId());
		create(request(),authorCookie,"quota-volume-over").andExpect(status().isTooManyRequests());
		jdbc.update("update users set telegram_id=null where id=?",recipient.getId());
		legacy(legacyRequest(),authorCookie,"quota-unavailable").andExpect(status().isAccepted()).andExpect(jsonPath("$.queued").value(0));
		assertThat(jdbc.queryForObject("select volume_count from broadcast_creation_limits where author_id=?",Long.class,author.getId())).isEqualTo(500);
		jdbc.update("update broadcast_creation_limits set request_count=10,request_started_at=clock_timestamp()-interval '11 minutes',volume_started_at=clock_timestamp()-interval '61 minutes' where author_id=?",author.getId());
		jdbc.update("update users set telegram_id=802 where id=?",recipient.getId());authorCookie=cookie(author);
		create(request(),authorCookie,"quota-reset").andExpect(status().isCreated());
		assertThat(jdbc.queryForObject("select request_count from broadcast_creation_limits where author_id=?",Long.class,author.getId())).isEqualTo(1);
		assertThat(jdbc.queryForObject("select volume_count from broadcast_creation_limits where author_id=?",Long.class,author.getId())).isEqualTo(1);
	}
	@Test void patchCannotBypassVolumeAndQuotaFailureKeepsOldRevisionAndLeases() throws Exception {
		var id=createId(request());jdbc.update("update broadcast_creation_limits set volume_count=500 where author_id=?",author.getId());
		var changed=request();changed.put("expectedVersion",0);changed.put("recipientIds",List.of(recipient.getId(),other.getId()));
		patch(id,changed,authorCookie,"quota-edit-denied").andExpect(status().isTooManyRequests());
		assertThat(jdbc.queryForObject("select content_revision from broadcasts where id=?",Long.class,id)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='planned'",Long.class)).isEqualTo(1);
		cancel(id,0,authorCookie,"quota-cancel").andExpect(status().isOk());
		assertThat(jdbc.queryForObject("select volume_count from broadcast_creation_limits where author_id=?",Long.class,author.getId())).isEqualTo(500);
	}
	@Test void creationQuotaRollbackAndConcurrentLastReservationAreAtomic() throws Exception {
		jdbc.execute("alter table notification_deliveries add constraint quota_delivery_failure check (category<>'broadcast') not valid");
		try { create(request(),authorCookie,"quota-rollback").andExpect(status().isConflict()); }finally { jdbc.execute("alter table notification_deliveries drop constraint quota_delivery_failure"); }
		assertThat(jdbc.queryForObject("select count(*) from broadcast_creation_limits",Long.class)).isZero();
		create(request(),authorCookie,"quota-seed").andExpect(status().isCreated());jdbc.update("update broadcast_creation_limits set request_count=9,volume_count=499 where author_id=?",author.getId());
		var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return create(request(),authorCookie,"quota-last-v1").andReturn().getResponse().getStatus();});
			var b=pool.submit(()->{gate.await();return legacy(legacyRequest(),authorCookie,"quota-last-legacy").andReturn().getResponse().getStatus();});gate.countDown();
			assertThat(List.of(a.get(),b.get())).contains(429).allMatch(code->code==201 || code==202 || code==429);assertThat(List.of(a.get(),b.get()).stream().filter(code->code==429).count()).isEqualTo(1);
		}
		assertThat(jdbc.queryForObject("select request_count from broadcast_creation_limits where author_id=?",Long.class,author.getId())).isEqualTo(10);
		assertThat(jdbc.queryForObject("select volume_count from broadcast_creation_limits where author_id=?",Long.class,author.getId())).isEqualTo(500);
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Long.class)).isEqualTo(2);
	}

	private org.springframework.test.web.servlet.ResultActions legacy(Map<String,?> body,Cookie actor,String key) throws Exception {
		return mvc.perform(post("/api/team/broadcast").cookie(actor).header("Origin","http://localhost").header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)));
	}
	private Map<String,Object> legacyRequest() { var r=request();r.remove("scheduledAt");r.put("requesterId",admin.getId());return r; }
	@Test void legacyBroadcastUsesSessionQueuesAndReplaysEvenAfterDelivery() throws Exception {
		var r=legacyRequest();var result=json.readTree(legacy(r,authorCookie,"legacy-broadcast").andExpect(status().isAccepted())
				.andExpect(jsonPath("$.delivered").value(0)).andExpect(jsonPath("$.queued").value(1)).andExpect(jsonPath("$.pending").value(1)).andReturn().getResponse().getContentAsString());
		var id=result.path("broadcastId").asText();assertThat(jdbc.queryForObject("select author_id from broadcasts where id=?",String.class,id)).isEqualTo(author.getId());
		var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(999));
		authorCookie=cookie(author);legacy(r,authorCookie,"legacy-broadcast").andExpect(status().isAccepted()).andExpect(header().string("Idempotency-Replayed","true"))
				.andExpect(jsonPath("$.broadcastId").value(id)).andExpect(jsonPath("$.delivered").value(0));
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Long.class)).isEqualTo(1);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isEqualTo(1);
		r.put("body","Changed");legacy(r,authorCookie,"legacy-broadcast").andExpect(status().isConflict());
	}
	@Test void legacyNamedBlocksUnionAndUnavailableUseSharedSnapshots() throws Exception {
		jdbc.update("insert into competencies(id,name,scope) values ('legacy_bc','Блок','core')");jdbc.update("insert into user_competencies(user_id,competency_id) values (?,'legacy_bc')",recipient.getId());
		jdbc.update("update users set telegram_id=null where id=?",other.getId());
		var r=legacyRequest();r.put("recipientMode","blocks");r.put("competencies",List.of("Блок","Блок"));r.put("recipientIds",List.of(other.getId()));
		legacy(r,authorCookie,"legacy-blocks").andExpect(status().isAccepted()).andExpect(jsonPath("$.recipients").value(2)).andExpect(jsonPath("$.queued").value(1)).andExpect(jsonPath("$.unavailable").value(1));
		users.saveAndFlush(new UserEntity(806L,"late_legacy","Поздний","organizer"));assertThat(jdbc.queryForObject("select count(*) from broadcast_targets",Long.class)).isEqualTo(2);
	}
	@Test void legacyMissingSlotsResolvesDatedWeekAndScheduledModeNeverStartsEarly() throws Exception {
		var today=now.atZone(ZoneId.of("Europe/Moscow")).toLocalDate();var next=today.minusDays(today.getDayOfWeek().getValue()-1).plusWeeks(1);
		jdbc.update("insert into availability_weeks(id,user_id,week_start,out_of_week) values ('legacy_week',?,?,true)",recipient.getId(),next);
		var r=legacyRequest();r.put("recipientMode","missing_slots");r.put("availabilityWeekIndex",1);r.put("dispatchMode","scheduled");r.put("scheduledAt",now.plusSeconds(120).toString());
		var result=json.readTree(legacy(r,authorCookie,"legacy-week").andExpect(status().isAccepted()).andExpect(jsonPath("$.recipients").value(3)).andReturn().getResponse().getContentAsString());
		assertThat(jdbc.queryForObject("select week_start from broadcasts where id=?",LocalDate.class,result.path("broadcastId").asText())).isEqualTo(next);
		assertThat(queue.claimBroadcasts(10,Duration.ofSeconds(30))).isEmpty();
		legacy(r,authorCookie,"legacy-week").andExpect(header().string("Idempotency-Replayed","true"));
	}
	@Test void legacyBroadcastValidationAuthAndAtomicFailureLeaveNoRows() throws Exception {
		var r=legacyRequest();legacy(r,facultyCookie,"legacy-faculty").andExpect(status().isForbidden());
		mvc.perform(post("/api/team/broadcast").header("Origin","http://localhost").header("Idempotency-Key","legacy-anonymous").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(r))).andExpect(status().isUnauthorized());
		mvc.perform(post("/api/team/broadcast").cookie(authorCookie).header("Origin","https://evil.example").header("Idempotency-Key","legacy-origin").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(r))).andExpect(status().isForbidden());
		for(var values:List.of(Map.of("competencies",List.of("unknown"),"recipientMode","blocks"),Map.of("recipientIds",List.of(faculty.getId())),Map.of("recipientMode","missing_slots","availabilityWeekIndex",51),Map.of("availabilityWeekIndex",-1),Map.of("body"," "),Map.of("scheduledAt",now.plusSeconds(120).toString()))) {
			var invalid=new java.util.LinkedHashMap<>(r);invalid.putAll(values);legacy(invalid,authorCookie,"legacy-invalid").andExpect(status().isBadRequest());
		}
		jdbc.execute("alter table notification_deliveries add constraint legacy_broadcast_failure check (category<>'broadcast') not valid");
		try { legacy(r,authorCookie,"legacy-rollback").andExpect(status().isConflict()); }finally { jdbc.execute("alter table notification_deliveries drop constraint legacy_broadcast_failure"); }
		for(var table:List.of("broadcasts","broadcast_targets","notification_deliveries","audit_events","idempotency_requests"))assertThat(jdbc.queryForObject("select count(*) from "+table,Long.class)).as(table).isZero();
	}
	@Test void concurrentLegacyReplaysCreateOneBroadcast() throws Exception {
		var r=legacyRequest();var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return json.readTree(legacy(r,authorCookie,"legacy-concurrent").andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString());});
			var b=pool.submit(()->{gate.await();return json.readTree(legacy(r,authorCookie,"legacy-concurrent").andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString());});gate.countDown();assertThat(a.get()).isEqualTo(b.get());
		}
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Long.class)).isEqualTo(1);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isEqualTo(1);
	}

	@Test void createPersistsSnapshotAndQueueAtomicallyReplaysAndSurvivesNewSession() throws Exception {
		var r=request();r.put("authorId",other.getId());r.put("recipientIds",List.of(recipient.getId(),recipient.getId()));var id=createId(r);
		create(r,authorCookie,"broadcast-create").andExpect(status().isCreated()).andExpect(header().string("Idempotency-Replayed","true")).andExpect(jsonPath("$.id").value(id));
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select author_id from broadcasts where id=?",String.class,id)).isEqualTo(author.getId());
		assertThat(jdbc.queryForObject("select count(*) from broadcast_targets",Long.class)).isEqualTo(1);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isEqualTo(1);
		assertThat(queue.claim(10,Duration.ofSeconds(30))).isEmpty();
		users.saveAndFlush(new UserEntity(806L,"new_member","Новый","organizer"));
		authorCookie=cookie(author);
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("scheduled"))
				.andExpect(jsonPath("$.targetCount").value(1)).andExpect(jsonPath("$.targets[0].recipientId").value(recipient.getId()));
		r.put("body","Изменение");create(r,authorCookie,"broadcast-create").andExpect(status().isConflict());
	}
	@Test void invalidTimeZoneAudienceAndTextLeaveNoPartialRecords() throws Exception {
		for(var values:List.of(Map.of("scheduledAt",now.minusSeconds(1).toString()),Map.of("scheduledAt",now.plusSeconds(10).toString()),
				Map.of("scheduledAt",now.plusSeconds(367L*86400).toString()),Map.of("zoneId","Asia/Vladivostok"),Map.of("recipientIds",List.of(faculty.getId())),
				Map.of("recipientIds",List.of()),Map.of("misfirePolicy","bogus"),Map.of("title","x".repeat(120),"body","x".repeat(40000)))) {
			var r=request();r.putAll(values);create(r,authorCookie,"invalid-"+values.hashCode()).andExpect(status().isBadRequest());
		}
		create(request(),facultyCookie,"faculty-create-denied").andExpect(status().isForbidden());
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Long.class)).isZero();assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isZero();
	}
	@Test void unavailableTargetsAreVisibleAndNeverFalselyMarkedSent() throws Exception {
		jdbc.update("update users set telegram_id=null where id=?",recipient.getId());var id=createId(request());
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(status().isOk()).andExpect(jsonPath("$.deliveryCounts.unavailable").value(1)).andExpect(jsonPath("$.status").value("failed"));
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isZero();
	}
	@Test void transferCancelsClaimedOldRevisionAndStaleVersionCannotOverwrite() throws Exception {
		var id=createId(immediate());var old=queue.claim(1,Duration.ofSeconds(30)).getFirst();var update=request();update.put("expectedVersion",0);update.put("recipientIds",List.of(other.getId()));
		patch(id,update,authorCookie,"broadcast-transfer").andExpect(status().isOk()).andExpect(jsonPath("$.version").value(1)).andExpect(jsonPath("$.contentRevision").value(2));
		assertThat(queue.start(old.id(),old.token())).isFalse();assertThat(jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,old.id())).isEqualTo("cancelled");
		patch(id,update,authorCookie,"broadcast-transfer").andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		patch(id,update,authorCookie,"broadcast-stale-transfer").andExpect(status().isConflict());
		assertThat(jdbc.queryForObject("select count(*) from broadcast_targets",Long.class)).isEqualTo(2);assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='planned'",Long.class)).isEqualTo(1);
	}
	@Test void cancellationDoesNotPretendToRecallInFlightAndStartedBroadcastCannotEdit() throws Exception {
		var r=immediate();r.put("recipientIds",List.of(recipient.getId(),other.getId()));var id=createId(r);var leases=queue.claim(2,Duration.ofSeconds(30));var started=leases.getFirst();
		assertThat(queue.start(started.id(),started.token())).isTrue();var update=request();update.put("expectedVersion",0);
		patch(id,update,authorCookie,"broadcast-started-edit").andExpect(status().isConflict());
		cancel(id,0,authorCookie,"broadcast-cancel").andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"));
		assertThat(queue.start(leases.getLast().id(),leases.getLast().token())).isFalse();
		assertThat(queue.finish(started.id(),started.token(),DeliveryQueue.Result.sent(500))).isTrue();
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(jsonPath("$.deliveryCounts.sent").value(1)).andExpect(jsonPath("$.deliveryCounts.cancelled").value(1));
		cancel(id,0,authorCookie,"broadcast-cancel").andExpect(status().isOk()).andExpect(header().string("Idempotency-Replayed","true"));
		cancel(id,0,authorCookie,"broadcast-stale-cancel").andExpect(status().isConflict());
	}
	@Test void authorAndAdminOnlyCanReadAndChangeAndListIsScoped() throws Exception {
		var id=createId(request());var update=request();update.put("expectedVersion",0);
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(otherCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/broadcasts").cookie(otherCookie)).andExpect(jsonPath("$.items.length()").value(0));
		patch(id,update,otherCookie,"broadcast-other-edit").andExpect(status().isForbidden());cancel(id,0,otherCookie,"broadcast-other-cancel").andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/broadcasts").cookie(facultyCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/broadcasts").cookie(adminCookie)).andExpect(jsonPath("$.items.length()").value(1));
		patch(id,update,adminCookie,"broadcast-admin-edit").andExpect(status().isOk());
	}
	@Test void materializationFailureRollsBackBroadcastTargetsAuditAndIdempotency() throws Exception {
		jdbc.execute("alter table notification_deliveries add constraint simulated_broadcast_failure check (category<>'broadcast') not valid");
		try { create(request(),authorCookie,"broadcast-atomic-failure").andExpect(status().isConflict()); }
		finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_broadcast_failure"); }
		for(var table:List.of("broadcasts","broadcast_targets","notification_deliveries","audit_events","idempotency_requests"))assertThat(jdbc.queryForObject("select count(*) from "+table,Long.class)).as(table).isZero();
	}
	@Test void startRacingTransferEitherRejectsEditOrRevokesOldLease() throws Exception {
		var id=createId(immediate());var lease=queue.claim(1,Duration.ofSeconds(30)).getFirst();var update=request();update.put("expectedVersion",0);var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var started=pool.submit(()->{gate.await();return queue.start(lease.id(),lease.token());});
			var edited=pool.submit(()->{gate.await();return patch(id,update,authorCookie,"broadcast-transfer-race").andReturn().getResponse().getStatus();});
			gate.countDown();var didStart=started.get();var result=edited.get();
			if(didStart)assertThat(result).isEqualTo(409);else assertThat(result).isEqualTo(200);
		}
	}
	@Test void dispatcherGateExcludesDeactivatedChangedBindingAndAlreadySubmittedWithoutAddingNewPeople() throws Exception {
		var r=immediate();r.put("recipientMode","missing_slots");r.remove("recipientIds");var today=LocalDate.now(ZoneId.of("Europe/Moscow"));var monday=today.minusDays(today.getDayOfWeek().getValue()-1);r.put("weekStart",monday.toString());
		var id=createId(r);var leases=queue.claim(10,Duration.ofSeconds(30));
		jdbc.update("insert into availability_weeks(id,user_id,week_start,out_of_week) values ('submitted',?,?,true)",recipient.getId(),monday);
		jdbc.update("update users set active=false,deactivated_at=now() where id=?",other.getId());
		jdbc.update("update users set telegram_id=9999 where id=?",admin.getId());
		for(var lease:leases)if(!lease.recipientId().equals(author.getId()))assertThat(queue.start(lease.id(),lease.token())).isFalse();
		users.saveAndFlush(new UserEntity(806L,"later_member","Поздний","organizer"));
		assertThat(jdbc.queryForObject("select count(*) from broadcast_targets where broadcast_id=?",Long.class,id)).isEqualTo(4);
	}
	@Test void audienceModesAndAggregateStatusDoNotMarkAllSentOnFirstSuccess() throws Exception {
		jdbc.update("insert into competencies(id,name,scope) values ('bc_comp','Компетенция','core')");jdbc.update("insert into user_competencies(user_id,competency_id) values (?,'bc_comp')",recipient.getId());
		var r=immediate();r.put("recipientMode","blocks");r.put("competencyIds",List.of("bc_comp"));r.put("recipientIds",List.of(other.getId()));var id=createId(r);
		var leases=queue.claim(10,Duration.ofSeconds(30));assertThat(leases).hasSize(2);var first=leases.getFirst();assertThat(queue.start(first.id(),first.token())).isTrue();assertThat(queue.finish(first.id(),first.token(),DeliveryQueue.Result.sent(501))).isTrue();
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(jsonPath("$.status").value("partial"));
		var last=leases.getLast();assertThat(queue.start(last.id(),last.token())).isTrue();assertThat(queue.finish(last.id(),last.token(),DeliveryQueue.Result.sent(502))).isTrue();
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(jsonPath("$.status").value("sent"));
	}
	@Test void allModePaginationAndSilentSnapshotAreStable() throws Exception {
		var r=request();r.put("recipientMode","all");r.remove("recipientIds");r.put("silent",true);createId(r);
		create(r,authorCookie,"broadcast-second-create").andExpect(status().isCreated()).andExpect(jsonPath("$.targetCount").value(4));
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where disable_notification",Long.class)).isEqualTo(8);
		var page=json.readTree(mvc.perform(get("/api/v1/broadcasts").param("limit","1").cookie(authorCookie)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
		var next=json.readTree(mvc.perform(get("/api/v1/broadcasts").param("limit","1").param("cursor",page.path("nextCursor").asText()).cookie(authorCookie)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
		assertThat(next.path("items").get(0).path("id").asText()).isNotEqualTo(page.path("items").get(0).path("id").asText());
		assertThat(next.path("nextCursor").isNull()).isTrue();
		mvc.perform(get("/api/v1/broadcasts").param("limit","0").cookie(authorCookie)).andExpect(status().isBadRequest());
	}
	@Test void deactivatedAuthorCannotStartFrozenBroadcast() throws Exception {
		createId(immediate());var lease=queue.claim(1,Duration.ofSeconds(30)).getFirst();
		jdbc.update("update users set active=false,deactivated_at=now() where id=?",author.getId());
		assertThat(queue.start(lease.id(),lease.token())).isFalse();
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Long.class)).isZero();
		assertThat(jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,lease.id())).isEqualTo("cancelled");
	}
	private String unknown(String id) {
		var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		assertThat(queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.unknown("response_timeout"))).isTrue();return lease.id();
	}
	private org.springframework.test.web.servlet.ResultActions retry(String id,String delivery,Map<String,?> body,Cookie actor,String key) throws Exception {
		return mvc.perform(post("/api/v1/broadcasts/{id}/deliveries/{delivery}/retry",id,delivery).cookie(actor).header("Origin","http://localhost").header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)));
	}
	@Test void unknownRetryIsLinkedIdempotentAndAggregateCountsOneRecipient() throws Exception {
		var id=createId(immediate());var original=unknown(id);var body=Map.of("expectedVersion",0,"acknowledgeDuplicateRisk",true);
		var response=json.readTree(retry(id,original,body,authorCookie,"manual-retry").andExpect(status().isCreated()).andExpect(jsonPath("$.duplicateRiskWarning").isNotEmpty()).andReturn().getResponse().getContentAsString());
		var child=response.path("id").asText();assertThat(response.path("retryOf").asText()).isEqualTo(original);
		retry(id,original,body,authorCookie,"manual-retry").andExpect(status().isCreated()).andExpect(header().string("Idempotency-Replayed","true")).andExpect(jsonPath("$.id").value(child));
		retry(id,original,Map.of("expectedVersion",1,"acknowledgeDuplicateRisk",true),authorCookie,"manual-another-key").andExpect(status().isConflict());
		assertThat(jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,original)).isEqualTo("unknown");
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isEqualTo(2);
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(jsonPath("$.targetCount").value(1)).andExpect(jsonPath("$.deliveryCounts.planned").value(1));
		var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();assertThat(lease.id()).isEqualTo(child);assertThat(queue.start(child,lease.token())).isTrue();queue.finish(child,lease.token(),DeliveryQueue.Result.sent(700));
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(jsonPath("$.status").value("sent")).andExpect(jsonPath("$.deliveryCounts.sent").value(1));
		mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).cookie(authorCookie)).andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(2)).andExpect(jsonPath("$.version").value(1));
	}
	@Test void journalIsScopedPagedAndDoesNotExposeInternalPayloadTokensOrDescriptions() throws Exception {
		var id=createId(immediate());var original=unknown(id);jdbc.update("update notification_deliveries set last_error_code='secret-token/path' where id=?",original);
		jdbc.update("update delivery_attempts set error_summary='private provider secret',provider_code='secret/path' where delivery_id=?",original);
		var body=mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).cookie(authorCookie)).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].errorCode").value("provider_error"))
				.andExpect(jsonPath("$.items[0].attempts[0].status").value("unknown")).andReturn().getResponse().getContentAsString();
		assertThat(body).doesNotContain("secret-token","private provider","lease_token","leaseToken","payload","chatId","error_summary");
		mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).cookie(otherCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).cookie(facultyCookie)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).cookie(adminCookie)).andExpect(status().isOk());
		retry(id,original,Map.of("expectedVersion",0,"acknowledgeDuplicateRisk",true),authorCookie,"journal-retry").andExpect(status().isCreated());
		var page=json.readTree(mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).param("limit","1").cookie(authorCookie)).andReturn().getResponse().getContentAsString());
		mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).param("limit","1").param("cursor",page.path("nextCursor").asText()).cookie(authorCookie)).andExpect(jsonPath("$.items.length()").value(1)).andExpect(jsonPath("$.nextCursor").isEmpty());
		mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).param("cursor","other-delivery").cookie(authorCookie)).andExpect(status().isBadRequest());
		mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).param("limit","101").cookie(authorCookie)).andExpect(status().isBadRequest());
	}
	@Test void testRecipientRefusalRemainsVisibleInBothJournalAndAttemptWithoutRawErrors() throws Exception {
		var id=createId(immediate());var original=unknown(id);
		jdbc.update("update notification_deliveries set status='failed',last_error_code='test_recipient_not_allowed' where id=?",original);
		jdbc.update("update delivery_attempts set result_status='failed',provider_code='test_recipient_not_allowed',error_summary='secret provider details' where delivery_id=?",original);
		var body=mvc.perform(get("/api/v1/broadcasts/{id}/deliveries",id).cookie(authorCookie)).andExpect(status().isOk())
				.andExpect(jsonPath("$.items[0].status").value("failed"))
				.andExpect(jsonPath("$.items[0].errorCode").value("test_recipient_not_allowed"))
				.andExpect(jsonPath("$.items[0].attempts[0].code").value("test_recipient_not_allowed"))
				.andReturn().getResponse().getContentAsString();
		assertThat(body).doesNotContain("secret provider details","error_summary","chatId","payload");
	}
	@Test void retryRequiresAcknowledgementCurrentVersionAndOwnerAndRejectsCancelledOrExpired() throws Exception {
		var id=createId(immediate());var original=unknown(id);
		for(var body:List.of(Map.of("expectedVersion",0),Map.of("expectedVersion",0,"acknowledgeDuplicateRisk",false),Map.of("acknowledgeDuplicateRisk",true)))
			retry(id,original,body,authorCookie,"invalid-retry").andExpect(status().isBadRequest());
		var body=Map.of("expectedVersion",0,"acknowledgeDuplicateRisk",true);
		retry(id,original,body,otherCookie,"foreign-retry").andExpect(status().isForbidden());
		retry(id,original,Map.of("expectedVersion",9,"acknowledgeDuplicateRisk",true),authorCookie,"stale-retry").andExpect(status().isConflict());
		jdbc.update("update notification_deliveries set expires_at=intended_at where id=?",original);
		retry(id,original,body,authorCookie,"expired-retry").andExpect(status().isConflict());
		cancel(id,0,authorCookie,"cancel-before-retry").andExpect(status().isOk());
		retry(id,original,Map.of("expectedVersion",1,"acknowledgeDuplicateRisk",true),authorCookie,"cancelled-retry").andExpect(status().isConflict());
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isEqualTo(1);
	}
	@Test void manualRetryNeverDuplicatesSuccessfulRecipientsAndUnavailableRecipientIsRejected() throws Exception {
		var r=immediate();r.put("recipientIds",List.of(recipient.getId(),other.getId()));var id=createId(r);var leases=queue.claimBroadcasts(2,Duration.ofSeconds(30));
		var sent=leases.getFirst();var uncertain=leases.getLast();queue.start(sent.id(),sent.token());queue.finish(sent.id(),sent.token(),DeliveryQueue.Result.sent(801));
		queue.start(uncertain.id(),uncertain.token());queue.finish(uncertain.id(),uncertain.token(),DeliveryQueue.Result.unknown("lost"));var body=Map.of("expectedVersion",0,"acknowledgeDuplicateRisk",true);
		retry(id,sent.id(),body,authorCookie,"sent-retry-denied").andExpect(status().isConflict());
		jdbc.update("update users set telegram_id=999999 where id=?",uncertain.recipientId());
		retry(id,uncertain.id(),body,authorCookie,"binding-retry-denied").andExpect(status().isConflict());
		jdbc.update("update users set telegram_id=? where id=?",uncertain.chatId(),uncertain.recipientId());
		retry(id,uncertain.id(),body,adminCookie,"admin-manual-retry").andExpect(status().isCreated());
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(jsonPath("$.targetCount").value(2)).andExpect(jsonPath("$.deliveryCounts.sent").value(1)).andExpect(jsonPath("$.deliveryCounts.planned").value(1));
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where recipient_id=?",Long.class,sent.recipientId())).isEqualTo(1);
	}
	@Test void concurrentManualRetriesCreateOneChildAndFailureRollsBackEverything() throws Exception {
		var id=createId(immediate());var original=unknown(id);var body=Map.of("expectedVersion",0,"acknowledgeDuplicateRisk",true);
		jdbc.execute("alter table notification_deliveries add constraint simulated_retry_failure check (retry_of is null) not valid");
		try { retry(id,original,body,authorCookie,"retry-rollback").andExpect(status().isConflict()); }
		finally { jdbc.execute("alter table notification_deliveries drop constraint simulated_retry_failure"); }
		assertThat(jdbc.queryForObject("select version from broadcasts where id=?",Long.class,id)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Long.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from audit_events where action='manual_retry_requested'",Long.class)).isZero();
		var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return retry(id,original,body,authorCookie,"race-retry-one").andReturn().getResponse().getStatus();});
			var b=pool.submit(()->{gate.await();return retry(id,original,body,adminCookie,"race-retry-two").andReturn().getResponse().getStatus();});gate.countDown();
			assertThat(List.of(a.get(),b.get())).containsExactlyInAnyOrder(201,409);
		}
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where retry_of=?",Long.class,original)).isEqualTo(1);
	}
	@Test void repeatedUnknownCreatesAnAuditableChainAndLostAdminCannotReplayForeignRetry() throws Exception {
		var id=createId(immediate());var original=unknown(id);var body=Map.of("expectedVersion",0,"acknowledgeDuplicateRisk",true);
		retry(id,original,body,adminCookie,"admin-retry-chain").andExpect(status().isCreated());
		jdbc.update("update users set role='organizer' where id=?",admin.getId());
		retry(id,original,body,adminCookie,"admin-retry-chain").andExpect(status().isForbidden());
		var child=unknown(id);
		retry(id,child,Map.of("expectedVersion",1,"acknowledgeDuplicateRisk",true),authorCookie,"second-unknown-retry").andExpect(status().isCreated());
		mvc.perform(get("/api/v1/broadcasts/{id}",id).cookie(authorCookie)).andExpect(jsonPath("$.targetCount").value(1)).andExpect(jsonPath("$.deliveryCounts.planned").value(1));
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='unknown'",Long.class)).isEqualTo(2);
		cancel(id,2,authorCookie,"cancel-retry-chain").andExpect(status().isOk());assertThat(queue.claimBroadcasts(10,Duration.ofSeconds(30))).isEmpty();
	}
	@Test void cancelRacingManualRetryCannotLeaveAQueuedChildOnCancelledBroadcast() throws Exception {
		var id=createId(immediate());var original=unknown(id);var gate=new CountDownLatch(1);
		try(var pool=Executors.newFixedThreadPool(2)) {
			var a=pool.submit(()->{gate.await();return retry(id,original,Map.of("expectedVersion",0,"acknowledgeDuplicateRisk",true),authorCookie,"cancel-race-retry").andReturn().getResponse().getStatus();});
			var b=pool.submit(()->{gate.await();return cancel(id,0,adminCookie,"retry-race-cancel").andReturn().getResponse().getStatus();});gate.countDown();
			var retried=a.get(10,java.util.concurrent.TimeUnit.SECONDS);var cancelled=b.get(10,java.util.concurrent.TimeUnit.SECONDS);
			if(retried==201) { assertThat(cancelled).isEqualTo(409);cancel(id,1,authorCookie,"cancel-after-retry-race").andExpect(status().isOk()); }
			else { assertThat(retried).isEqualTo(409);assertThat(cancelled).isEqualTo(200); }
		}
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status in ('planned','claimed','retry','sending')",Long.class)).isZero();
	}
}
