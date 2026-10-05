package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.time.*;
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
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.auth.*;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class) @SpringBootTest @AutoConfigureMockMvc
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class BroadcastGroupIntegrationTests {
	@Autowired JdbcTemplate jdbc; @Autowired MockMvc mvc; @Autowired ObjectMapper json; @Autowired SessionService sessions;
	@Autowired BroadcastGroupTargets groups; @Autowired BroadcastService broadcasts; @Autowired DeliveryQueue queue;
	@Autowired DeliveryQuota quota; @Autowired DeliveryJournalService journal;
	Cookie admin,organizer,faculty; AuthenticatedUser actor=new AuthenticatedUser("o","organizer","Организатор","organizer");
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,broadcasts,broadcast_group_targets,notification_deliveries,delivery_rate_limits,idempotency_requests,audit_events cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',4300,'admin','Админ','admin',true),('o',4301,'organizer','Организатор','organizer',true),('f',4302,'faculty','Факультет','faculty_helper',true)");
		admin=cookie("a");organizer=cookie("o");faculty=cookie("f");
	}
	Cookie cookie(String id) { return new Cookie("megabot_session",sessions.rotateFor(id).rawToken()); }
	Map<String,Object> target(Long thread) {
		var r=new LinkedHashMap<String,Object>();r.put("label","Тестовая группа");r.put("botId","12345");r.put("chatId",-100123L);r.put("messageThreadId",thread);r.put("active",true);return r;
	}
	org.springframework.test.web.servlet.ResultActions createTarget(Map<String,Object> r,Cookie cookie,String key) throws Exception {
		return mvc.perform(post("/api/v1/admin/broadcast-group-targets").cookie(cookie).header("Origin","http://localhost").header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(r)));
	}
	String approve(Long thread) throws Exception { return json.readTree(createTarget(target(thread),admin,"approve-"+thread).andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("id").asText(); }
	Map<String,Object> request(List<String> ids) { return new LinkedHashMap<>(Map.of("title","Объявление","body","Текст","recipientMode","groups","groupTargetIds",ids,"dispatchMode","now","silent",true)); }
	org.springframework.test.web.servlet.ResultActions create(Map<String,Object> r,String key) throws Exception {
		return mvc.perform(post("/api/v1/broadcasts").cookie(organizer).header("Origin","http://localhost").header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(r)));
	}
	String broadcast(List<String> ids) throws Exception { return json.readTree(create(request(ids),"create-group").andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("id").asText(); }
	void edit(String id,boolean active,long version,Long thread) {
		groups.save(id,new BroadcastGroupTargetsController.Mutation("Тестовая группа","12345",-100123L,thread,active,version),new AuthenticatedUser("a","admin","Админ","admin"));
	}
	BroadcastDispatcher worker(String bot,TelegramTransport transport) { return new BroadcastDispatcher(queue,quota,transport,json,bot,new DeliveryQuota.Limits(1000,1000,60000)); }
	@Test void onlyAdminApprovesAndOrganizerSeesOnlySafeActiveLabels() throws Exception {
		createTarget(target(7L),organizer,"deny-organizer").andExpect(status().isForbidden());createTarget(target(7L),faculty,"deny-faculty").andExpect(status().isForbidden());
		var id=approve(7L);createTarget(target(7L),admin,"approve-7").andExpect(status().isCreated()).andExpect(header().string("Idempotency-Replayed","true"));
		var body=mvc.perform(get("/api/v1/broadcast-group-targets").cookie(organizer)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
		assertThat(body).contains(id,"Тестовая группа").doesNotContain("chatId","botId","-100123","messageThreadId","approved_by");
		mvc.perform(get("/api/v1/admin/broadcast-group-targets").cookie(organizer)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/broadcast-group-targets").cookie(faculty)).andExpect(status().isForbidden());
		edit(id,false,0,7L);assertThat(groups.list(false,50,null).get("items")).asList().isEmpty();
		assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_type='broadcast_group_target'",Integer.class)).isEqualTo(2);
	}
	@Test void validationOriginVersionAndDuplicateAddressFailClosed() throws Exception {
		for(var change:List.of(Map.<String,Object>of("chatId",123),Map.<String,Object>of("messageThreadId",0),Map.<String,Object>of("botId","main"),Map.<String,Object>of("label"," "))) {
			var r=target(7L);r.putAll(change);createTarget(r,admin,"invalid-"+change.keySet().iterator().next()).andExpect(status().isBadRequest());
		}
		mvc.perform(post("/api/v1/admin/broadcast-group-targets").cookie(admin).header("Idempotency-Key","no-origin").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(target(7L)))).andExpect(status().isForbidden());
		var id=approve(null);createTarget(target(null),admin,"duplicate-address").andExpect(status().isConflict());
		var update=target(null);update.put("active",false);update.put("expectedVersion",0);
		mvc.perform(patch("/api/v1/admin/broadcast-group-targets/{id}",id).cookie(admin).header("Origin","http://localhost").header("Idempotency-Key","disable-group").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(update))).andExpect(status().isOk());
		assertThatThrownBy(()->edit(id,true,0,null)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
	}
	@Test void approvedWholeGroupAndTopicUseSharedSenderPreserveSilentAndFrozenAudience() throws Exception {
		var whole=approve(null);var topic=approve(7L);var id=broadcast(List.of(whole,topic,topic));approve(9L);
		assertThat(broadcasts.get(id,actor).get("targetCount")).isEqualTo(2);
		var seen=new ArrayList<Long>();var worker=worker("12345",m->{assertThat(m.chatId()).isEqualTo(-100123);assertThat(m.silent()).isTrue();seen.add(m.threadId());return TelegramTransport.Outcome.sent(99);});
		for(int i=0;i<10;i++)worker.dispatchOne();assertThat(seen).containsExactlyInAnyOrder(null,7L);
		assertThat(broadcasts.get(id,actor).get("status")).isEqualTo("sent");
		assertThat(json.writeValueAsString(broadcasts.get(id,actor).get("targets"))).contains("groupTargetId").doesNotContain("chatId","-100123","botId");
	}
	@Test void timeOnlyTransferKeepsWholeTopicBotSilentAndOriginalApproval() throws Exception {
		var whole=approve(null);var topic=approve(7L);var id=broadcast(List.of(whole,topic));
		var before=jdbc.queryForList("select target_key,chat_id,message_thread_id,bot_id,group_target_id,approval_version from broadcast_targets where broadcast_id=? order by target_key",id);
		edit(topic,false,0,7L);edit(topic,true,1,9L);approve(11L);
		var due=Instant.now().plusSeconds(600);
		broadcasts.reschedule(id,new BroadcastController.Reschedule(0L,due),actor);
		assertThat(jdbc.queryForList("select target_key,chat_id,message_thread_id,bot_id,group_target_id,approval_version from broadcast_targets where broadcast_id=? and revision=2 order by target_key",id)).isEqualTo(before);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=? and t.revision=2 and not d.disable_notification",Long.class,id)).isZero();
		jdbc.update("update notification_deliveries set intended_at=clock_timestamp(),available_at=clock_timestamp() where broadcast_target_id in(select id from broadcast_targets where broadcast_id=? and revision=2)",id);
		var seen=new ArrayList<Long>();var worker=worker("12345",m->{seen.add(m.threadId());return TelegramTransport.Outcome.sent(99);});
		for(int i=0;i<5;i++)worker.dispatchOne();
		assertThat(seen).containsExactly((Long)null); // Reapproval does not authorize the frozen topic snapshot.
	}
	@Test void arbitraryUnknownInactiveAndMixedAudienceCannotQueueAnything() throws Exception {
		var id=approve(7L);edit(id,false,0,7L);
		for(var ids:List.of(List.of(id),List.of("arbitrary"),List.<String>of()))create(request(ids),"deny-"+ids.hashCode()).andExpect(status().isBadRequest());
		edit(id,true,1,7L);var mixed=request(List.of(id));mixed.put("recipientIds",List.of("o"));create(mixed,"mixed-targets").andExpect(status().isBadRequest());
		var personal=request(List.of(id));personal.put("recipientMode","all");create(personal,"wrong-mode").andExpect(status().isBadRequest());
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Integer.class)).isZero();
	}
	@Test void onlyMatchingBotClaimsAndUnknownBotlessClaimCannotSendGroup() throws Exception {
		var target=approve(7L);broadcast(List.of(target));assertThat(queue.claimBroadcasts(1,Duration.ofSeconds(30))).isEmpty();
		assertThat(worker("99999",m->{throw new AssertionError("wrong bot");}).dispatchOne()).isFalse();
		assertThat(worker("12345",m->TelegramTransport.Outcome.sent(100)).dispatchOne()).isTrue();
	}
	@Test void revocationReapprovalRetargetAndPayloadTargetTamperCancelOldClaim() throws Exception {
		for(int variant=0;variant<4;variant++) {
			prepare();var target=approve(7L);broadcast(List.of(target));var lease=queue.claimSupported(1,Duration.ofSeconds(30),"12345").getFirst();
			if(variant==0)edit(target,false,0,7L);
			if(variant==1) { edit(target,false,0,7L);edit(target,true,1,7L); }
			if(variant==2)edit(target,true,0,8L);
			if(variant==3)jdbc.update("update notification_deliveries set message_thread_id=999 where id=?",lease.id());
			assertThat(queue.start(lease.id(),lease.token())).isFalse();assertThat(jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,lease.id())).isEqualTo("cancelled");
			assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		}
	}
	@Test void unknownManualRetryPreservesTopicAndRequiresStillApprovedSnapshot() throws Exception {
		var target=approve(7L);var id=broadcast(List.of(target));worker("12345",m->TelegramTransport.Outcome.unknown("response_timeout")).dispatchOne();
		var delivery=jdbc.queryForObject("select id from notification_deliveries where category='broadcast'",String.class);
		assertThat(json.writeValueAsString(journal.list(id,actor,50,null))).contains("groupTargetId").doesNotContain("chatId","botId","-100123");
		var child=journal.retry(id,delivery,new DeliveryJournalController.Retry(0L,true),actor);
		jdbc.execute("truncate delivery_rate_limits");assertThat(worker("12345",m->{assertThat(m.threadId()).isEqualTo(7);return TelegramTransport.Outcome.unknown("response_timeout");}).dispatchOne()).isTrue();
		edit(target,false,0,7L);assertThatThrownBy(()->journal.retry(id,(String)child.get("id"),new DeliveryJournalController.Retry(1L,true),actor)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
		assertThat(broadcasts.get(id,actor).get("targetCount")).isEqualTo(1);
	}
	@Test void concurrentSameKeyCreationFreezesOneGroupDeliveryAndCancellationStopsClaim() throws Exception {
		var target=approve(7L);var gate=new CountDownLatch(1);var responses=new ArrayList<String>();
		try(var pool=Executors.newFixedThreadPool(2)) {
			Callable<String> command=()->{gate.await();return create(request(List.of(target)),"same-group-key").andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();};
			var a=pool.submit(command);var b=pool.submit(command);gate.countDown();responses.add(a.get(10,TimeUnit.SECONDS));responses.add(b.get(10,TimeUnit.SECONDS));
		}
		assertThat(json.readTree(responses.get(0))).isEqualTo(json.readTree(responses.get(1)));assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isEqualTo(1);
		var id=json.readTree(responses.getFirst()).path("id").asText();var lease=queue.claimSupported(1,Duration.ofSeconds(30),"12345").getFirst();broadcasts.cancel(id,0L,actor);
		assertThat(queue.start(lease.id(),lease.token())).isFalse();
	}
	@Test void scheduledGroupDoesNotSendEarlyAndRescheduleRevokesOldClaimedRevision() throws Exception {
		var target=approve(7L);var now=jdbc.queryForObject("select clock_timestamp()",java.sql.Timestamp.class).toInstant();
		var request=request(List.of(target));request.put("dispatchMode","scheduled");request.put("scheduledAt",now.plusSeconds(120).toString());
		var id=json.readTree(create(request,"future-group").andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("id").asText();
		assertThat(worker("12345",m->{throw new AssertionError("early group send");}).dispatchOne()).isFalse();
		jdbc.update("update notification_deliveries set intended_at=clock_timestamp()-interval '1 second',available_at=clock_timestamp()-interval '1 second'");
		var old=queue.claimSupported(1,Duration.ofSeconds(30),"12345").getFirst();
		broadcasts.update(id,new BroadcastController.Mutation("Перенос","Текст","groups",null,null,null,"scheduled",now.plusSeconds(180),"Europe/Moscow","send_late",true,0L,List.of(target)),actor);
		assertThat(queue.start(old.id(),old.token())).isFalse();assertThat(worker("12345",m->{throw new AssertionError("old revision");}).dispatchOne()).isFalse();
	}
	@Test void failedMultiTargetSnapshotRollsBackBroadcastQuotaAndIdempotency() throws Exception {
		var target=approve(7L);create(request(List.of(target,"not-approved")),"partial-invalid").andExpect(status().isBadRequest());
		assertThat(jdbc.queryForObject("select count(*) from broadcasts",Integer.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries",Integer.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from broadcast_creation_limits",Integer.class)).isZero();
		assertThat(jdbc.queryForObject("select count(*) from idempotency_requests where operation='broadcast.create'",Integer.class)).isZero();
	}
}
