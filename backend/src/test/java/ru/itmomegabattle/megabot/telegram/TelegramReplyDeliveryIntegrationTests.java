package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.notifications.*;
import ru.itmomegabattle.megabot.availability.TelegramSlotDraftService;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest @Import(TestcontainersConfiguration.class) @ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TelegramReplyDeliveryIntegrationTests {
	@Autowired TelegramInbox inbox;@Autowired TelegramCommandWorker commands;@Autowired TelegramReplyPlanner planner;
	@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
	@Autowired TelegramSlotDraftService slots;
	@Autowired ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService meetingDrafts;
	@BeforeEach void clear() {
		jdbc.execute("truncate telegram_inbox,outbox_events,bot_messages,chat_bindings,users,competencies,delivery_rate_limits,app_settings,audit_events,integration_jobs cascade");
	}
	void member(String role) { jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('member',42,'alice','Участник',?,true)",role); }
	void start() { command("/start"); }
	void command(String text) {
		inbox.accept("123",json.writeValueAsBytes(Map.of("update_id",1,"message",Map.of("message_id",2,"date",Instant.now().getEpochSecond(),
				"chat",Map.of("id",42,"type","private"),"from",Map.of("id",42,"is_bot",false,"first_name","Тест","username","alice"),"text",text))));
		assertThat(commands.processOne("123")).isTrue();
	}
	BroadcastDispatcher sender(TelegramTransport transport,String bot) {
		return new BroadcastDispatcher(queue,quota,transport,json,bot,new DeliveryQuota.Limits(20,1,20),null,null,Clock.systemUTC(),null,null,null,null,planner);
	}
	int count(String table) { return jdbc.queryForObject("select count(*) from "+table,Integer.class); }
	String status() { return jdbc.queryForObject("select status from notification_deliveries",String.class); }
	void due() { jdbc.update("update notification_deliveries set available_at=clock_timestamp()-interval '1 second'");jdbc.execute("truncate delivery_rate_limits"); }
	String slotDraft() { return jdbc.queryForObject("select payload->>'slotDraftId' from outbox_events",String.class); }
	@Test void meetingsRootUsesSharedLifecycleAndTeamVisibilityWithBoundedPlainText() {
		member("organizer");
		jdbc.execute("""
				insert into meetings(id,kind,title,starts_at,duration_minutes,zone_id,host_id,audience_mode,status,topic)
				select 'future_'||n,'meeting','Будущая '||n,now()+n*interval '1 day',60,'Europe/Moscow','member','selected','scheduled',repeat('Т',500)
				from generate_series(1,10) n
				""");
		jdbc.execute("""
				insert into meetings(id,kind,title,starts_at,duration_minutes,zone_id,host_id,audience_mode,status)
				values ('ongoing','vibe','Уже идёт',now()-interval '10 minutes',60,'Europe/Moscow','member','selected','scheduled'),
				('past','meeting','Прошедшая',now()-interval '2 hours',60,'Europe/Moscow','member','all','scheduled'),
				('cancelled','meeting','Отменённая',now()+interval '1 hour',60,'Europe/Moscow','member','all','cancelled')
				""");
		// No invitations: core read visibility is wider than the RSVP authorization boundary.
		command("  ВСТРЕЧИ \n");var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
		var reply=captured.get();assertThat(reply.text()).startsWith("Ближайшие встречи\n\n1. Уже идёт")
				.contains("8. Будущая 7","Т".repeat(250)+"…")
				.doesNotContain("Будущая 8","Прошедшая","Отменённая","Т".repeat(251)).hasSizeLessThan(4001);
		var date=jdbc.queryForObject("select to_char(starts_at at time zone 'Europe/Moscow','DD.MM.YYYY, HH24:MI') from meetings where id='ongoing'",String.class);
		assertThat(reply.text()).contains(date);assertThat(reply.keyboard().rows()).containsExactly(java.util.List.of("Назначить собрание"),java.util.List.of("Меню","Назад"));
		assertThat(count("meeting_invitations")).isZero();assertThat(count("bot_messages")).isEqualTo(2);
		assertThat(sender(m->{throw new AssertionError("duplicate_meetings_reply");},"123").dispatchOne()).isFalse();
	}
	@Test void meetingsEmptyRootAndFacultyOrUnknownHaveNoCoreContent() {
		for(var role:java.util.List.of("admin","organizer","faculty_helper","faculty_responsible","unknown")) {
			clear();if(!role.equals("unknown"))member(role);command("Встречи");var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
			if(role.startsWith("faculty_")) {
				assertThat(captured.get().text()).isEqualTo("Встречи доступны только организаторам и администратору.");
				assertThat(captured.get().keyboard().rows()).containsExactly(java.util.List.of("Мои задачи","Помощь"));
			}else if(role.equals("unknown"))assertThat(captured.get().text()).startsWith("Вас нет в списке участников.");
			else assertThat(captured.get().text()).isEqualTo("Встречи\n\nБлижайших встреч нет.");
		}
		for(var input:java.util.List.of("Встречи ещё","/meetings","Встречи@bot","Назначить собрание ещё"))assertThat(TelegramPrivateCommandHandler.command(input)).isNull();
	}
	@Test void meetingsNavigationClosesSlotEditorWithoutSavingAndBackReturnsToProfile() {
		member("admin");slots.openPanel("123",42);command("Встречи");
		assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("cancelled");
		assertThat(count("availability_weeks")).isZero();assertThat(count("outbox_events")).isEqualTo(1);
		clear();member("admin");command("Назад");var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().text()).startsWith("Участник\n");
	}
	String meetingDraft() { return jdbc.queryForObject("select id from telegram_meeting_drafts where status='open'",String.class); }
    void replyToCurrentOffer(tools.jackson.databind.node.ObjectNode update) {
        var ids=jdbc.queryForList("""
                select q.telegram_message_id from notification_deliveries q join telegram_meeting_drafts s
                  on s.id=q.payload->>'meetingDraftId' and s.revision::text=q.payload->>'meetingRevision'
                where s.status='open' and q.status='sent' and q.telegram_message_id>0
                  and s.panel->>'text'=q.payload->>'text' and s.panel->'markup'=q.payload->'replyMarkup'
                limit 1
                """,Long.class);
        if(!ids.isEmpty())((tools.jackson.databind.node.ObjectNode)update.path("message")).set("reply_to_message",json.valueToTree(Map.of(
                "message_id",ids.getFirst(),"date",Instant.now().getEpochSecond(),"chat",Map.of("id",42,"type","private"),
                "from",Map.of("id",123,"is_bot",true,"first_name","MegaBot"))));
    }
    tools.jackson.databind.node.ObjectNode meetingInput(long update,String text) {
        var value=(tools.jackson.databind.node.ObjectNode)json.valueToTree(Map.of("update_id",update,"message",Map.of("message_id",update+1,"date",Instant.now().getEpochSecond(),
                "chat",Map.of("id",42,"type","private"),"from",Map.of("id",42,"is_bot",false,"first_name","Тест","username","alice"),"text",text)));
        replyToCurrentOffer(value);return value;
    }
    void nextCommand(long update,String text) {
        inbox.accept("123",json.writeValueAsBytes(meetingInput(update,text)));
        assertThat(commands.processOne("123")).isTrue();
    }

	@Test void meetingCreationEntryUsesPersistedCanonicalPromptAndConfirmedPrivateSendOnly() {
		member("organizer");slots.openPanel("123",42);command("  НАЗНАЧИТЬ СОБРАНИЕ \n");var draft=meetingDraft();
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,0)).isFalse();
		assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("cancelled");
		assertThat(sender(m->{throw new AssertionError("wrong_bot");},"456").dispatchOne()).isFalse();
		var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().text()).isEqualTo("Кого приглашаем?");
		assertThat(captured.get().keyboard().forceReply()).isTrue();
		assertThat(captured.get().keyboard().rows()).containsExactly(java.util.List.of("Собрать всю команду","Выбрать блок"),java.util.List.of("Меню","Назад"));
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,0)).isTrue();
		assertThat(meetingDrafts.confirmedPanel("456",42,draft,0)).isFalse();
		assertThat(meetingDrafts.confirmedPanel("123",43,draft,0)).isFalse();
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,1)).isFalse();
		assertThat(count("meetings")).isZero();assertThat(count("availability_weeks")).isZero();
		assertThat(count("bot_messages")).isEqualTo(2);
	}
	@Test void unknownMeetingPromptNeverBecomesConfirmedOrAutomaticallyReplays() {
		member("admin");command("Назначить собрание");var draft=meetingDraft();
		assertThat(sender(m->TelegramTransport.Outcome.unknown("test_unknown"),"123").dispatchOne()).isTrue();
		assertThat(status()).isEqualTo("unknown");assertThat(meetingDrafts.confirmedPanel("123",42,draft,0)).isFalse();
		assertThat(sender(m->{throw new AssertionError("unknown_replayed");},"123").dispatchOne()).isFalse();
		assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test void meetingPromptRechecksCanonicalRevisionOwnerAndDeadlineBeforeAndAfterStart() {
		for(var change:java.util.List.of("update users set version=version+1","update users set role='faculty_helper'",
				"delete from chat_bindings","update telegram_meeting_drafts set revision=revision+1",
				"update telegram_meeting_drafts set panel=jsonb_set(panel,'{text}','\"forged\"'::jsonb)",
				"update telegram_meeting_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 minute'")) {
			for(var afterStart:java.util.List.of(false,true)) {
				clear();member("organizer");command("Назначить собрание");planner.materialize(20,"123");
				if(afterStart) {
					var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
					jdbc.execute(change);assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
				}else {
					jdbc.execute(change);assertThat(sender(m->{throw new AssertionError("stale_meeting_prompt");},"123").dispatchOne()).isTrue();
				}
				assertThat(status()).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
			}
		}
	}
	@Test void meetingPromptReplacedOrMutatedBeforeMaterializationDoesNotSend() {
		for(var transition:java.util.List.of("replace","choose","navigation")) {
			clear();member("admin");command("Назначить собрание");var draft=meetingDraft();
			if(transition.equals("replace"))meetingDrafts.beginPanel("123",42);
			else if(transition.equals("choose"))meetingDrafts.chooseAudience("123",42,draft,0,"all");
			else meetingDrafts.leaveDialog("123",42,"member");
			assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
			assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("cancelled");
			assertThat(meetingDrafts.confirmedPanel("123",42,draft,0)).isFalse();
		}
	}
	@Test void meetingEntryOutboxFailureRollsBackDraftAndSlotNavigationThenRetriesOnce() {
		member("organizer");slots.openPanel("123",42);
		jdbc.execute("alter table outbox_events add constraint fixture_reject_meeting_begin check(payload->>'command'<>'meeting_begin')");
		try {
			command("Назначить собрание");assertThat(count("telegram_meeting_drafts")).isZero();assertThat(count("outbox_events")).isZero();
			assertThat(count("bot_messages")).isZero();assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("open");
		}finally {jdbc.execute("alter table outbox_events drop constraint fixture_reject_meeting_begin");}
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second'");assertThat(commands.processOne("123")).isTrue();
		assertThat(count("telegram_meeting_drafts")).isEqualTo(1);assertThat(count("outbox_events")).isEqualTo(1);
		assertThat(sender(m->TelegramTransport.Outcome.sent(11),"123").dispatchOne()).isTrue();
		assertThat(meetingDrafts.confirmedPanel("123",42,meetingDraft(),0)).isTrue();
	}
	@Test void meetingEntryFacultyAndUnknownRefuseWithoutDraftAndNavigationClosesOnlyOwnDialog() {
		for(var role:java.util.List.of("faculty_helper","faculty_responsible","unknown")) {
			clear();if(!role.equals("unknown"))member(role);command("Назначить собрание");var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
			assertThat(captured.get().text()).startsWith(role.equals("unknown")?"Вас нет в списке":"Встречи доступны только");
			assertThat(count("telegram_meeting_drafts")).isZero();
		}
		clear();member("admin");command("Назначить собрание");var own=meetingDraft();
		jdbc.execute("insert into chat_bindings(id,bot_id,chat_id,type) values ('otherbot','456',42,'private')");
		var other=meetingDrafts.beginPanel("456",42);
		nextCommand(2,"Меню");
		assertThat(jdbc.queryForObject("select status from telegram_meeting_drafts where id=?",String.class,own)).isEqualTo("cancelled");
		assertThat(meetingDrafts.load("456",42,other.draftId()).step()).isEqualTo("choose_type");
	}
	@Test void confirmedMeetingPromptRejectsForgedParentPayloadAndPrivateSource() {
		for(var change:java.util.List.of("update notification_deliveries set telegram_message_id=null",
				"update notification_deliveries set payload=jsonb_set(payload,'{text}','\"forged\"'::jsonb)",
				"update telegram_inbox set payload=jsonb_set(payload,'{message,from,id}','43'::jsonb)",
				"update telegram_inbox set payload=jsonb_set(payload,'{message,chat,type}','\"group\"'::jsonb)",
				"update telegram_inbox set payload=jsonb_set(payload,'{message,forward_origin}','{}'::jsonb)",
				"update telegram_inbox set payload=jsonb_set(payload,'{message,text}','\"unrelated\"'::jsonb)")) {
			clear();member("organizer");command("Назначить собрание");var draft=meetingDraft();
			assertThat(sender(m->TelegramTransport.Outcome.sent(11),"123").dispatchOne()).isTrue();
			assertThat(meetingDrafts.confirmedPanel("123",42,draft,0)).isTrue();jdbc.execute(change);
			assertThat(meetingDrafts.confirmedPanel("123",42,draft,0)).isFalse();
		}
	}
    @Test void unconfirmedBackFromMeetingEntryRefusesWithoutAbandoningPrompt() {
        member("organizer");command("Назначить собрание");var draft=meetingDraft();
        nextCommand(2,"Назад");
        assertThat(meetingDrafts.load("123",42,draft).revision()).isZero();
        assertThat(jdbc.queryForObject("select o.payload->>'text' from outbox_events o join telegram_inbox i on i.id=o.aggregate_id where i.update_id=2",String.class))
                .isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
        assertThat(sendMeetingReply(11).text()).isEqualTo("Кого приглашаем?");
        assertThat(meetingDrafts.confirmedPanel("123",42,draft,0)).isTrue();assertThat(count("meetings")).isZero();
    }
    @Test void confirmedEntryBackPublishesCanonicalCancelledRootAndNewDialogRejectsItsOldReply() {
        member("organizer");command("Назначить собрание");var draft=meetingDraft();sendMeetingReply(11);
        var delayed=meetingInput(4,"Назад");nextCommand(2,"Назад");
        assertThat(jdbc.queryForObject("select status from telegram_meeting_drafts where id=?",String.class,draft)).isEqualTo("cancelled");
        assertThat(jdbc.queryForObject("select panel->>'offerId' from telegram_meeting_drafts where id=?",String.class,draft)).isNotBlank();
        var root=sendMeetingReply(12);assertThat(root.text()).isEqualTo("Встречи\n\nБлижайших встреч нет.");
        assertThat(root.keyboard().forceReply()).isFalse();assertThat(meetingDrafts.confirmedPanel("123",42,draft,1)).isFalse();
        nextCommand(3,"Назначить собрание");sendMeetingReply(13);var current=meetingDraft();
        assertThat(jdbc.queryForObject("select panel is null from telegram_meeting_drafts where id=?",Boolean.class,draft)).isTrue();
        inbox.accept("123",json.writeValueAsBytes(delayed));assertThat(commands.processOne("123")).isTrue();
        assertThat(meetingDrafts.load("123",42,current).revision()).isZero();
        assertThat(sendMeetingReply(14).text()).isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
        for(var navigation:java.util.List.of("Меню","Назначить собрание")) {
            clear();member("organizer");command("Назначить собрание");sendMeetingReply(11);var old=meetingDraft();
            nextCommand(2,"Назад");nextCommand(3,navigation);planner.materialize(20,"123");
            assertThat(jdbc.queryForObject("select panel is null from telegram_meeting_drafts where id=?",Boolean.class,old)).isTrue();
            assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'command'='back'",String.class)).isEqualTo("cancelled");
            assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where payload->>'command'='back'",Integer.class)).isZero();
        }
    }
    @Test void staleMissingForeignOrUnknownBackNeverMovesCurrentField() {
        for(var kind:java.util.List.of("missing","stale","foreign","unknown")) {
            clear();prepareTopic();nextCommand(3,"Topic");sendMeetingReply(13);var draft=meetingDraft();
            var before=jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class);
            var input=meetingInput(4,"Назад");var message=(tools.jackson.databind.node.ObjectNode)input.path("message");
            var reply=(tools.jackson.databind.node.ObjectNode)message.path("reply_to_message");
            switch(kind) {
                case "missing"->message.remove("reply_to_message");
                case "stale"->reply.put("message_id",12);
                case "foreign"->((tools.jackson.databind.node.ObjectNode)reply.path("from")).put("id",456);
                case "unknown"->jdbc.execute("update notification_deliveries set status='unknown' where telegram_message_id=13");
            }
            inbox.accept("123",json.writeValueAsBytes(input));assertThat(commands.processOne("123")).isTrue();
            assertThat(jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class)).as(kind).isEqualTo(before);
            assertThat(sendMeetingReply(14).text()).isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
            assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("description");
        }
    }
    @Test void oneConfirmedBackAdvancesOnceAndRepeatedOldReferenceCannotAdvanceAgain() {
        prepareTopic();nextCommand(3,"Topic");sendMeetingReply(13);var draft=meetingDraft();
        var repeated=meetingInput(5,"Назад");nextCommand(4,"Назад");assertThat(sendMeetingReply(14).text()).contains("тему");
        var before=jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class);
        inbox.accept("123",json.writeValueAsBytes(repeated));assertThat(commands.processOne("123")).isTrue();
        assertThat(jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class)).isEqualTo(before);
        assertThat(sendMeetingReply(15).text()).isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
        assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(3);
        nextCommand(6,"Назад");assertThat(sendMeetingReply(16).text()).isEqualTo("Кого приглашаем?");
    }
    @Test void entryBackOutboxFailureRollsBackCancellationAndSourceMetadataThenRetriesOnce() {
        member("organizer");command("Назначить собрание");sendMeetingReply(11);var draft=meetingDraft();
        var before=jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class);
        jdbc.execute("alter table outbox_events add constraint fixture_reject_meeting_back check(payload->>'command'<>'back')");
        try {nextCommand(2,"Назад");assertThat(jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class)).isEqualTo(before);}
        finally {jdbc.execute("alter table outbox_events drop constraint fixture_reject_meeting_back");}
        jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=2");
        assertThat(commands.processOne("123")).isTrue();assertThat(sendMeetingReply(12).text()).startsWith("Встречи");
        assertThat(jdbc.queryForObject("select revision from telegram_meeting_drafts where id=?",Long.class,draft)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from outbox_events where payload->>'command'='back'",Integer.class)).isEqualTo(1);
        assertThat(count("meetings")).isZero();
    }
    @Test void boundBackRechecksReferenceAndExactAliasBeforePlannerAndAfterStart() {
        for(var change:java.util.List.of("reference","text","cancelled_question"))for(boolean afterStart:java.util.List.of(false,true)) {
            clear();prepareTopic();nextCommand(3,"Назад");
            ru.itmomegabattle.megabot.notifications.DeliveryQueue.Lease lease=null;
            if(afterStart){planner.materialize(20,"123");lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();}
            if(change.equals("reference"))jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,reply_to_message,message_id}','11'::jsonb) where update_id=3");
            else if(change.equals("text"))jdbc.update("update telegram_inbox set payload=jsonb_set(payload,'{message,text}',cast(? as jsonb)) where update_id=3",json.writeValueAsString("Меню"));
            else jdbc.execute("update telegram_meeting_drafts set status='cancelled'");
            if(afterStart)assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
            else {planner.materialize(20,"123");assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'command'='back'",String.class)).isIn("cancelled","failed");}
            assertThat(count("meetings")).isZero();
        }
    }
	TelegramTransport.Message sendMeetingReply(long provider) {
		var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();captured.set(m);return TelegramTransport.Outcome.sent(provider);},"123").dispatchOne()).isTrue();
		due();return captured.get();
	}
	@Test void confirmedAudienceChoiceAdvancesSameDraftAndBackOffersAnotherChoice() {
		member("organizer");command("Назначить собрание");var draft=meetingDraft();sendMeetingReply(11);
		nextCommand(2,"  СОБРАТЬ ВСЮ КОМАНДУ \n");
		assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("topic");
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,1)).isFalse();
		assertThat(sendMeetingReply(12).text()).isEqualTo("Напиши тему собрания одним сообщением.");
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,1)).isTrue();
		nextCommand(3,"Назад");assertThat(sendMeetingReply(13).text()).isEqualTo("Кого приглашаем?");
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,2)).isTrue();
		nextCommand(4,"Выбрать блок");assertThat(sendMeetingReply(14).text()).contains("Пока нет ни одного блока");
		assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("pick_competency");
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,3)).isTrue();
		assertThat(count("telegram_meeting_drafts")).isEqualTo(1);assertThat(count("meetings")).isZero();
	}
	@Test void blockPromptUsesFrozenOpaqueCatalogOptionsAndReturnsToAudience() {
		member("admin");jdbc.execute("insert into competencies(id,name,scope,active) values ('core','Core','core',true),('case','core','core',true),('faculty','Faculty','faculty',true),('inactive','Inactive','core',false)");
		command("Назначить собрание");sendMeetingReply(11);var draft=meetingDraft();nextCommand(2,"Выбрать блок");
		var prompt=sendMeetingReply(12);assertThat(prompt.text()).isEqualTo("Выбери блок.");
		assertThat(prompt.keyboard().rows().getFirst()).hasSize(2).allSatisfy(label->assertThat(label).doesNotContain("Faculty","Inactive"));
		var options=json.readTree(jdbc.queryForObject("select panel->'options' from telegram_meeting_drafts where id=?",String.class,draft));
		assertThat(options.size()).isEqualTo(2);
		assertThat(java.util.List.of(options.path(prompt.keyboard().rows().getFirst().get(0)).asText(),options.path(prompt.keyboard().rows().getFirst().get(1)).asText()))
				.containsExactlyInAnyOrder("core","case");
		jdbc.execute("update competencies set name='Renamed' where id='core'");
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,1)).isTrue();
		nextCommand(3,"Назад");assertThat(sendMeetingReply(13).text()).isEqualTo("Кого приглашаем?");
		assertThat(meetingDrafts.load("123",42,draft).payload().size()).isZero();
	}
	@Test void unboundOrUnconfirmedAudienceInputRefusesWithoutChangingDraft() {
		for(var context:java.util.List.of("none","pending","unknown","expired")) {
			clear();member("organizer");String draft=null;
			if(!context.equals("none")) {
				command("Назначить собрание");draft=meetingDraft();
				if(context.equals("unknown")) {assertThat(sender(m->TelegramTransport.Outcome.unknown("test_unknown"),"123").dispatchOne()).isTrue();due();}
				if(context.equals("expired")) {sendMeetingReply(11);jdbc.execute("update telegram_meeting_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 minute'");}
			}
			nextCommand(2,"Собрать всю команду");planner.materialize(20,"123");
			var refusal=jdbc.queryForObject("select payload->>'text' from outbox_events where payload->>'command'='meeting_audience'",String.class);
			assertThat(refusal).isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
			if(draft!=null)assertThat(jdbc.queryForObject("select revision from telegram_meeting_drafts where id=?",Long.class,draft)).isZero();
			else assertThat(count("telegram_meeting_drafts")).isZero();
			assertThat(count("meetings")).isZero();
			// Pending entry may precede the fixed refusal; drain only known local responses.
			while(sender(m->TelegramTransport.Outcome.sent(12),"123").dispatchOne())due();
			assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=2",String.class)).isEqualTo("completed");
		}
	}
	@Test void audienceOutboxFailureRollsBackChoiceAndRetriesExactlyOnce() {
		member("organizer");command("Назначить собрание");sendMeetingReply(11);var draft=meetingDraft();
		jdbc.execute("alter table outbox_events add constraint fixture_reject_meeting_audience check(payload->>'command'<>'meeting_audience')");
		try {nextCommand(2,"Собрать всю команду");assertThat(meetingDrafts.load("123",42,draft).revision()).isZero();assertThat(meetingDrafts.confirmedPanel("123",42,draft,0)).isTrue();}
		finally {jdbc.execute("alter table outbox_events drop constraint fixture_reject_meeting_audience");}
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=2");
		assertThat(commands.processOne("123")).isTrue();assertThat(sendMeetingReply(12).text()).contains("тему собрания");
		assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where payload->>'command'='meeting_audience'",Long.class)).isEqualTo(1);
	}
	@Test void audienceModeMustMatchOriginalInputBeforeMaterializationAndBeforeHttp() {
		for(var afterStart:java.util.List.of(false,true)) {
			clear();member("organizer");command("Назначить собрание");sendMeetingReply(11);nextCommand(2,"Собрать всю команду");
			if(afterStart) {
				planner.materialize(20,"123");var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
				jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,text}','\"Выбрать блок\"'::jsonb) where update_id=2");
				assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
			}else {
				jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,text}','\"Выбрать блок\"'::jsonb) where update_id=2");
				planner.materialize(20,"123");assertThat(count("notification_deliveries")).isEqualTo(1);
				assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'command'='meeting_audience'",String.class)).isEqualTo("failed");
			}
		}
	}
	@Test void repeatedAudienceAtWrongStepAndFacultyInputCannotAdvanceOrCreateMeeting() {
		member("organizer");command("Назначить собрание");sendMeetingReply(11);nextCommand(2,"Собрать всю команду");sendMeetingReply(12);
		var draft=meetingDraft();nextCommand(3,"Выбрать блок");assertThat(sendMeetingReply(13).text()).isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
		assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(1);
		for(var role:java.util.List.of("faculty_helper","faculty_responsible","unknown")) {
			clear();if(!role.equals("unknown"))member(role);command("Выбрать блок");
			assertThat(sendMeetingReply(11).text()).startsWith(role.equals("unknown")?"Вас нет в списке":"Встречи доступны только");
			assertThat(count("telegram_meeting_drafts")).isZero();assertThat(count("meetings")).isZero();
		}
	}
	@Test void catalogAtKeyboardCeilingIsBoundedUnicodeSafeAndLargerCatalogIsNotPartiallyOffered() {
		for(var size:java.util.List.of(56,57)) {
			clear();member("admin");jdbc.execute("insert into competencies(id,name,scope) select 'c'||n,n||repeat('🙂',100),'core' from generate_series(1,"+size+") n");
			command("Назначить собрание");sendMeetingReply(11);nextCommand(2,"Выбрать блок");var prompt=sendMeetingReply(12);
			if(size==56) {
				assertThat(prompt.keyboard().rows()).hasSize(8);
				prompt.keyboard().rows().stream().flatMap(java.util.List::stream).forEach(label->{assertThat(label.length()).isLessThanOrEqualTo(128);assertThat(java.nio.charset.StandardCharsets.UTF_8.newEncoder().canEncode(label)).isTrue();});
				assertThat(json.readTree(jdbc.queryForObject("select panel->'options' from telegram_meeting_drafts",String.class)).size()).isEqualTo(56);
			}else {assertThat(prompt.text()).contains("Слишком много блоков");assertThat(prompt.keyboard().rows()).containsExactly(java.util.List.of("Меню","Назад"));}
		}
	}
	void prepareTopic() {member("organizer");command("Назначить собрание");sendMeetingReply(11);nextCommand(2,"Собрать всю команду");sendMeetingReply(12);}
    @Test void missingForeignMalformedOrUnknownOfferNeverMutatesTopic() {
        for(var kind:java.util.List.of("missing","old","foreign_chat","foreign_bot","human","string_id","inaccessible","external","topic","guest","ephemeral","ephemeral_offer","unknown")) {
            clear();prepareTopic();var draft=meetingDraft();
            var before=jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class);
            var input=meetingInput(3,"Delayed topic");var message=(tools.jackson.databind.node.ObjectNode)input.path("message");
            var reply=(tools.jackson.databind.node.ObjectNode)message.path("reply_to_message");
            switch(kind) {
                case "missing"->message.remove("reply_to_message");
                case "old"->reply.put("message_id",11);
                case "foreign_chat"->((tools.jackson.databind.node.ObjectNode)reply.path("chat")).put("id",43);
                case "foreign_bot"->((tools.jackson.databind.node.ObjectNode)reply.path("from")).put("id",456);
                case "human"->((tools.jackson.databind.node.ObjectNode)reply.path("from")).put("is_bot",false);
                case "string_id"->reply.put("message_id","12");
                case "inaccessible"->reply.put("date",0);
                case "external"->message.putObject("external_reply");
                case "topic"->message.put("message_thread_id",7);
                case "guest"->message.put("guest_query_id","guest");
                case "ephemeral"->message.put("ephemeral_message_id",12);
                case "ephemeral_offer"->reply.put("ephemeral_message_id",12);
                case "unknown"->jdbc.execute("update notification_deliveries set status='unknown' where telegram_message_id=12");
            }
            inbox.accept("123",json.writeValueAsBytes(input));assertThat(commands.processOne("123")).isTrue();
            assertThat(jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class)).as(kind).isEqualTo(before);
            assertThat(sendMeetingReply(99).text()).isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
            assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("topic");assertThat(count("meetings")).isZero();
        }
    }
    @Test void audienceRequiresExplicitReplyAndRepeatedIdenticalErrorOfferCanStillAnswerSameField() {
        member("organizer");command("Назначить собрание");sendMeetingReply(11);
        var missing=meetingInput(2,"Собрать всю команду");((tools.jackson.databind.node.ObjectNode)missing.path("message")).remove("reply_to_message");
        inbox.accept("123",json.writeValueAsBytes(missing));assertThat(commands.processOne("123")).isTrue();
        assertThat(meetingDrafts.load("123",42,meetingDraft()).revision()).isZero();sendMeetingReply(99);
        nextCommand(3,"Собрать всю команду");sendMeetingReply(12);
        nextCommand(4,"");sendMeetingReply(13);
        var earlier=meetingInput(6,"Correct topic");
        nextCommand(5,"");sendMeetingReply(14);
        inbox.accept("123",json.writeValueAsBytes(earlier));assertThat(commands.processOne("123")).isTrue();
        assertThat(sendMeetingReply(15).text()).contains("описание");
        assertThat(meetingDrafts.load("123",42,meetingDraft()).payload().path("topic").asText()).isEqualTo("Correct topic");
    }
    @Test void delayedTopicReplyCannotBecomeDescriptionAndCurrentReplyStillWorks() {
        prepareTopic();var delayed=meetingInput(4,"Late topic");nextCommand(3,"Current topic");sendMeetingReply(13);
        var before=jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class);
        inbox.accept("123",json.writeValueAsBytes(delayed));assertThat(commands.processOne("123")).isTrue();
        assertThat(jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class)).isEqualTo(before);
        assertThat(sendMeetingReply(14).text()).isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
        nextCommand(5,"Current description");assertThat(sendMeetingReply(15).text()).contains("Введи дату");
        assertThat(meetingDrafts.load("123",42,meetingDraft()).payload().path("description").asText()).isEqualTo("Current description");
    }
    @Test void consumedReplyReferenceIsRecheckedAfterStartImmediatelyBeforeHttp() {
        prepareTopic();nextCommand(3,"Bound topic");planner.materialize(20,"123");
        var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
        jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,reply_to_message,from,id}','456'::jsonb) where update_id=3");
        assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
        assertThat(jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,lease.id())).isEqualTo("cancelled");
        assertThat(jdbc.queryForObject("select payload->>'topic' from telegram_meeting_drafts",String.class)).isEqualTo("Bound topic");
        assertThat(count("meetings")).isZero();
    }
    @Test void consumedOfferIsPersistedAndSourceReplyTamperingCancelsBeforePlannerOrHttp() {
        for(boolean materialized:java.util.List.of(false,true)) {
            clear();prepareTopic();nextCommand(3,"Bound topic");
            var offer=jdbc.queryForObject("select panel->>'offerId' from telegram_meeting_drafts",String.class);
            assertThat(offer).isNotBlank();
            assertThat(jdbc.queryForObject("select payload->>'meetingOfferId' from outbox_events where payload->>'meetingInput'='Bound topic'",String.class)).isEqualTo(offer);
            if(materialized)assertThat(planner.materialize(20,"123")).isEqualTo(1);
            jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,reply_to_message,message_id}','11'::jsonb) where update_id=3");
            var calls=new AtomicInteger();var worker=sender(m->{calls.incrementAndGet();return TelegramTransport.Outcome.sent(13);},"123");
            worker.dispatchOne();assertThat(calls).hasValue(0);
            if(materialized)assertThat(jdbc.queryForObject("select status from notification_deliveries where payload->>'meetingInput'='Bound topic'",String.class)).isEqualTo("cancelled");
            else assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'meetingInput'='Bound topic'",String.class)).isEqualTo("cancelled");
        }
    }
	String prepareBlock() {
		member("admin");jdbc.execute("insert into competencies(id,name,scope) values ('block','Core','core')");
		jdbc.execute("insert into users(id,telegram_id,username,real_name,role,registered) values ('other',43,'other','Другой участник','organizer',true),('faculty',44,'faculty','Факультетский участник','faculty_helper',true)");
		jdbc.execute("insert into user_competencies(user_id,competency_id) values ('other','block'),('faculty','block')");
		command("Назначить собрание");sendMeetingReply(11);nextCommand(2,"Выбрать блок");
		return sendMeetingReply(12).keyboard().rows().getFirst().getFirst();
	}
	@Test void scopedTopicAndDescriptionReachDatePromptThroughExistingDraft() {
		prepareTopic();var draft=meetingDraft();nextCommand(3,"  Тема\nсобрания  ");
		assertThat(sendMeetingReply(13).text()).contains("описание");
		assertThat(meetingDrafts.load("123",42,draft).payload().path("topic").asText()).isEqualTo("Тема\nсобрания");
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,2)).isTrue();
		nextCommand(4,"Пропустить");assertThat(sendMeetingReply(14).text()).contains("Введи дату");
		var state=meetingDrafts.load("123",42,draft);assertThat(state.step()).isEqualTo("date");assertThat(state.revision()).isEqualTo(3);
		assertThat(state.payload().path("description").isNull()).isTrue();assertThat(count("meetings")).isZero();
		assertThat(TelegramPrivateCommandHandler.command("Тема собрания")).isNull();
	}
	void prepareDate() {
		prepareTopic();nextCommand(3,"тема");sendMeetingReply(13);nextCommand(4,"описание");sendMeetingReply(14);
	}
	@Test void confirmedDateInputUsesSharedParserAndBackClearsOnlyDate() {
		for(var input:java.util.List.of("29.02.2400","2/1/28"," завтра ")) {
			clear();prepareDate();var draft=meetingDraft();nextCommand(5,input);
			assertThat(sendMeetingReply(15).text()).contains("Введи время");
			var state=meetingDrafts.load("123",42,draft);assertThat(state.step()).isEqualTo("time");assertThat(state.revision()).isEqualTo(4);
			if(input.contains("2400"))assertThat(state.payload().path("date").asText()).isEqualTo("2400-02-29");
			else if(input.contains("28"))assertThat(state.payload().path("date").asText()).isEqualTo("2028-01-02");
			else assertThat(state.payload().path("date").asText()).isEqualTo(java.time.LocalDate.now(java.time.ZoneId.of("Europe/Moscow")).plusDays(1).toString());
			assertThat(meetingDrafts.confirmedPanel("123",42,draft,4)).isTrue();
			nextCommand(6,"Назад");assertThat(sendMeetingReply(16).text()).contains("Введи дату");
			var back=meetingDrafts.load("123",42,draft);assertThat(back.step()).isEqualTo("date");assertThat(back.payload().has("date")).isFalse();
			assertThat(back.payload().path("topic").asText()).isEqualTo("тема");assertThat(back.payload().path("description").asText()).isEqualTo("описание");
			assertThat(count("meetings")).isZero();
		}
	}
	@Test void invalidDateRedrawsSameRevisionAndUnconfirmedDateOnlyRefuses() {
		prepareDate();var draft=meetingDraft();long update=5;
		for(var input:java.util.List.of("31.04.2028","29.02.2027","2028-01-02","","1.1.0000")) {
			nextCommand(update,input);assertThat(sendMeetingReply(10+update).text()).contains("Укажите дату","Введи дату");update++;
			assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(3);assertThat(meetingDrafts.load("123",42,draft).payload().has("date")).isFalse();
		}
		clear();prepareTopic();nextCommand(3,"тема");sendMeetingReply(13);nextCommand(4,"Пропустить");draft=meetingDraft();
		nextCommand(5,"29.02.2400");
		assertThat(jdbc.queryForObject("select o.payload->>'text' from outbox_events o join telegram_inbox i on i.id=o.aggregate_id where i.update_id=5",String.class))
				.isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
		assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("date");assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(3);
		assertThat(count("meetings")).isZero();
	}
	@Test void dateReplyFailureRollsBackAndRetryAdvancesOnce() {
		prepareDate();var draft=meetingDraft();jdbc.execute("alter table outbox_events add constraint fixture_reject_meeting_date check(payload->>'meetingInput'<>'29.02.2400')");
		try {nextCommand(5,"29.02.2400");assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("date");assertThat(meetingDrafts.confirmedPanel("123",42,draft,3)).isTrue();}
		finally {jdbc.execute("alter table outbox_events drop constraint fixture_reject_meeting_date");}
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=5");
		assertThat(commands.processOne("123")).isTrue();assertThat(sendMeetingReply(15).text()).contains("Введи время");
		assertThat(commands.processOne("123")).isFalse();assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(4);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where payload->>'meetingInput'='29.02.2400'",Long.class)).isEqualTo(1);
		assertThat(count("meetings")).isZero();
	}
	@Test void datePromptRejectsTamperedSourceAtPlannerAndExpiredDraftBeforeHttp() {
		prepareDate();nextCommand(5,"29.02.2400");
		jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,text}','\"28.02.2400\"'::jsonb) where update_id=5");
		planner.materialize(20,"123");assertThat(count("notification_deliveries")).isEqualTo(4);
		assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'meetingInput'='29.02.2400'",String.class)).isEqualTo("failed");
		clear();prepareDate();nextCommand(5,"29.02.2400");planner.materialize(20,"123");
		var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		jdbc.execute("update telegram_meeting_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second'");
		assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();assertThat(count("meetings")).isZero();
	}
	void prepareTime(String date) {prepareDate();nextCommand(5,date);sendMeetingReply(15);}
	@Test void confirmedTimeCreatesOneMeetingAndCanonicalCompletionThroughExistingSender() {
		prepareTime("29.02.2400");var draft=meetingDraft();nextCommand(6," 2:17 ");
		assertThat(jdbc.queryForObject("select status from telegram_meeting_drafts",String.class)).isEqualTo("completed");
		assertThat(jdbc.queryForObject("select revision from telegram_meeting_drafts",Long.class)).isEqualTo(5);
		assertThat(jdbc.queryForObject("select (starts_at at time zone 'Europe/Moscow')::text from meetings",String.class)).startsWith("2400-02-29 02:17");
		assertThat(jdbc.queryForObject("select payload->>'time' from telegram_meeting_drafts",String.class)).isEqualTo("02:17");
		assertThat(jdbc.queryForList("select user_id from meeting_invitations",String.class)).containsExactly("member");
		assertThat(count("audit_events")).isEqualTo(1);assertThat(count("integration_jobs")).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where event_type='meeting.created'",Integer.class)).isEqualTo(1);
		var reply=sendMeetingReply(16);assertThat(reply.text()).isEqualTo("Собрание назначено.\n29.02.2400, 02:17 (МСК).");
		assertThat(reply.keyboard().rows()).contains(java.util.List.of("Встречи","Назначить собрание"));
		assertThat(meetingDrafts.confirmedPanel("123",42,draft,5)).isFalse(); // A completion cannot authorize another dialog input.
		inbox.accept("123",jdbc.queryForObject("select payload::text from telegram_inbox where update_id=6",String.class).getBytes(java.nio.charset.StandardCharsets.UTF_8));
		assertThat(commands.processOne("123")).isFalse();nextCommand(7,"2:17");
		assertThat(count("meetings")).isEqualTo(1);assertThat(count("audit_events")).isEqualTo(1);assertThat(count("integration_jobs")).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from bot_messages where sender='bot' and text like 'Собрание назначено.%'",Integer.class)).isEqualTo(1);
	}
	@Test void invalidAndPastTimeRedrawWithoutRollbackOnlyAndCanReturnToDate() {
		prepareTime("1.1.2020");var draft=meetingDraft();long update=6;
		for(var input:java.util.List.of("24:00","23:60","18:30:00","18")) {
			nextCommand(update,input);var reply=sendMeetingReply(10+update);update++;
			assertThat(reply.text()).contains("Введи время");
			assertThat(reply.text()).contains(input.equals("18")?"Нельзя назначить встречу в прошлом":"Укажите время");
			assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(4);
		}
		assertThat(count("meetings")).isZero();assertThat(count("audit_events")).isZero();
		nextCommand(10,"Назад");sendMeetingReply(20);nextCommand(11,"29.02.2400");sendMeetingReply(21);nextCommand(12,"23:59");
		assertThat(sendMeetingReply(22).text()).contains("Собрание назначено.","23:59");assertThat(count("meetings")).isEqualTo(1);
	}
	@Test void finalTimeRechecksBlockAndUsesCurrentAudienceWithoutFaculty() {
		var label=prepareBlock();nextCommand(3,label);sendMeetingReply(13);nextCommand(4,"Подтвердить");sendMeetingReply(14);
		nextCommand(5,"тема");sendMeetingReply(15);nextCommand(6,"Пропустить");sendMeetingReply(16);nextCommand(7,"29.02.2400");sendMeetingReply(17);
		var draft=meetingDraft();jdbc.execute("delete from user_competencies where user_id='other'");
		nextCommand(8,"0");assertThat(sendMeetingReply(18).text()).contains("нет активных участников","Введи время");
		assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("time");assertThat(count("meetings")).isZero();
		jdbc.execute("insert into user_competencies(user_id,competency_id) values ('other','block')");
		nextCommand(9,"0");assertThat(sendMeetingReply(19).text()).contains("00:00");
		assertThat(jdbc.queryForList("select user_id from meeting_invitations",String.class)).containsExactlyInAnyOrder("member","other");
	}
	@Test void finalReplyAndDomainFailuresRollbackEveryEffectAndRetryCreatesOnce() {
		for(var table:java.util.List.of("outbox_events","integration_jobs","audit_events")) {
			clear();prepareTime("29.02.2400");var draft=meetingDraft();
			jdbc.execute("alter table "+table+" add constraint fixture_reject_creation check("+(table.equals("outbox_events")?"payload->>'meetingInput'<>'2:17'":"false")+")");
			try {
				nextCommand(6,"2:17");assertThat(count("meetings")).isZero();assertThat(count("meeting_invitations")).isZero();
				assertThat(count("audit_events")).isZero();assertThat(count("integration_jobs")).isZero();assertThat(count("outbox_events")).isEqualTo(5);
				assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(4);assertThat(meetingDrafts.confirmedPanel("123",42,draft,4)).isTrue();
			}finally {jdbc.execute("alter table "+table+" drop constraint fixture_reject_creation");}
			jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=6");
			assertThat(commands.processOne("123")).isTrue();assertThat(sendMeetingReply(16).text()).contains("Собрание назначено.");
			assertThat(count("meetings")).isEqualTo(1);assertThat(count("audit_events")).isEqualTo(1);assertThat(count("integration_jobs")).isEqualTo(1);
		}
	}
	@Test void unconfirmedOrUnknownTimePromptNeverCreatesMeeting() {
		for(var unknown:java.util.List.of(false,true)) {
			clear();prepareDate();nextCommand(5,"29.02.2400");var draft=meetingDraft();
			if(unknown)assertThat(sender(m->TelegramTransport.Outcome.unknown("timeout"),"123").dispatchOne()).isTrue();
			nextCommand(6,"2:17");assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("time");assertThat(count("meetings")).isZero();
			assertThat(jdbc.queryForObject("select o.payload->>'text' from outbox_events o join telegram_inbox i on i.id=o.aggregate_id where i.update_id=6",String.class))
					.isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
		}
	}
	@Test void completedReplyRechecksCanonicalMeetingOwnerAndExpiryAtPlannerAndBeforeHttp() {
		for(var change:java.util.List.of("update meetings set version=version+1","delete from chat_bindings",
				"update telegram_meeting_drafts set panel=jsonb_set(panel,'{completedMeetingId}','\"other\"'::jsonb)",
				"update telegram_meeting_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second'")) {
			for(var afterStart:java.util.List.of(false,true)) {
				clear();prepareTime("29.02.2400");nextCommand(6,"2:17");
				if(afterStart) {
					planner.materialize(20,"123");var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
					jdbc.execute(change);assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
				}else {
					jdbc.execute(change);planner.materialize(20,"123");
					assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'meetingInput'='2:17'",String.class)).isEqualTo("cancelled");
				}
				assertThat(count("meetings")).isEqualTo(1);
			}
		}
	}
	@Test void completedReplyIsInvalidatedByNavigationOrNewDialogAndExactSourceIsRequired() {
		for(var navigation:java.util.List.of("Меню","Назначить собрание")) {
			clear();prepareTime("29.02.2400");nextCommand(6,"2:17");nextCommand(7,navigation);planner.materialize(20,"123");
			assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'meetingInput'='2:17'",String.class)).isEqualTo("cancelled");
			assertThat(count("meetings")).isEqualTo(1);
		}
		clear();prepareTime("29.02.2400");nextCommand(6,"2:17");planner.materialize(20,"123");
		var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,text}','\"3:17\"'::jsonb) where update_id=6");
		assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
	}
	@Test void unknownCompletionSendNeverRepeatsCreationOrProviderSend() {
		prepareTime("29.02.2400");nextCommand(6,"2:17");var calls=new AtomicInteger();
		var worker=sender(m->{calls.incrementAndGet();return TelegramTransport.Outcome.unknown("timeout");},"123");
		assertThat(worker.dispatchOne()).isTrue();due();assertThat(worker.dispatchOne()).isFalse();assertThat(calls).hasValue(1);
		nextCommand(7,"2:17");assertThat(count("meetings")).isEqualTo(1);assertThat(count("audit_events")).isEqualTo(1);
		assertThat(jdbc.queryForObject("select count(*) from bot_messages where sender='bot' and text like 'Собрание назначено.%'",Integer.class)).isZero();
	}
	@Test void frozenBlockLabelAndExplicitConfirmationUseCurrentDomainAudienceRules() {
		var label=prepareBlock();var draft=meetingDraft();jdbc.execute("update competencies set name='Renamed' where id='block'");
		nextCommand(3,label);var preview=sendMeetingReply(13);
		assertThat(preview.text()).contains("Renamed","Другой участник").doesNotContain("Факультетский участник");
		assertThat(preview.keyboard().rows().getFirst()).containsExactly("Подтвердить");
		assertThat(meetingDrafts.load("123",42,draft).payload().path("competencyId").asText()).isEqualTo("block");
		nextCommand(4," ПОДТВЕРДИТЬ ");assertThat(sendMeetingReply(14).text()).contains("тему собрания");
		assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo("topic");assertThat(count("meetings")).isZero();
	}
	@Test void invalidInputRedrawsWithoutAdvancingAndPreservesFrozenPickerMapping() {
		var label=prepareBlock();var draft=meetingDraft();var original=jdbc.queryForObject("select panel->'options' from telegram_meeting_drafts",String.class);
		jdbc.execute("insert into competencies(id,name,scope) values ('first','AAAA','core')");
		nextCommand(3,"block");assertThat(sendMeetingReply(13).text()).contains("Выберите блок кнопкой");
		assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(1);
		assertThat(jdbc.queryForObject("select panel->'options' from telegram_meeting_drafts",String.class)).isEqualTo(original);
		nextCommand(4,label);sendMeetingReply(14);nextCommand(5,"не подтверждаю");assertThat(sendMeetingReply(15).text()).contains("Нажмите «Подтвердить»");
		assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(2);
		nextCommand(6,"Подтвердить");sendMeetingReply(16);nextCommand(7,"x".repeat(501));assertThat(sendMeetingReply(17).text()).contains("Тема слишком длинное");
		assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(3);
		nextCommand(8,"тема");sendMeetingReply(18);nextCommand(9,"x".repeat(4001));assertThat(sendMeetingReply(19).text()).contains("Описание слишком длинное");
		assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(4);
		assertThat(meetingDrafts.load("123",42,draft).payload().path("topic").asText()).isEqualTo("тема");
	}
	@Test void textOutsideDialogRemainsUnsupportedAndUnconfirmedTextOnlyRefuses() {
		for(var role:java.util.List.of("organizer","faculty_helper","unknown")) {
			clear();if(!role.equals("unknown"))member(role);command("произвольный текст");
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
			assertThat(count("outbox_events")).isZero();assertThat(count("bot_messages")).isZero();
		}
		clear();member("organizer");command("Назначить собрание");sendMeetingReply(11);nextCommand(2,"Собрать всю команду");
		var draft=meetingDraft();nextCommand(3,"слишком рано");planner.materialize(20,"123");
		assertThat(jdbc.queryForObject("select payload->>'text' from outbox_events where payload->>'command'='meeting_text'",String.class))
				.isEqualTo(ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.AUDIENCE_REFUSAL);
		assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(1);assertThat(meetingDrafts.load("123",42,draft).payload().has("topic")).isFalse();
		while(sender(m->TelegramTransport.Outcome.sent(12),"123").dispatchOne())due();
	}
	@Test void textOutboxFailureRollsBackTransitionAndRetriesOneReply() {
		prepareTopic();var draft=meetingDraft();jdbc.execute("alter table outbox_events add constraint fixture_reject_meeting_text check(payload->>'command'<>'meeting_text')");
		try {nextCommand(3,"тема");assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(1);assertThat(meetingDrafts.confirmedPanel("123",42,draft,1)).isTrue();}
		finally {jdbc.execute("alter table outbox_events drop constraint fixture_reject_meeting_text");}
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=3");
		assertThat(commands.processOne("123")).isTrue();assertThat(sendMeetingReply(13).text()).contains("описание");
		assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from outbox_events where payload->>'command'='meeting_text'",Long.class)).isEqualTo(1);
	}
	@Test void textReplyRequiresExactOriginalInputAtPlannerAndFinalHttpGate() {
		for(var afterStart:java.util.List.of(false,true)) {
			clear();prepareTopic();nextCommand(3,"тема");
			if(afterStart) {
				planner.materialize(20,"123");var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
				jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,text}','\"другая тема\"'::jsonb) where update_id=3");
				assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
			}else {
				jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{message,text}','\"другая тема\"'::jsonb) where update_id=3");
				planner.materialize(20,"123");assertThat(count("notification_deliveries")).isEqualTo(2);
				assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'command'='meeting_text'",String.class)).isEqualTo("failed");
			}
		}
	}
	@Test void backTraversesBlockTextStepsAndPreservesOnlyEarlierValues() {
		var label=prepareBlock();var draft=meetingDraft();nextCommand(3,label);sendMeetingReply(13);nextCommand(4,"Подтвердить");sendMeetingReply(14);
		nextCommand(5,"тема");sendMeetingReply(15);nextCommand(6,"описание");sendMeetingReply(16);
		long update=7;
		for(var step:java.util.List.of("description","topic","confirm_competency","pick_competency","choose_type")) {
			nextCommand(update,"Назад");sendMeetingReply(10+update);update++;
			assertThat(meetingDrafts.load("123",42,draft).step()).isEqualTo(step);
		}
		assertThat(meetingDrafts.load("123",42,draft).payload().size()).isZero();assertThat(count("meetings")).isZero();
	}
	@Test void withdrawnBlockCannotAdvanceSelectionOrConfirmationAndSlashCommandsStayUnsupported() {
		var label=prepareBlock();var draft=meetingDraft();jdbc.execute("update competencies set active=false where id='block'");
		nextCommand(3,label);assertThat(sendMeetingReply(13).text()).contains("Блок компетенций не найден");assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(1);
		jdbc.execute("update competencies set active=true where id='block'");nextCommand(4,label);sendMeetingReply(14);
		jdbc.execute("delete from user_competencies where user_id='other'");nextCommand(5,"Подтвердить");
		assertThat(sendMeetingReply(15).text()).contains("нет активных участников");assertThat(meetingDrafts.load("123",42,draft).revision()).isEqualTo(2);
		nextCommand(6,"/unknown");assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=6",String.class)).isEqualTo("retry");
		assertThat(count("meetings")).isZero();
	}
	@Test void meetingsReplyRechecksOwnerVersionBindingAndRoleAtFinalSendGate() {
		for(var change:java.util.List.of("update users set version=version+1","update users set role='faculty_helper'",
				"update users set active=false,deactivated_at=clock_timestamp()","delete from chat_bindings","update notification_deliveries set payload=payload-'profileVersion'")) {
			for(var afterStart:java.util.List.of(false,true)) {
				clear();member("organizer");command("Встречи");planner.materialize(20,"123");
				if(afterStart) {
					var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
					jdbc.execute(change);assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
				}else {
					jdbc.execute(change);assertThat(sender(m->{throw new AssertionError("stale_meetings_sent");},"123").dispatchOne()).isTrue();
				}
				assertThat(status()).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
			}
		}
	}
	@Test void meetingsOutboxFailureRollsBackNavigationAndRetriesOneReply() {
		member("organizer");slots.openPanel("123",42);
		jdbc.execute("alter table outbox_events add constraint fixture_reject_meetings check(payload->>'command'<>'meetings')");
		try {command("Встречи");assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("open");assertThat(count("bot_messages")).isZero();assertThat(count("outbox_events")).isZero();}
		finally {jdbc.execute("alter table outbox_events drop constraint fixture_reject_meetings");}
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second'");assertThat(commands.processOne("123")).isTrue();
		assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("cancelled");
		assertThat(count("outbox_events")).isEqualTo(1);assertThat(count("bot_messages")).isEqualTo(1);assertThat(count("availability_weeks")).isZero();
	}
	@Test void slotsPanelIsPrivatePersistedAndBoundOnlyAfterConfirmedSend() {
		for(var alias:java.util.List.of("Слоты"," /SLOTS \n")) {
			clear();member("organizer");command(alias);var draft=slotDraft();
			assertThat(count("telegram_slot_drafts")).isEqualTo(1);assertThat(count("availability_weeks")).isZero();
			assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,0)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
			var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
			assertThat(status()).isEqualTo("sent");assertThat(captured.get().text()).startsWith("Сохранённые слоты").contains("не отмечено");
			assertThat(captured.get().keyboard()).isNull();assertThat(captured.get().inlineKeyboard().rows().getFirst().getFirst().callbackData()).isEqualTo("sl:"+draft+":0:e");
			assertThatCode(()->slots.requireConfirmedPanel("123",42,11,draft,0)).doesNotThrowAnyException();
			for(long wrongMessage:java.util.List.of(0L,12L))assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,wrongMessage,draft,0)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
			assertThatThrownBy(()->slots.requireConfirmedPanel("456",42,11,draft,0)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
			assertThatThrownBy(()->slots.requireConfirmedPanel("123",43,11,draft,0)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
			assertThat(count("bot_messages")).isEqualTo(2);assertThat(count("sessions")).isZero();
		}
	}
	@Test void facultyAndUnknownSlotsDoNotCreateDraftOrExposeCorePanel() {
		for(var role:java.util.List.of("unknown","faculty_helper","faculty_responsible")) {
			clear();if(!role.equals("unknown"))member(role);command("Слоты");
			var captured=new AtomicReference<TelegramTransport.Message>();assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(15);},"123").dispatchOne()).isTrue();
			assertThat(count("telegram_slot_drafts")).isZero();assertThat(captured.get().inlineKeyboard()).isNull();
			assertThat(captured.get().text()).startsWith(role.equals("unknown")?"Вас нет в списке":"Слоты доступны только");
		}
	}
	@Test void changedDraftOwnerSettingsOrWeekCancelPanelBeforeSending() {
		for(var change:java.util.List.of("update telegram_slot_drafts set revision=revision+1",
				"update telegram_slot_drafts set status='cancelled'","update users set version=version+1",
				"update users set role='faculty_helper'","delete from chat_bindings",
				"update telegram_slot_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second'",
				"insert into app_settings(setting_key,setting_value,version) values ('availability','{}',1)",
				"insert into availability_weeks(id,user_id,week_start,version) select 'changed','member',week_start,1 from telegram_slot_drafts")) {
			for(boolean materialized:java.util.List.of(false,true)) {
				clear();member("organizer");command("Слоты");if(materialized)planner.materialize(20,"123");jdbc.execute(change);
				if(materialized) {assertThat(sender(m->{throw new AssertionError("stale_slot_panel_sent");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");}
				else {assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("cancelled");}
			}
		}
	}
	@Test void unknownSendAndReopenedEditorNeverAuthorizeOldPanel() {
		member("admin");command("/slots");var draft=slotDraft();
		assertThat(sender(m->TelegramTransport.Outcome.unknown("lost_response"),"123").dispatchOne()).isTrue();
		assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,0)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
		clear();member("admin");command("/slots");var sentDraft=slotDraft();
		assertThat(sender(m->TelegramTransport.Outcome.sent(11),"123").dispatchOne()).isTrue();
		slots.openPanel("123",42);
		assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,sentDraft,0)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
	}
	@Test void panelCreationRollsBackWithOutboxFailureAndCannotAcceptTamperedButton() {
		member("organizer");jdbc.execute("alter table outbox_events add constraint reject_slot_panel check(payload->>'command'<>'slots')");
		try {command("Слоты");assertThat(count("telegram_slot_drafts")).isZero();assertThat(count("bot_messages")).isZero();assertThat(count("chat_bindings")).isZero();}
		finally {jdbc.execute("alter table outbox_events drop constraint reject_slot_panel");}
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second'");assertThat(commands.processOne("123")).isTrue();
		jdbc.execute("update outbox_events set payload=jsonb_set(payload,'{replyMarkup,inline_keyboard,0,0,callback_data}','\"foreign:action\"')");
		planner.materialize(20,"123");assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("cancelled");
	}
	@Test void confirmedPanelBecomesInvalidAfterDraftOrSourceChanges() {
		for(var change:java.util.List.of("update telegram_slot_drafts set revision=1",
				"update users set version=version+1","delete from chat_bindings",
				"insert into app_settings(setting_key,setting_value,version) values ('availability','{}',1)",
				"update notification_deliveries set status='unknown',telegram_message_id=null",
				"update outbox_events set payload=jsonb_set(payload,'{slotDraftId}','\"foreign\"')")) {
			clear();member("organizer");command("/slots");var draft=slotDraft();
			assertThat(sender(m->TelegramTransport.Outcome.sent(11),"123").dispatchOne()).isTrue();jdbc.execute(change);
			assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,0)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
		}
	}
	@Test void draftChangeAfterStartStillCancelsAtFinalPreHttpGate() {
		member("organizer");command("Слоты");planner.materialize(20,"123");
		var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		jdbc.execute("update telegram_slot_drafts set revision=revision+1");
		assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
		assertThat(status()).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test void providerAcceptanceWithoutCommittedFinishCannotAuthorizePanelOrResend() {
		member("organizer");command("Слоты");var draft=slotDraft();var calls=new AtomicInteger();
		jdbc.execute("alter table bot_messages add constraint reject_slot_history check(sender<>'bot')");
		try {assertThatThrownBy(()->sender(m->{calls.incrementAndGet();return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isInstanceOf(RuntimeException.class);}
		finally {jdbc.execute("alter table bot_messages drop constraint reject_slot_history");}
		assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,0)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
		assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries",Long.class)).isNull();
		jdbc.execute("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second'");queue.recoverExpiredLeases();
		assertThat(status()).isEqualTo("unknown");assertThat(sender(m->{calls.incrementAndGet();return TelegramTransport.Outcome.sent(12);},"123").dispatchOne()).isFalse();
		assertThat(calls.get()).isEqualTo(1);
	}
	@Test void fiveFullWeeksAndAllTriStateLabelsProduceBoundedOwnSummary() {
		member("admin");jdbc.execute("insert into app_settings(setting_key,setting_value,version) values ('availability','{\"weekCount\":5,\"activeDays\":[0,1,2,3,4,5,6],\"firstHour\":0,\"lastHour\":23}',1)");
		jdbc.execute("""
				insert into availability_weeks(id,user_id,week_start,version)
				select 'week_'||n,'member',date_trunc('week',clock_timestamp() at time zone 'Europe/Moscow')::date+n*7,1 from generate_series(0,4) n
				""");
		jdbc.execute("insert into availability_days(id,week_id,week_start,day_date,status) select w.id||'_'||n,w.id,w.week_start,w.week_start+n,'available' from availability_weeks w cross join generate_series(0,6) n");
		jdbc.execute("insert into availability_slots(day_id,start_minute) select d.id,n from availability_days d cross join generate_series(0,1380,60) n");
		command("/slots");var captured=new AtomicReference<TelegramTransport.Message>();assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().text()).hasSizeLessThan(4001).contains("00:00–23:00","Вс:");
		assertThat(captured.get().text().split("Неделя ")).hasSize(6);
		assertThat(captured.get().inlineKeyboard().rows().getFirst().getFirst().callbackData().getBytes(java.nio.charset.StandardCharsets.UTF_8)).hasSizeLessThan(65);
		jdbc.execute("delete from availability_slots where day_id='week_0_0'");jdbc.execute("update availability_days set status='unavailable' where id='week_0_0'");
		jdbc.execute("delete from availability_days where id='week_0_1' or week_id='week_1'");jdbc.execute("update availability_weeks set out_of_week=true where id='week_1'");
		assertThat(slots.openPanel("123",42).text()).contains("Пн: не смогу","Вт: не отмечено","Я в ауте");
	}
	@Test void helpAliasesPreserveRoleSpecificTextKeyboardAndConfirmedHistory() {
		for(var role:java.util.List.of("admin","organizer","faculty_helper","faculty_responsible"))for(var input:java.util.List.of("Помощь"," /HELP \n")) {
			clear();member(role);command(input);assertThat(count("bot_messages")).isEqualTo(1);
			assertThat(jdbc.queryForObject("select payload->>'command' from outbox_events",String.class)).isEqualTo("help");
			var captured=new AtomicReference<TelegramTransport.Message>();assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
			var reply=captured.get();assertThat(status()).isEqualTo("sent");assertThat(count("bot_messages")).isEqualTo(2);assertThat(count("sessions")).isZero();
			if(role.startsWith("faculty_")) {
				assertThat(reply.text()).startsWith("Здесь ты получаешь задачи").doesNotContain("Слоты","/all","МФ");
				assertThat(reply.keyboard().rows()).containsExactly(java.util.List.of("Мои задачи","Помощь"));
			}else {
				assertThat(reply.text()).startsWith("Что умеет бот").contains("Профиль","Слоты","/checkin").doesNotContain("*Профиль*");
				assertThat(reply.text().contains("МФ —")).isEqualTo(role.equals("admin"));
				assertThat(reply.keyboard().rows().get(1).contains("МФ")).isEqualTo(role.equals("admin"));
			}
		}
	}
	@Test void menuRestoresRoleSpecificRootWithoutImplementingDialogBack() {
		for(var role:java.util.List.of("faculty_helper","faculty_responsible")) {
			clear();member(role);command("  МЕНЮ  ");var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(12);},"123").dispatchOne()).isTrue();
			assertThat(jdbc.queryForObject("select payload->>'command' from outbox_events",String.class)).isEqualTo("menu");
			assertThat(captured.get().text()).startsWith(role.startsWith("faculty_")?"Меню задач.":"Привет, Участник!");
			assertThat(captured.get().keyboard().rows().getFirst()).isEqualTo(role.startsWith("faculty_")?java.util.List.of("Мои задачи","Помощь"):java.util.List.of("Профиль","Слоты","Встречи"));
		}
	}
	@Test void unknownOrInactiveHelpAndMenuNeverRevealMemberDataOrRegisterUser() {
		for(var input:java.util.List.of("/help","Помощь","Меню","Профиль"))for(var inactive:java.util.List.of(false,true)) {
			clear();if(inactive) { member("admin");jdbc.execute("update users set active=false,deactivated_at=now(),registered=false"); }
			command(input);var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(13);},"123").dispatchOne()).isTrue();
			assertThat(captured.get().text()).startsWith("Вас нет в списке").doesNotContain("Участник","/all","МФ");
			assertThat(captured.get().keyboard().rows()).containsExactly(java.util.List.of("Помощь"));assertThat(count("chat_bindings")).isZero();assertThat(count("bot_messages")).isZero();
			assertThat(jdbc.queryForObject("select count(*) from users where registered",Integer.class)).isZero();
		}
	}
	@Test void prefixLookalikesMentionsDialogBackAndUnknownCommandsRemainRetryable() {
		for(var text:java.util.List.of("/helpme","/help payload","/help@other_bot","/starter","Назад ещё","/menu","/profile","Профиль чужого")) {
			clear();member("organizer");command(text);assertThat(count("outbox_events")).isZero();assertThat(count("bot_messages")).isZero();
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
			assertThat(jdbc.queryForObject("select last_error from telegram_inbox",String.class)).isEqualTo("unsupported_command");
		}
	}
	@Test void helpRollsBackWithOutboxAndReplayCreatesOneReplyWhileStaleRoleCancelsSend() {
		member("admin");jdbc.execute("alter table outbox_events add constraint fixture_reject_help check(payload->>'command'<>'help')");
		try {
			command("/help");assertThat(count("outbox_events")).isZero();assertThat(count("bot_messages")).isZero();assertThat(count("chat_bindings")).isZero();
			assertThat(jdbc.queryForObject("select last_seen_at from users",java.sql.Timestamp.class)).isNull();
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
		}finally { jdbc.execute("alter table outbox_events drop constraint fixture_reject_help"); }
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second'");assertThat(commands.processOne("123")).isTrue();
		assertThat(inbox.accept("123",jdbc.queryForObject("select payload::text from telegram_inbox",String.class).getBytes(java.nio.charset.StandardCharsets.UTF_8))).isFalse();
		assertThat(commands.processOne("123")).isFalse();assertThat(count("outbox_events")).isEqualTo(1);assertThat(count("bot_messages")).isEqualTo(1);
		planner.materialize(20,"123");jdbc.execute("update users set role='organizer'");
		assertThat(sender(m->{throw new AssertionError("old_admin_help_sent");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");
	}
	@Test void replyCommandMustMatchPersistedInputRatherThanAnotherSupportedCommand() {
		member("faculty_helper");command("Помощь");
		jdbc.execute("update outbox_events set payload=jsonb_set(payload,'{command}','\"menu\"')");
		assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
		assertThat(jdbc.queryForObject("select last_error_code from outbox_events",String.class)).isEqualTo("invalid_command_reply");
	}
	@Test void profileAndCoreMenuShowOnlyOwnRealStatisticsAndRoleKeyboard() {
		for(var role:java.util.List.of("admin","organizer","faculty_helper","faculty_responsible")) {
			clear();member(role);
			jdbc.execute("insert into users(id,username,real_name,role) values ('other','otheruser','Другой','organizer')");
			jdbc.execute("update users set birthday_day=10,birthday_month=5,birthday_year=2000 where id='member'");
			jdbc.execute("insert into competencies(id,name,scope) values ('block','Дизайн','core')");
			jdbc.execute("insert into user_competencies(user_id,competency_id,is_primary) values ('member','block',true)");
			jdbc.execute("insert into tasks(id,title,priority,status,completed_at) values ('active','Личная','normal','assigned',null),('done','Готовая','normal','completed',now()),('foreign','Чужая','normal','assigned',null)");
			jdbc.execute("insert into tasks(id,title,priority,status,cancelled_at) values ('cancel','Отмена','normal','cancelled',now())");
			jdbc.execute("insert into task_assignees(task_id,user_id) values ('active','member'),('done','member'),('cancel','member'),('foreign','other')");
			jdbc.execute("insert into meetings(id,kind,title,starts_at,duration_minutes,zone_id,host_id,audience_mode,status) values ('mine','meeting','Личная встреча',now()+interval '1 day',60,'Europe/Moscow','member','selected','scheduled'),('foreign','meeting','Секретная встреча',now()+interval '1 hour',60,'Europe/Moscow','other','selected','scheduled'),('past','meeting','Старая',now()-interval '2 hours',60,'Europe/Moscow','member','selected','scheduled')");
			jdbc.execute("insert into meeting_invitations(meeting_id,user_id) values ('mine','member'),('past','member'),('foreign','other')");
			jdbc.execute("insert into availability_weeks(id,user_id,week_start) values ('week','member',date_trunc('week',now() at time zone 'Europe/Moscow')::date),('old','member',date_trunc('week',now() at time zone 'Europe/Moscow')::date-7)");
			jdbc.execute("insert into availability_days(id,week_id,week_start,day_date,status) select id,id,week_start,week_start,'available' from availability_weeks");
			jdbc.execute("insert into availability_slots(day_id,start_minute) values ('week',600),('week',660),('old',600)");
			command(role.startsWith("faculty_")?" Профиль ":"Меню");var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(90);},"123").dispatchOne()).isTrue();
			assertThat(captured.get().text()).startsWith("Участник\n@alice").contains("Главный блок: Дизайн","Дата рождения: 10.05.2000","активных задач — 1","выполнено задач — 1","ближайших встреч — 1","свободных часов отмечено — 2","Личная встреча").doesNotContain("Секретная","Чужая","Старая","*Участник*");
			assertThat(captured.get().keyboard().rows().getFirst()).contains("Профиль");
			assertThat(captured.get().keyboard().rows().toString().contains("МФ")).isEqualTo(role.equals("admin"));
			assertThat(count("sessions")).isZero();assertThat(count("bot_messages")).isEqualTo(2);
		}
	}
	@Test void emptyOwnProfileHasNoInventedDataAndReplayProducesOneReply() {
		member("organizer");command("ПРОФИЛЬ");
		assertThat(inbox.accept("123",jdbc.queryForObject("select payload::text from telegram_inbox",String.class).getBytes(java.nio.charset.StandardCharsets.UTF_8))).isFalse();
		assertThat(commands.processOne("123")).isFalse();var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(91);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().text()).contains("Главный блок: не выбран","Дата рождения: не указана","активных задач — 0","выполнено задач — 0","ближайших встреч — 0","свободных часов отмечено — 0").doesNotContain("Следующая встреча","До дня рождения");
		assertThat(count("outbox_events")).isEqualTo(1);assertThat(count("notification_deliveries")).isEqualTo(1);
	}
	@Test void profileEditAfterMaterializationOrAtFinalGateCancelsOldPrivateSnapshot() {
		for(var finalGate:java.util.List.of(false,true)) {
			clear();member("organizer");command("Профиль");planner.materialize(20,"123");
			if(finalGate) {
				var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
				jdbc.execute("update users set version=version+1,real_name='Новое имя'");
				assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
			} else {
				jdbc.execute("update users set version=version+1");
				assertThat(sender(m->{throw new AssertionError("old_profile_sent");},"123").dispatchOne()).isTrue();
			}
			assertThat(status()).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
		}
	}
	@Test void profileBirthdayUsesMoscowDateAndOwnYearOnly() {
		member("organizer");
		jdbc.execute("update users set birthday_day=extract(day from now() at time zone 'Europe/Moscow'),birthday_month=extract(month from now() at time zone 'Europe/Moscow'),birthday_year=2000");
		command("Профиль");var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(92);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().text()).contains("До дня рождения: сегодня",".2000 · ");
	}
	@Test void profileOutboxFailureRollsBackAndMissingVersionCannotSend() {
		member("organizer");jdbc.execute("alter table outbox_events add constraint fixture_reject_profile check(payload->>'command'<>'profile')");
		try {
			command("Профиль");assertThat(count("outbox_events")).isZero();assertThat(count("bot_messages")).isZero();assertThat(count("chat_bindings")).isZero();
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
		}finally { jdbc.execute("alter table outbox_events drop constraint fixture_reject_profile"); }
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second'");assertThat(commands.processOne("123")).isTrue();
		jdbc.execute("update outbox_events set payload=payload-'profileVersion'");
		assertThat(sender(m->{throw new AssertionError("unversioned_profile_sent");},"123").dispatchOne()).isTrue();
		assertThat(status()).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test void authenticatedReplyUsesExistingSenderAndConfirmedHistoryOnlyOnce() {
		member("admin");start();assertThat(count("bot_messages")).isEqualTo(1);
		assertThat(planner.materialize(20,"456")).isZero();assertThat(planner.materialize(20,"123")).isEqualTo(1);
		assertThat(planner.materialize(20,"123")).isZero();assertThat(count("notification_deliveries")).isEqualTo(1);
		assertThat(queue.claimSupported(1,Duration.ofSeconds(30),"456")).isEmpty();assertThat(queue.claimSupported(1,Duration.ofSeconds(30))).isEmpty();
		assertThat(queue.claim(1,Duration.ofSeconds(30))).isEmpty();
		var captured=new AtomicReference<TelegramTransport.Message>();var calls=new AtomicInteger();
		var worker=sender(m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();captured.set(m);calls.incrementAndGet();return TelegramTransport.Outcome.sent(77);},"123");
		assertThat(worker.dispatchOne()).isTrue();assertThat(worker.dispatchOne()).isFalse();assertThat(calls).hasValue(1);
		assertThat(captured.get().keyboard().rows().get(1)).contains("МФ");assertThat(captured.get().chatId()).isEqualTo(42);
		assertThat(status()).isEqualTo("sent");assertThat(count("bot_messages")).isEqualTo(2);
		assertThat(jdbc.queryForObject("select buttons->'keyboard' is not null from bot_messages where sender='bot'",Boolean.class)).isTrue();
		assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries",Long.class)).isEqualTo(77);
	}
	@Test void syntheticInlineReplyPreservesQueueHistoryReplayAndLastRoleGate() {
		for(var revoked:java.util.List.of(false,true)) {
			clear();member("organizer");start();
			// Transport-only fixture; current command handlers do not yet generate slot panels.
			jdbc.execute("update outbox_events set payload=jsonb_set(payload,'{replyMarkup}','{\"inline_keyboard\":[[{\"text\":\"Изменить слоты\",\"callback_data\":\"slot_edit\"}]]}'::jsonb)");
			assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(planner.materialize(20,"123")).isZero();
			if(revoked)jdbc.execute("update users set active=false,deactivated_at=now()");
			var calls=new AtomicInteger();var captured=new AtomicReference<TelegramTransport.Message>();
			var worker=sender(m->{calls.incrementAndGet();captured.set(m);return TelegramTransport.Outcome.sent(88);},"123");
			assertThat(worker.dispatchOne()).isTrue();assertThat(worker.dispatchOne()).isFalse();
			assertThat(calls).hasValue(revoked?0:1);assertThat(status()).isEqualTo(revoked?"cancelled":"sent");
			if(!revoked) {
				assertThat(captured.get().keyboard()).isNull();assertThat(captured.get().inlineKeyboard().rows().getFirst().getFirst().callbackData()).isEqualTo("slot_edit");
				assertThat(jdbc.queryForObject("select buttons->'inline_keyboard' is not null from bot_messages where sender='bot'",Boolean.class)).isTrue();
			}
			assertThat(count("bot_messages")).isEqualTo(revoked?1:2);
		}
	}
	@Test void invalidInlineOutboxAndTamperedQueuedMarkupNeverReachTransport() {
		for(var materialized:java.util.List.of(false,true)) {
			clear();member("organizer");start();
			if(materialized)planner.materialize(20,"123");
			jdbc.execute("update outbox_events set payload=jsonb_set(payload,'{replyMarkup}','{\"inline_keyboard\":[[{\"text\":\"Оплата\",\"callback_data\":\"slot_edit\",\"pay\":true}]]}'::jsonb)");
			if(materialized) {
				jdbc.execute("update notification_deliveries set payload=(select payload from outbox_events)");
				assertThat(sender(m->{throw new AssertionError("invalid_inline_sent");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("failed");
			} else {
				assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
				assertThat(jdbc.queryForObject("select last_error_code from outbox_events",String.class)).isEqualTo("invalid_command_reply");
			}
			assertThat(count("bot_messages")).isEqualTo(1);
		}
	}
	@Test void unknownUserReceivesOnlyHelpAndNoMemberHistory() {
		start();var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(9);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().keyboard().rows()).containsExactly(java.util.List.of("Помощь"));assertThat(captured.get().text()).contains("Вас нет в списке");
		assertThat(status()).isEqualTo("sent");assertThat(count("bot_messages")).isZero();assertThat(count("users")).isZero();
	}
	@Test void revokedRoleIdentityOrPrivateBindingCancelsWithoutHttp() {
		for(var change:java.util.List.of("update users set role='organizer'","update users set active=false,deactivated_at=now()",
				"update users set telegram_id=43","delete from chat_bindings")) {
			clear();member("admin");start();assertThat(planner.materialize(20,"123")).isEqualTo(1);jdbc.execute(change);
			assertThat(sender(m->{throw new AssertionError("stale_menu_sent");},"123").dispatchOne()).isTrue();
			assertThat(status()).isEqualTo("cancelled");assertThat(count("delivery_attempts")).isZero();assertThat(count("bot_messages")).isEqualTo(1);
		}
	}
	@Test void denialBecomesStaleAfterAdmissionAndCannotBeRedirectedToAnotherChat() {
		start();planner.materialize(20,"123");member("organizer");
		assertThat(sender(m->{throw new AssertionError("old_denial_sent");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");
		clear();member("organizer");start();planner.materialize(20,"123");jdbc.execute("update notification_deliveries set chat_id=43");
		assertThat(sender(m->{throw new AssertionError("redirected_reply");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");
	}
	@Test void replyExpiryUsesOriginalDueAndIncompleteSourceNeverSends() {
		member("organizer");start();jdbc.execute("update outbox_events set available_at=clock_timestamp()-interval '16 minutes'");
		assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select last_error_code from outbox_events",String.class)).isEqualTo("command_reply_expired");
		clear();member("organizer");start();jdbc.execute("update telegram_inbox set status='retry'");
		assertThat(planner.materialize(20,"123")).isZero();jdbc.execute("update telegram_inbox set status='completed'");planner.materialize(20,"123");
		jdbc.execute("update outbox_events set status='pending'");
		assertThat(sender(m->{throw new AssertionError("incomplete_source_sent");},"456").dispatchOne()).isFalse();
		var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();assertThat(status()).isEqualTo("cancelled");
	}
	@Test void malformedOrLegacyReplyFailsClosedBeforeMaterialization() {
		for(var change:java.util.List.of("update outbox_events set payload=payload-'recipientRole'",
				"update outbox_events set payload=jsonb_set(payload,'{replyMarkup,keyboard,0,0,request_contact}','true')",
				"update outbox_events set payload=jsonb_set(payload,'{chatId}','-100')")) {
			clear();member("organizer");start();jdbc.execute(change);assertThat(planner.materialize(20,"123")).isEqualTo(1);
			assertThat(count("notification_deliveries")).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
		}
	}
	@Test void safeRetryKeepsKeyboardButAmbiguousResultNeverResendsOrCreatesHistory() {
		member("faculty_helper");start();var calls=new AtomicInteger();var messages=new java.util.ArrayList<TelegramTransport.Message>();
		var worker=sender(m->{messages.add(m);return calls.incrementAndGet()==1?TelegramTransport.Outcome.retry("telegram_429",Duration.ofSeconds(1)):TelegramTransport.Outcome.unknown("response_timeout");},"123");
		assertThat(worker.dispatchOne()).isTrue();assertThat(status()).isEqualTo("retry");assertThat(count("bot_messages")).isEqualTo(1);
		due();assertThat(worker.dispatchOne()).isTrue();assertThat(status()).isEqualTo("unknown");assertThat(worker.dispatchOne()).isFalse();
		assertThat(calls).hasValue(2);assertThat(messages.get(0).keyboard()).isEqualTo(messages.get(1).keyboard());
		assertThat(messages.get(0).keyboard().rows()).containsExactly(java.util.List.of("Мои задачи","Помощь"));assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test void lastPreHttpGateAndStaleTokenCannotCancelNewOwnership() {
		member("admin");start();planner.materialize(20,"123");var old=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();
		jdbc.execute("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second'");queue.recoverExpiredLeases();
		var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(old.id(),old.token())).isFalse();assertThat(status()).isEqualTo("claimed");
		assertThat(queue.start(lease.id(),lease.token())).isTrue();jdbc.execute("update users set role='organizer'");
		assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();assertThat(status()).isEqualTo("cancelled");
		assertThat(jdbc.queryForObject("select result_status from delivery_attempts",String.class)).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test void realDatabaseFailureRollsBackDeliveryAndOutboxTogetherThenRetrySucceeds() {
		member("organizer");start();jdbc.execute("alter table notification_deliveries add constraint fixture_reject_reply check(category<>'telegram_command_reply')");
		try {
			assertThatThrownBy(()->planner.materialize(20,"123")).isInstanceOf(org.springframework.dao.DataAccessException.class);
			assertThat(count("notification_deliveries")).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");
		}finally { jdbc.execute("alter table notification_deliveries drop constraint fixture_reject_reply"); }
		assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isEqualTo(1);
	}
	@Test void removedRecipientAndTamperedSnapshotFailClosedWithoutBlockingOtherOutboxWork() {
		member("organizer");start();jdbc.execute("delete from bot_messages");jdbc.execute("delete from users where id='member'");
		assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select last_error_code from outbox_events",String.class)).isEqualTo("stale_command_reply");
		clear();member("organizer");start();planner.materialize(20,"123");
		jdbc.execute("update notification_deliveries set payload=jsonb_set(payload,'{text}','\"Подмена\"')");
		assertThat(sender(m->{throw new AssertionError("tampered_reply_sent");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");
	}
	@Test void failedHistoryCommitAfterProviderAcceptanceRecoversAsUnknownWithoutDuplicateSend() {
		member("organizer");start();var calls=new AtomicInteger();var worker=sender(m->{calls.incrementAndGet();return TelegramTransport.Outcome.sent(99);},"123");
		jdbc.execute("alter table bot_messages add constraint fixture_reject_bot_history check(sender<>'bot')");
		try {
			assertThatThrownBy(worker::dispatchOne).isInstanceOf(org.springframework.dao.DataAccessException.class);
			assertThat(status()).isEqualTo("sending");assertThat(count("bot_messages")).isEqualTo(1);
			assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries",Long.class)).isNull();
		}finally { jdbc.execute("alter table bot_messages drop constraint fixture_reject_bot_history"); }
		jdbc.execute("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second'");assertThat(worker.dispatchOne()).isFalse();
		assertThat(status()).isEqualTo("unknown");assertThat(calls).hasValue(1);assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test @Timeout(60) void concurrentMaterializersCreateOneDeliveryAndStartedRecoveryStaysUnknown() throws Exception {
		member("organizer");start();
		try(var pool=Executors.newFixedThreadPool(2)) {
			var go=new CountDownLatch(1);var a=pool.submit(()->{go.await();return planner.materialize(20,"123");});var b=pool.submit(()->{go.await();return planner.materialize(20,"123");});go.countDown();
			assertThat(a.get(20,TimeUnit.SECONDS)+b.get(20,TimeUnit.SECONDS)).isEqualTo(1);
		}
		assertThat(count("notification_deliveries")).isEqualTo(1);var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		jdbc.execute("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second'");assertThat(queue.recoverExpiredLeases()).isEqualTo(1);assertThat(status()).isEqualTo("unknown");
		assertThat(queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(99))).isFalse();assertThat(queue.claimSupported(1,Duration.ofSeconds(30),"123")).isEmpty();assertThat(count("bot_messages")).isEqualTo(1);
	}
}
