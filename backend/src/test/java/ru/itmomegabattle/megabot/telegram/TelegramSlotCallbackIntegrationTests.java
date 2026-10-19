package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import java.time.*;
import java.nio.file.*;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.availability.TelegramSlotDraftService;
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@SpringBootTest @Import(TestcontainersConfiguration.class) @ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TelegramSlotCallbackIntegrationTests {
    @Autowired TelegramInbox inbox;@Autowired TelegramCommandWorker commands;@Autowired TelegramReplyPlanner planner;
    @Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
    @Autowired TelegramSlotDraftService slots;
    @Autowired PostgreSQLContainer postgres;
    @Autowired org.springframework.web.context.WebApplicationContext web;
    @Autowired ru.itmomegabattle.megabot.auth.SessionService sessions;
    @Autowired ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner meetingNotifications;
    @TempDir Path temporary;
    String draft,data;AtomicInteger edits,acks;AtomicReference<String> ackText;
    @BeforeEach void prepare() {
        jdbc.execute("truncate users,app_settings,telegram_inbox,telegram_callback_effects,outbox_events,bot_messages,chat_bindings,delivery_rate_limits cascade");
        jdbc.execute("insert into users(id,telegram_id,username,real_name,role,registered) values ('member',42,'alice','Owner','organizer',true)");
        edits=new AtomicInteger();acks=new AtomicInteger();ackText=new AtomicReference<>();
        inbox.accept("123",json.writeValueAsBytes(Map.of("update_id",1,"message",Map.of("message_id",2,"date",Instant.now().getEpochSecond(),
                "chat",Map.of("id",42,"type","private"),"from",Map.of("id",42,"is_bot",false,"first_name","Owner","username","alice"),"text","Слоты"))));
        commands.processOne("123");assertThat(sender(transport(false)).dispatchOne()).isTrue();
        draft=jdbc.queryForObject("select payload->>'slotDraftId' from outbox_events",String.class);data="sl:"+draft+":0:e";
    }
    TelegramTransport transport(boolean unknownEdit) {
        return new TelegramTransport() {
            public Outcome send(Message m) {assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();return Outcome.sent(11);}
            public Outcome edit(Edit e) {assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();edits.incrementAndGet();
                assertThat(e.messageId()).isEqualTo(11);assertThat(e.chatId()).isEqualTo(42);assertThat(e.text()).isNotBlank();
                return unknownEdit?Outcome.unknown("lost_response"):Outcome.sent(11);}
            public Outcome acknowledge(Acknowledgement a) {assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();acks.incrementAndGet();ackText.set(a.text());return Outcome.acknowledged();}
        };
    }
    BroadcastDispatcher sender(TelegramTransport transport) {
        return new BroadcastDispatcher(queue,quota,transport,json,"123",new DeliveryQuota.Limits(20,1,20),null,null,Clock.systemUTC(),null,null,null,null,planner);
    }
    ObjectNode callback(long update,String callbackId,String action) {
        return (ObjectNode)json.valueToTree(Map.of("update_id",update,"callback_query",Map.of("id",callbackId,"chat_instance","private-instance",
                "data",action,"from",Map.of("id",42,"is_bot",false),"message",Map.of("message_id",11,"date",Instant.now().getEpochSecond(),
                        "chat",Map.of("id",42,"type","private"),"from",Map.of("id",123,"is_bot",true)))));
    }
    void apply(ObjectNode update) {inbox.accept("123",json.writeValueAsBytes(update));assertThat(commands.processOne("123")).isTrue();}
    long revision() {return jdbc.queryForObject("select revision from telegram_slot_drafts where status='open'",Long.class);}
    int count(String table) {return jdbc.queryForObject("select count(*) from "+table,Integer.class);}
    void drain(boolean unknownEdit) {
        for(int n=0;n<2;n++) {jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(unknownEdit)).dispatchOne()).isTrue();}
    }
    @Test void rootCallbackAtomicallyQueuesAckAndEditAndBindsConfirmedNewRevision() {
        apply(callback(2,"callback-1",data));assertThat(revision()).isEqualTo(1);assertThat(count("outbox_events")).isEqualTo(3);
        assertThat(count("telegram_callback_effects")).isEqualTo(1);assertThat(count("availability_weeks")).isZero();
        assertThat(jdbc.queryForObject("select panel->>'text' from telegram_slot_drafts",String.class)).contains("Выбери неделю");
        assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,1)).isInstanceOf(RuntimeException.class);
        drain(false);assertThat(acks.get()).isEqualTo(1);assertThat(edits.get()).isEqualTo(1);assertThat(ackText.get()).isEmpty();
        assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries where payload->>'operation'='ack'",Long.class)).isNull();
        assertThat(jdbc.queryForObject("select status from notification_deliveries where payload->>'operation'='ack'",String.class)).isEqualTo("sent");
        assertThatCode(()->slots.requireConfirmedPanel("123",42,11,draft,1)).doesNotThrowAnyException();
        assertThat(count("bot_messages")).isEqualTo(3);
        apply(callback(3,"callback-1",data));assertThat(revision()).isEqualTo(1);assertThat(count("outbox_events")).isEqualTo(3);
        assertThat(jdbc.queryForObject("select last_error from telegram_inbox where update_id=3",String.class)).isEqualTo("duplicate_callback");
        apply(callback(4,"callback-2",data));assertThat(count("outbox_events")).isEqualTo(4);assertThat(revision()).isEqualTo(1);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();assertThat(ackText.get()).contains("устарел");assertThat(edits.get()).isEqualTo(1);
        // Current revision and confirmed message are insufficient: this action was not offered by the week picker.
        apply(callback(5,"not-offered",data.replace(":0:e",":1:e")));
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();
        assertThat(revision()).isEqualTo(1);assertThat(edits.get()).isEqualTo(1);assertThat(ackText.get()).contains("устарел");
    }
    @Test void datedWeekNavigationKeepsOneEditorAndRequiresConfirmation() {
        apply(callback(2,"picker",data));drain(false);
        var panel=json.readTree(jdbc.queryForObject("select panel::text from telegram_slot_drafts where status='open'",String.class));
        var week=panel.path("markup").path("inline_keyboard").get(0).get(0).path("callback_data").asText();
        assertThat(week).matches(".*:w[0-9]{8}");
        apply(callback(3,"week",week));assertThat(revision()).isEqualTo(2);
        var back="sl:"+draft+":2:b";
        assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,2)).isInstanceOf(RuntimeException.class);
        drain(false);
        apply(callback(4,"back",back));assertThat(revision()).isEqualTo(3);drain(false);
        assertThat(count("telegram_slot_drafts")).isEqualTo(1);assertThat(count("availability_weeks")).isZero();
        apply(callback(5,"stale-week",week));assertThat(revision()).isEqualTo(3);
    }
    @Test void weekSelectionRollbackKeepsOriginalWeekAndConfirmedPicker() {
        apply(callback(2,"picker",data));drain(false);
        var original=jdbc.queryForObject("select week_start::text from telegram_slot_drafts",String.class);
        var panel=json.readTree(jdbc.queryForObject("select panel::text from telegram_slot_drafts where status='open'",String.class));
        var week=panel.path("markup").path("inline_keyboard").get(1).get(0).path("callback_data").asText();
        jdbc.execute("alter table outbox_events add constraint reject_week_edit check(payload->>'operation'<>'edit') not valid");
        try {
            apply(callback(3,"week-retry",week));assertThat(revision()).isEqualTo(1);
            assertThat(jdbc.queryForObject("select week_start::text from telegram_slot_drafts",String.class)).isEqualTo(original);
            assertThat(jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class)).isEqualTo("{}");
        } finally {jdbc.execute("alter table outbox_events drop constraint reject_week_edit");}
        jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=3");
        assertThat(commands.processOne("123")).isTrue();assertThat(revision()).isEqualTo(2);drain(false);
        assertThat(jdbc.queryForObject("select week_start::text from telegram_slot_drafts",String.class)).isNotEqualTo(original);
        assertThat(count("availability_weeks")).isZero();
    }
    @Test void unofferedDatedWeekOnlyAcknowledgesWithoutChangingDraft() {
        apply(callback(2,"picker",data));drain(false);
        apply(callback(3,"unoffered-week","sl:"+draft+":1:w20990105"));
        assertThat(revision()).isEqualTo(1);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();
        assertThat(ackText.get()).isNotEmpty();assertThat(edits.get()).isEqualTo(1);
    }
    String offered(String prefix) {
        var panel=json.readTree(jdbc.queryForObject("select panel::text from telegram_slot_drafts where status='open'",String.class));
        for(var row:panel.path("markup").path("inline_keyboard"))for(var button:row) {
            var token=button.path("callback_data").asText();
            if(token.substring(token.lastIndexOf(':')+1).startsWith(prefix))return token;
        }
        throw new AssertionError("Missing offered action "+prefix);
    }
    String enterWeek() {
        apply(callback(2,"picker",data));drain(false);
        apply(callback(3,"week",offered("w")));drain(false);
        return offered("d");
    }
    @Test void legacyNodeSlotAndRsvpButtonsOnlyAcknowledgeAndNeverChangeCurrentEditor() {
        var actions=java.util.List.of("slot_edit","slot_week:0","slot_week:4","slots_day:0","slots_day:34","slot_toggle:34:23",
                "slot_toggle:0:0","slot_toggle_day:34","slot_unavailable:0","slot_cancel_day:34","slot_out_week:4",
                "slot_save_day:34","slot_save_week:4","meeting_rsvp:mtg_legacy:yes","meeting_rsvp:mtg_legacy:no","meeting_rsvp:mtg_legacy:unanswered");
        int before=count("outbox_events");var saved=jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class);
        for(int n=0;n<actions.size();n++) {
            apply(callback(n+2,"legacy-"+n,actions.get(n)));jdbc.execute("truncate delivery_rate_limits");
            assertThat(sender(transport(false)).dispatchOne()).isTrue();assertThat(ackText.get()).isEqualTo("Кнопка устарела. Откройте раздел заново через меню.");
        }
        assertThat(revision()).isZero();assertThat(count("availability_weeks")).isZero();assertThat(edits.get()).isZero();
        assertThat(jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class)).isEqualTo(saved);
        assertThat(count("outbox_events")).isEqualTo(before+actions.size());assertThat(count("telegram_callback_effects")).isEqualTo(actions.size());
        apply(callback(100,"legacy-0","slot_edit"));assertThat(count("outbox_events")).isEqualTo(before+actions.size());
        assertThat(count("bot_messages")).isEqualTo(2); // Ack never invents a bot history message.
    }
    @Test void legacyClassificationDoesNotWeakenPrivateEnvelopeOrAcceptLookalikes() {
        for(var action:java.util.List.of("slot_edit:extra","slot_week:5","slot_toggle:34:24","slots_day:35",
                "meeting_rsvp:id:maybe","meeting_rsvp::yes","meeting_rsvp:"+"😀".repeat(20)+":yes","nav_tasks"))
            assertThat(TelegramMeetingCallbackHandler.legacy(callback(2,"bad",action))).as(action).isFalse();
        for(int branch=0;branch<3;branch++) {
            prepare();var update=callback(2,"invalid-legacy","slot_edit");var message=(ObjectNode)update.path("callback_query").path("message");
            if(branch==0)((ObjectNode)message.path("from")).put("id",999);
            else if(branch==1)((ObjectNode)message.path("chat")).put("type","group");
            else message.put("forward_origin","foreign");
            apply(update);assertThat(count("outbox_events")).isEqualTo(1);assertThat(count("telegram_callback_effects")).isZero();assertThat(revision()).isZero();
        }
    }
    void enqueueCallback(long update,String action) {
        inbox.accept("123",json.writeValueAsBytes(callback(update,"process-"+update,offered(action))));
    }
    /** Existing crash-harness pattern; only JVMs created here and the disposable DB are touched. */
    void slotChild(String mode) throws Exception {
        var log=temporary.resolve(java.util.UUID.randomUUID()+".log");var args=temporary.resolve(java.util.UUID.randomUUID()+".args");
        var classpath=System.getProperty("surefire.test.class.path",System.getProperty("java.class.path"));
        Files.writeString(args,"-cp\n\""+classpath.replace("\\","\\\\").replace("\"","\\\"")+"\"\n");
        var javaExecutable=Path.of(System.getProperty("java.home"),"bin",System.getProperty("os.name").startsWith("Windows")?"java.exe":"java");
        var builder=new ProcessBuilder(javaExecutable.toString(),"-Xmx256m","@"+args,SlotWorkerProcess.class.getName(),mode,
                "--spring.datasource.url="+postgres.getJdbcUrl(),"--spring.datasource.username="+postgres.getUsername(),"--spring.datasource.password="+postgres.getPassword());
        builder.environment().keySet().removeIf(key->!java.util.Set.of("SystemRoot","WINDIR","TEMP","TMP","PATH").contains(key));
        var process=builder.redirectErrorStream(true).redirectOutput(log.toFile()).start();
        try {
            long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(90);
            String output="";
            while(process.isAlive() && !(output=Files.readString(log)).contains("SLOT_READY") && System.nanoTime()<deadline)Thread.sleep(50);
            assertThat(Files.readString(log)).as("child reached slot barrier: %s",output).contains("SLOT_READY");
            if(!mode.equals("resume")) {process.destroyForcibly();assertThat(process.waitFor(10,java.util.concurrent.TimeUnit.SECONDS)).isTrue();assertThat(process.exitValue()).isNotZero();}
            else {assertThat(process.waitFor(10,java.util.concurrent.TimeUnit.SECONDS)).isTrue();assertThat(process.exitValue()).isZero();}
        } finally {if(process.isAlive()){process.destroyForcibly();process.waitFor(10,java.util.concurrent.TimeUnit.SECONDS);}}
    }
    @Test @Timeout(240) void killedJvmAfterCommitKeepsBaselineParkedWeekAndConfirmsReplyOnlyAfterRestart() throws Exception {
        enterDay();var first=jdbc.queryForObject("select week_start from telegram_slot_drafts",java.sql.Date.class).toLocalDate();
        press(5,"h17");press(6,"w");press(7,"b");press(8,"w"+first.plusDays(7).format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE));press(9,"d");
        var baseline=jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class);
        var parked=jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class);var before=revision();
        enqueueCallback(10,"h18");slotChild("after_commit");
        assertThat(revision()).isEqualTo(before+1);assertThat(pending()).contains("1080");
        assertThat(jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class)).isEqualTo(baseline);
        assertThat(jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class)).isEqualTo(parked);
        assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=10",String.class)).isEqualTo("completed");
        assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,revision())).isInstanceOf(RuntimeException.class);
        drain(false);assertThatCode(()->slots.requireConfirmedPanel("123",42,11,draft,revision())).doesNotThrowAnyException();
        enqueueCallback(11,"c");slotChild("resume");drain(false);assertThat(pending()).doesNotContain("1080");
        press(12,"b");press(13,"w"+first.format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE));press(14,"d");
        assertThat(jdbc.queryForObject("select panel->>'text' from telegram_slot_drafts",String.class)).contains("17:00");
        assertThat(count("availability_weeks")).isZero();press(15,"s");
        assertThat(jdbc.queryForObject("select week_start from availability_weeks",java.sql.Date.class).toLocalDate()).isEqualTo(first);
        assertThat(jdbc.queryForObject("select start_minute from availability_slots",Integer.class)).isEqualTo(1020);
    }
    @Test @Timeout(240) void killedJvmBeforeInboxCommitRollsBackSlotEffectAndColdRestartAppliesExactlyOnce() throws Exception {
        enterDay();var before=revision();var payload=pending();var outbox=count("outbox_events");var effects=count("telegram_callback_effects");
        var baseline=jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class);
        enqueueCallback(5,"h17");slotChild("before_commit");
        assertThat(revision()).isEqualTo(before);assertThat(pending()).isEqualTo(payload);
        assertThat(count("outbox_events")).isEqualTo(outbox);assertThat(count("telegram_callback_effects")).isEqualTo(effects);
        assertThat(jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class)).isEqualTo(baseline);
        assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=5",String.class)).isEqualTo("processing");
        jdbc.execute("update telegram_inbox set leased_until=clock_timestamp()-interval '1 second' where update_id=5");slotChild("resume");
        assertThat(revision()).isEqualTo(before+1);assertThat(pending()).contains("1020");
        assertThat(count("outbox_events")).isEqualTo(outbox+2);assertThat(count("telegram_callback_effects")).isEqualTo(effects+1);
        assertThat(jdbc.queryForObject("select attempts from telegram_inbox where update_id=5",Integer.class)).isEqualTo(2);
        drain(false);press(6,"s");assertThat(jdbc.queryForObject("select start_minute from availability_slots",Integer.class)).isEqualTo(1020);
    }
    @Test @Timeout(240) void actualRsvpJvmKillBeforeAndAfterCommitRecoversOneResponseAndSelectedEdit() throws Exception {
        for(var mode:java.util.List.of("before_commit","after_commit")) {
            prepare();
            var mvc=org.springframework.test.web.servlet.setup.MockMvcBuilders.webAppContextSetup(web)
                    .apply(org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity()).build();
            var request=Map.of("title","Restart RSVP","kind","meeting","date",LocalDate.now(ZoneId.of("Europe/Moscow")).plusDays(1).toString(),
                    "time","12:00","durationMinutes",60,"audienceMode","selected","selectedUserIds",java.util.List.of("member"),"expectedVersion",0);
            var result=mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/v1/meetings")
                    .cookie(new jakarta.servlet.http.Cookie("megabot_session",sessions.rotateFor("member").rawToken()))
                    .header("Origin","http://localhost").header("Idempotency-Key","restart-rsvp-"+mode)
                    .contentType(org.springframework.http.MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
                    .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isCreated()).andReturn();
            var meeting=json.readTree(result.getResponse().getContentAsString()).path("id").asText();
            meetingNotifications.materialize(20,"123");jdbc.execute("truncate delivery_rate_limits");
            assertThat(sender(m->TelegramTransport.Outcome.sent(12)).dispatchOne()).isTrue();
            var action=jdbc.queryForObject("select payload->'replyMarkup'->'inline_keyboard'->0->0->>'callback_data' from notification_deliveries where category='meeting_event'",String.class);
            var update=callback(9,"restart-rsvp",action);((ObjectNode)update.path("callback_query").path("message")).put("message_id",12);
            inbox.accept("123",json.writeValueAsBytes(update));var before=count("outbox_events");slotChild(mode);
            if(mode.equals("before_commit")) {
                assertThat(jdbc.queryForObject("select rsvp from meeting_invitations where meeting_id=?",String.class,meeting)).isEqualTo("unanswered");
                assertThat(count("telegram_callback_effects")).isZero();assertThat(count("outbox_events")).isEqualTo(before);
                assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_type='meeting_rsvp'",Integer.class)).isZero();
                jdbc.execute("update telegram_inbox set leased_until=clock_timestamp()-interval '1 second' where update_id=9");
            } else {
                assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=9",String.class)).isEqualTo("completed");
                assertThat(count("outbox_events")).isEqualTo(before+2);
                update.put("update_id",10);inbox.accept("123",json.writeValueAsBytes(update));
            }
            slotChild("resume");
            assertThat(jdbc.queryForObject("select rsvp from meeting_invitations where meeting_id=?",String.class,meeting)).isEqualTo("yes");
            assertThat(count("telegram_callback_effects")).isEqualTo(1);assertThat(count("outbox_events")).isEqualTo(before+2);
            assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_type='meeting_rsvp'",Integer.class)).isEqualTo(1);
            var seen=new AtomicInteger();var transport=new TelegramTransport(){
                public Outcome send(Message m){throw new AssertionError("restart must not create another SEND");}
                public Outcome acknowledge(Acknowledgement a){assertThat(a.text()).isEqualTo("Отметил: вы придёте");return Outcome.acknowledged();}
                public Outcome edit(Edit e){assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(e.messageId()).isEqualTo(12);
                    assertThat(e.keyboard().rows().getFirst().getFirst().text()).isEqualTo("✅ Приду");seen.incrementAndGet();return Outcome.sent(12);}
            };
            for(int n=0;n<3;n++){jdbc.execute("truncate delivery_rate_limits");sender(transport).dispatchOne();}
            assertThat(seen.get()).isEqualTo(1);
        }
    }
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
    ObjectNode meetingInput(long update,String text) {
        var value=(ObjectNode)json.valueToTree(Map.of("update_id",update,"message",Map.of("message_id",update+1,"date",Instant.now().getEpochSecond(),
                "chat",Map.of("id",42,"type","private"),"from",Map.of("id",42,"is_bot",false,"first_name","Owner","username","alice"),"text",text)));
        replyToCurrentOffer(value);return value;
    }
    ObjectNode pendingMeetingInput;
    String prepareMeetingTime() {
        jdbc.execute("truncate audit_events,integration_jobs");
        long update=2;
        for(var text:java.util.List.of("Назначить собрание","Собрать всю команду","Тема после рестарта","Описание после рестарта","29.02.2400")) {
            apply(meetingInput(update,text));long provider=10+update++;var sends=new AtomicInteger();
            var worker=sender(new TelegramTransport() {
                public Outcome send(Message m) {assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();sends.incrementAndGet();return Outcome.sent(provider);}
                public Outcome delete(Deletion d) {assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();assertThat(d.messageId()).isEqualTo(11);return Outcome.acknowledged();}
            });
            // The initial slot panel also queues its normal guarded cleanup when the meeting prompt replaces it.
            for(int attempt=0;attempt<3;attempt++){jdbc.execute("truncate delivery_rate_limits");if(!worker.dispatchOne())break;}
            assertThat(sends).hasValue(1);
        }
        var id=jdbc.queryForObject("select id from telegram_meeting_drafts",String.class);
        assertThat(jdbc.queryForObject("select step from telegram_meeting_drafts",String.class)).isEqualTo("time");
        pendingMeetingInput=meetingInput(7,"2:17");
        inbox.accept("123",json.writeValueAsBytes(pendingMeetingInput));
        return id;
    }
    void assertRestartedMeetingAndOneReply(String id,int before) {
        assertThat(jdbc.queryForObject("select status from telegram_meeting_drafts where id=?",String.class,id)).isEqualTo("completed");
        assertThat(jdbc.queryForObject("select revision from telegram_meeting_drafts where id=?",Long.class,id)).isEqualTo(5);
        var meeting=jdbc.queryForObject("select meeting_id from telegram_meeting_drafts where id=?",String.class,id);
        assertThat(count("meetings")).isEqualTo(1);assertThat(count("meeting_invitations")).isEqualTo(1);
        assertThat(count("audit_events")).isEqualTo(1);assertThat(count("integration_jobs")).isEqualTo(1);assertThat(count("outbox_events")).isEqualTo(before+3);
        assertThat(jdbc.queryForObject("select topic from meetings where id=?",String.class,meeting)).isEqualTo("Тема после рестарта");
        assertThat(jdbc.queryForObject("select description from meetings where id=?",String.class,meeting)).isEqualTo("Описание после рестарта");
        assertThat(jdbc.queryForObject("select (starts_at at time zone 'Europe/Moscow')::text from meetings where id=?",String.class,meeting)).startsWith("2400-02-29 02:17");
        assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where payload->>'meetingInput'='2:17'",Integer.class)).isZero();
        var calls=new AtomicInteger();var worker=sender(m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(m.text()).isEqualTo("Собрание назначено.\n29.02.2400, 02:17 (МСК).");calls.incrementAndGet();return TelegramTransport.Outcome.sent(17);});
        jdbc.execute("truncate delivery_rate_limits");assertThat(worker.dispatchOne()).isTrue();
        jdbc.execute("truncate delivery_rate_limits");assertThat(worker.dispatchOne()).isFalse();assertThat(calls).hasValue(1);
        assertThat(jdbc.queryForObject("select count(*) from bot_messages where sender='bot' and text like 'Собрание назначено.%'",Integer.class)).isEqualTo(1);
    }
    @Test @Timeout(240) void meetingJvmKilledBeforeCommitRollsBackDomainAndColdRestartCreatesExactlyOnce() throws Exception {
        var id=prepareMeetingTime();var before=count("outbox_events");var history=count("bot_messages");
        var snapshot=jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s where id=?",String.class,id);
        slotChild("before_commit");
        assertThat(jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s where id=?",String.class,id)).isEqualTo(snapshot);
        assertThat(count("meetings")).isZero();assertThat(count("meeting_invitations")).isZero();assertThat(count("audit_events")).isZero();assertThat(count("integration_jobs")).isZero();
        assertThat(count("outbox_events")).isEqualTo(before);assertThat(count("bot_messages")).isEqualTo(history);
        assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=7",String.class)).isEqualTo("processing");
        jdbc.execute("update telegram_inbox set leased_until=clock_timestamp()-interval '1 second' where update_id=7");slotChild("resume");
        assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=7",String.class)).isEqualTo("completed");
        assertThat(jdbc.queryForObject("select attempts from telegram_inbox where update_id=7",Integer.class)).isEqualTo(2);
        inbox.accept("123",json.writeValueAsBytes(pendingMeetingInput));assertThat(commands.processOne("123")).isFalse();
        assertRestartedMeetingAndOneReply(id,before);
    }
    @Test @Timeout(240) void meetingJvmKilledAfterCommitKeepsOneCreationAndRejectsRepeatedTimeAfterColdRestart() throws Exception {
        var id=prepareMeetingTime();var before=count("outbox_events");slotChild("after_commit");
        assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=7",String.class)).isEqualTo("completed");
        assertThat(jdbc.queryForObject("select attempts from telegram_inbox where update_id=7",Integer.class)).isEqualTo(1);
        var committed=jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s where id=?",String.class,id);
        inbox.accept("123",json.writeValueAsBytes(pendingMeetingInput));assertThat(commands.processOne("123")).isFalse();
        inbox.accept("123",json.writeValueAsBytes(meetingInput(8,"2:17")));slotChild("resume");
        assertThat(jdbc.queryForObject("select last_error from telegram_inbox where update_id=8",String.class)).isEqualTo("unsupported_command");
        assertThat(jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s where id=?",String.class,id)).isEqualTo(committed);
        assertRestartedMeetingAndOneReply(id,before);
    }
    public static class SlotWorkerProcess {
        public static void main(String[] args) throws Exception {
            var properties=new java.util.ArrayList<>(java.util.Arrays.asList(args).subList(1,args.length));
            properties.addAll(java.util.List.of("--spring.profiles.active=test","--server.port=0","--server.address=127.0.0.1",
                    "--megabot.delivery.enabled=false","--megabot.integrations.telegram.mode=fake","--megabot.integrations.google.mode=fake",
                    "--megabot.auth.telegram.bot-token=","--spring.datasource.hikari.maximum-pool-size=2","--logging.level.root=WARN"));
            try(var context=org.springframework.boot.SpringApplication.run(ru.itmomegabattle.megabot.MegaBotApplication.class,properties.toArray(String[]::new))) {
                if(args[0].equals("before_commit")) {
                    var queue=context.getBean(TelegramInboxQueue.class);var lease=queue.claim("123",1,Duration.ofSeconds(30)).getFirst();
                    queue.apply(lease.id(),lease.token(),current->{context.getBean(TelegramPrivateCommandHandler.class).handle(current);barrier();});
                } else {
                    if(!context.getBean(TelegramCommandWorker.class).processOne("123"))throw new IllegalStateException("missing_slot_work");
                    if(args[0].equals("resume")){System.out.println("SLOT_READY");System.out.flush();}else barrier();
                }
            }
        }
        static void barrier() {
            System.out.println("SLOT_READY");System.out.flush();
            try {System.in.read();}catch(java.io.IOException failure){throw new IllegalStateException(failure);}
        }
    }
    void pendingDays(LocalDate date,int minutes,boolean neighbour) {
        var payload=(ObjectNode)json.readTree(jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class));
        var days=payload.putArray("days");days.add(json.valueToTree(Map.of("date",date.toString(),"status","available","startMinutes",java.util.List.of(minutes))));
        if(neighbour)days.add(json.valueToTree(Map.of("date",date.plusDays(1).toString(),"status","unavailable","startMinutes",java.util.List.of())));
        jdbc.update("update telegram_slot_drafts set payload=cast(? as jsonb)",json.writeValueAsString(payload));
    }
    @Test void dayCancelRestoresPendingEntryAndKeepsNeighbourDeadlineAndOtherWeeks() {
        var day=enterWeek();var date=LocalDate.parse(day.substring(day.lastIndexOf(':')+2),java.time.format.DateTimeFormatter.BASIC_ISO_DATE);
        pendingDays(date,1020,false);
        var deadline=jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class);
        var parked=jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class);
        apply(callback(4,"day",day));assertThat(revision()).isEqualTo(3);
        assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,3)).isInstanceOf(RuntimeException.class);
        drain(false);pendingDays(date,1080,true);
        var cancel=offered("c");apply(callback(5,"cancel",cancel));assertThat(revision()).isEqualTo(4);drain(false);
        var payload=json.readTree(jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class));
        assertThat(payload.path("days").toString()).contains("1020","unavailable").doesNotContain("1080");
        assertThat(jdbc.queryForObject("select day_baseline is null from telegram_slot_drafts",Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class)).isEqualTo(deadline);
        assertThat(jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class)).isEqualTo(parked);
        assertThat(count("availability_weeks")).isZero();
        apply(callback(6,"cancel",cancel));assertThat(revision()).isEqualTo(4);
        apply(callback(7,"stale-cancel",cancel));assertThat(revision()).isEqualTo(4);
    }
    @Test void dayEntryAndCancelOutboxFailuresRollBackBaselinePayloadAndJournal() {
        var day=enterWeek();
        for(int step=0;step<2;step++) {
            var token=step==0?day:offered("c");var update=4+step;var before=revision();
            var baseline=jdbc.queryForObject("select coalesce(day_baseline::text,'null') from telegram_slot_drafts",String.class);
            var payload=jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class);
            var effects=count("telegram_callback_effects");var outbox=count("outbox_events");
            jdbc.execute("alter table outbox_events add constraint reject_day_edit check(payload->>'operation'<>'edit') not valid");
            try {
                apply(callback(update,"day-retry-"+step,token));assertThat(revision()).isEqualTo(before);
                assertThat(jdbc.queryForObject("select coalesce(day_baseline::text,'null') from telegram_slot_drafts",String.class)).isEqualTo(baseline);
                assertThat(jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class)).isEqualTo(payload);
                assertThat(count("telegram_callback_effects")).isEqualTo(effects);assertThat(count("outbox_events")).isEqualTo(outbox);
            } finally {jdbc.execute("alter table outbox_events drop constraint reject_day_edit");}
            jdbc.update("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=?",update);
            assertThat(commands.processOne("123")).isTrue();assertThat(revision()).isEqualTo(before+1);drain(false);
        }
    }
    @Test void returningToWeekKeepsPendingDayAndClearsEntryBaseline() {
        var day=enterWeek();var date=LocalDate.parse(day.substring(day.lastIndexOf(':')+2),java.time.format.DateTimeFormatter.BASIC_ISO_DATE);
        apply(callback(4,"day",day));drain(false);pendingDays(date,1020,false);
        apply(callback(5,"back-week",offered("w")));drain(false);
        assertThat(jdbc.queryForObject("select day_baseline is null from telegram_slot_drafts",Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class)).contains("1020");
        apply(callback(6,"reenter",offered("d")));drain(false);pendingDays(date,1080,false);
        apply(callback(7,"cancel",offered("c")));drain(false);
        assertThat(jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class)).contains("1020").doesNotContain("1080");
    }
    @Test void unofferedDayAndCancelOnlyAcknowledgeAndUnknownDayNeverAuthorizesCancel() {
        var day=enterWeek();var before=revision();
        apply(callback(4,"fake-day","sl:"+draft+":"+before+":d20990105"));
        apply(callback(5,"fake-cancel","sl:"+draft+":"+before+":c"));
        assertThat(revision()).isEqualTo(before);
        for(int n=0;n<2;n++){jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();}
        apply(callback(6,"day",day));drain(true);
        var entered=revision();apply(callback(7,"unknown-cancel",offered("c")));
        assertThat(revision()).isEqualTo(entered);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();
        assertThat(ackText.get()).isNotEmpty();assertThat(count("availability_weeks")).isZero();
    }
    void press(long update,String action) {
        apply(callback(update,"press-"+update,offered(action)));drain(false);
    }
    void enterDay() {var day=enterWeek();apply(callback(4,"day",day));drain(false);}
    String pending() {return jdbc.queryForObject("select payload::text from telegram_slot_drafts",String.class);}
    @Test void hourTogglesAreSortedTriStateAndDuplicateOrUnofferedClicksDoNotMutate() {
        enterDay();var baseline=jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class);
        var first=offered("h17");apply(callback(5,"hour-once",first));drain(false);
        var revision=revision();apply(callback(6,"hour-once",first));assertThat(revision()).isEqualTo(revision);
        press(7,"h18");press(8,"h17");assertThat(pending()).contains("1080").doesNotContain("1020");
        press(9,"h18");assertThat(pending()).contains("unanswered").doesNotContain("available");
        assertThat(jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class)).isEqualTo(baseline);
        revision=revision();apply(callback(10,"hidden-hour","sl:"+draft+":"+revision+":h0"));
        assertThat(revision()).isEqualTo(revision);assertThat(count("availability_weeks")).isZero();
    }
    @Test void fullDayAndUnavailableTogglesPreserveOriginalCancelBaseline() {
        enterDay();press(5,"a");
        assertThat(json.readTree(pending()).path("days").get(0).path("startMinutes").size()).isEqualTo(7);
        press(6,"a");assertThat(pending()).contains("unanswered");
        press(7,"u");assertThat(pending()).contains("unavailable");
        press(8,"u");assertThat(pending()).contains("unanswered");
        press(9,"u");press(10,"h17");assertThat(pending()).contains("available","1020").doesNotContain("unavailable");
        press(11,"c");assertThat(json.readTree(pending()).path("days").size()).isZero();
        assertThat(count("availability_weeks")).isZero();
    }
    @Test void saveDayOnlyPublishesSelectedDateThenSaveWeekPublishesPendingNeighbour() {
        enterDay();press(5,"h17");var selected=json.readTree(pending()).path("days").get(0).path("date").asText();
        var date=LocalDate.parse(selected);pendingDays(date,1020,true);
        press(6,"s");assertThat(count("availability_days")).isEqualTo(1);assertThat(count("availability_slots")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select day_date::text from availability_days",String.class)).isEqualTo(selected);
        assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(1);
        assertThat(pending()).contains("unavailable");assertThat(jdbc.queryForObject("select day_baseline is null from telegram_slot_drafts",Boolean.class)).isTrue();
        var save=offered("v");apply(callback(7,"save-week",save));drain(false);
        assertThat(count("availability_days")).isEqualTo(2);assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(2);
        apply(callback(8,"save-week",save));assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(2);
    }
    @Test void weekOutToggleClearsOnlySelectedWeekAndSaveRetainsOtherPendingWeek() {
        enterDay();press(5,"h17");press(6,"w");press(7,"b");
        var panel=json.readTree(jdbc.queryForObject("select panel::text from telegram_slot_drafts where status='open'",String.class));
        var second=panel.path("markup").path("inline_keyboard").get(1).get(0).path("callback_data").asText();
        apply(callback(8,"second-week",second));drain(false);press(9,"d");press(10,"h18");press(11,"w");
        var parked=jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class);
        press(12,"o");assertThat(json.readTree(pending()).path("outOfWeek").asBoolean()).isTrue();
        assertThat(json.readTree(pending()).path("days").size()).isZero();press(13,"v");
        assertThat(jdbc.queryForObject("select out_of_week from availability_weeks",Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class)).isEqualTo(parked);
        press(14,"o");assertThat(json.readTree(pending()).path("outOfWeek").asBoolean()).isFalse();press(15,"b");press(16,"w");
        assertThat(pending()).contains("1020");press(17,"v");assertThat(count("availability_weeks")).isEqualTo(2);
        assertThat(count("availability_slots")).isEqualTo(1);
    }
    @Test void saveOutboxFailureRollsBackAuthoritativeWeekAuditDraftAndCallbackEffects() {
        enterDay();press(5,"h17");
        for(int step=0;step<2;step++) {
            var action=offered(step==0?"s":"v");int update=6+step;var revision=revision();
            var before=pending();var audit=count("audit_events");var effects=count("telegram_callback_effects");
            var weeks=count("availability_weeks");var slots=count("availability_slots");
            jdbc.execute("alter table outbox_events add constraint reject_slot_save check(payload->>'operation'<>'edit') not valid");
            try {
                apply(callback(update,"save-retry-"+step,action));assertThat(revision()).isEqualTo(revision);assertThat(pending()).isEqualTo(before);
                assertThat(count("audit_events")).isEqualTo(audit);assertThat(count("telegram_callback_effects")).isEqualTo(effects);
                assertThat(count("availability_weeks")).isEqualTo(weeks);assertThat(count("availability_slots")).isEqualTo(slots);
            } finally {jdbc.execute("alter table outbox_events drop constraint reject_slot_save");}
            jdbc.update("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=?",update);
            assertThat(commands.processOne("123")).isTrue();drain(false);
            assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(step+1L);
        }
    }
    @Test void changedSettingsBlockOldHourButtonsAndUnknownEditBlocksSave() {
        enterDay();var hour=offered("h17");var revision=revision();
        jdbc.update("insert into app_settings(setting_key,setting_value,version) values ('availability',cast(? as jsonb),1)",
                "{\"weekCount\":4,\"activeDays\":[0,1,2,3,4],\"firstHour\":18,\"lastHour\":23}");
        apply(callback(5,"old-settings",hour));assertThat(revision()).isEqualTo(revision);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();
        assertThat(ackText.get()).isNotEmpty();jdbc.execute("delete from app_settings");
        apply(callback(6,"unknown-hour",hour));drain(true);revision=revision();
        apply(callback(7,"unconfirmed-save",offered("s")));assertThat(revision()).isEqualTo(revision);
        assertThat(count("availability_weeks")).isZero();
    }
    @Test void staleAuthoritativeWeekNeverGetsOverwrittenBySaveCallback() {
        enterDay();press(5,"h17");var revision=revision();
        jdbc.execute("insert into availability_weeks(id,user_id,week_start,version) select 'external-week',user_id,week_start,1 from telegram_slot_drafts");
        apply(callback(6,"stale-save",offered("s")));assertThat(revision()).isEqualTo(revision);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();assertThat(ackText.get()).isNotEmpty();
        assertThat(count("availability_slots")).isZero();assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(1);
    }
    @Test void configuredWeekendAndMidnightHoursRoundTripThroughButtonsAndSave() {
        jdbc.update("insert into app_settings(setting_key,setting_value,version) values ('availability',cast(? as jsonb),1)",
                "{\"weekCount\":5,\"activeDays\":[0,1,2,3,4,5,6],\"firstHour\":0,\"lastHour\":23}");
        inbox.accept("123",json.writeValueAsBytes(Map.of("update_id",20,"message",Map.of("message_id",21,"date",Instant.now().getEpochSecond(),
                "chat",Map.of("id",42,"type","private"),"from",Map.of("id",42,"is_bot",false,"first_name","Owner"),"text","Слоты"))));
        assertThat(commands.processOne("123")).isTrue();jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();
        draft=jdbc.queryForObject("select id from telegram_slot_drafts where status='open'",String.class);data="sl:"+draft+":0:e";
        enterWeek();var week=jdbc.queryForObject("select week_start::text from telegram_slot_drafts where status='open'",String.class);
        var sunday=LocalDate.parse(week).plusDays(6);
        apply(callback(4,"sunday","sl:"+draft+":2:d"+sunday.format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE)));drain(false);
        press(5,"h0");press(6,"h23");press(7,"s");
        assertThat(jdbc.queryForList("select start_minute from availability_slots order by start_minute",Integer.class)).containsExactly(0,1380);
        assertThat(jdbc.queryForObject("select day_date::text from availability_days",String.class)).isEqualTo(sunday.toString());
    }
    @Test void unknownSaveEditCannotReplayCommittedAvailabilityMutation() {
        enterDay();press(5,"h17");var save=offered("s");
        apply(callback(6,"saved-once",save));drain(true);
        assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(1);
        var revision=revision();apply(callback(7,"saved-once",save));apply(callback(8,"stale-save",save));
        assertThat(revision()).isEqualTo(revision);assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(1);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();
        assertThat(ackText.get()).isNotEmpty();jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isFalse();
    }
    @Test void expiryAfterAvailabilityWriteRollsBackSaveInsteadOfCommittingSafeAck() {
        enterDay();press(5,"h17");var save=offered("s");var revision=revision();var payload=pending();
        var outbox=count("outbox_events");var effects=count("telegram_callback_effects");var audit=count("audit_events");
        var deadline=jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class);
        jdbc.execute("""
                create function expire_slot_save_fixture() returns trigger language plpgsql as $$
                begin
                    if NEW.revision>OLD.revision then
                        NEW.created_at=clock_timestamp()-interval '20 minutes';
                        NEW.expires_at=clock_timestamp()-interval '1 second';
                    end if;
                    return NEW;
                end $$
                """);
        jdbc.execute("create trigger expire_slot_save before update on telegram_slot_drafts for each row execute function expire_slot_save_fixture()");
        try {apply(callback(6,"expired-save",save));}
        finally {jdbc.execute("drop trigger expire_slot_save on telegram_slot_drafts");jdbc.execute("drop function expire_slot_save_fixture()");}
        assertThat(revision()).isEqualTo(revision);assertThat(pending()).isEqualTo(payload);
        assertThat(count("availability_weeks")).isZero();assertThat(count("audit_events")).isEqualTo(audit);
        assertThat(count("outbox_events")).isEqualTo(outbox);assertThat(count("telegram_callback_effects")).isEqualTo(effects);
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class)).isEqualTo(deadline);
        jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=6");
        assertThat(commands.processOne("123")).isTrue();drain(false);assertThat(count("availability_weeks")).isEqualTo(1);
    }
    void navigate(long update,String text) {
        inbox.accept("123",json.writeValueAsBytes(Map.of("update_id",update,"message",Map.of("message_id",update+100,"date",Instant.now().getEpochSecond(),
                "chat",Map.of("id",42,"type","private"),"from",Map.of("id",42,"is_bot",false,"first_name","Owner"),"text",text))));
        assertThat(commands.processOne("123")).isTrue();
    }
    void sendNavigation() {
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();
    }
    TelegramTransport replacementTransport(TelegramTransport.Outcome outcome,AtomicInteger deletes) {
        return new TelegramTransport() {
            public Outcome send(Message m) {assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();return Outcome.sent(22);}
            public Outcome delete(Deletion d) {assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                assertThat(d.chatId()).isEqualTo(42);assertThat(d.messageId()).isEqualTo(11);deletes.incrementAndGet();return outcome;}
        };
    }
    String deletionStatus() {return jdbc.queryForObject("select status from notification_deliveries where category='telegram_panel_delete'",String.class);}
    void replacement(String command,AtomicInteger deletes) {
        navigate(50,command);jdbc.execute("truncate delivery_rate_limits");
        assertThat(sender(replacementTransport(TelegramTransport.Outcome.acknowledged(),deletes)).dispatchOne()).isTrue();
    }
    @Test void confirmedReplacementAtomicallyQueuesOnlyKnownOldSlotPanelAndDeletesOutsideTransaction() {
        enterDay();var deletes=new AtomicInteger();replacement("Назад",deletes);
        assertThat(deletionStatus()).isEqualTo("planned");assertThat(deletes.get()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where category='telegram_panel_delete'",Integer.class)).isEqualTo(1);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(replacementTransport(TelegramTransport.Outcome.acknowledged(),deletes)).dispatchOne()).isTrue();
        assertThat(deletionStatus()).isEqualTo("sent");assertThat(deletes.get()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries where category='telegram_panel_delete'",Long.class)).isNull();
        assertThat(jdbc.queryForObject("select count(*) from bot_messages where sender='bot' and text is null",Integer.class)).isZero();
        assertThatCode(()->slots.requireConfirmedPanel("123",42,22,draft,revision())).doesNotThrowAnyException();
    }
    @Test void replacementConfirmationAndDeleteIntentRollbackTogether() {
        var deletes=new AtomicInteger();navigate(50,"Меню");planner.materialize(20,"123");
        jdbc.execute("alter table notification_deliveries add constraint reject_panel_delete check(category<>'telegram_panel_delete') not valid");
        try {assertThatThrownBy(()->{jdbc.execute("truncate delivery_rate_limits");sender(replacementTransport(TelegramTransport.Outcome.acknowledged(),deletes)).dispatchOne();}).isInstanceOf(RuntimeException.class);}
        finally {jdbc.execute("alter table notification_deliveries drop constraint reject_panel_delete");}
        assertThat(jdbc.queryForObject("select status from notification_deliveries where payload->>'command'='menu'",String.class)).isEqualTo("sending");
        assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries where payload->>'command'='menu'",Long.class)).isNull();
        assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where category='telegram_panel_delete'",Integer.class)).isZero();
        assertThat(deletes.get()).isZero();
    }
    @Test void deleteUnknownRemainsUnknownAndDoesNotResendOrBlindlyRepeat() {
        var deletes=new AtomicInteger();replacement("Меню",deletes);jdbc.execute("truncate delivery_rate_limits");
        assertThat(sender(replacementTransport(TelegramTransport.Outcome.unknown("lost_delete_response"),deletes)).dispatchOne()).isTrue();
        assertThat(deletionStatus()).isEqualTo("unknown");
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(replacementTransport(TelegramTransport.Outcome.acknowledged(),deletes)).dispatchOne()).isFalse();
        assertThat(deletes.get()).isEqualTo(1);
    }
    @Test void cleanupChecksBotImmutableTargetAndOriginalRequestCutoff() {
        var deletes=new AtomicInteger();replacement("Меню",deletes);
        assertThat(queue.claimSupported(1,Duration.ofSeconds(30),"456")).isEmpty();
        jdbc.execute("update notification_deliveries set payload=jsonb_set(payload,'{targetMessageId}','999') where category='telegram_panel_delete'");
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(replacementTransport(TelegramTransport.Outcome.acknowledged(),deletes)).dispatchOne()).isTrue();
        assertThat(deletionStatus()).isEqualTo("cancelled");assertThat(deletes.get()).isZero();
        prepare();jdbc.execute("update notification_deliveries set request_started_at=clock_timestamp()-interval '47 hours 1 second' where payload->>'command'='slots'");
        replacement("Меню",deletes);assertThat(deletionStatus()).isEqualTo("expired");
        assertThat(sender(replacementTransport(TelegramTransport.Outcome.acknowledged(),deletes)).dispatchOne()).isFalse();assertThat(deletes.get()).isZero();
    }
    @Test void laterEditorRevisionCancelsCleanupAndUnknownReplacementCreatesNoIntent() {
        var deletes=new AtomicInteger();enterDay();replacement("Назад",deletes);
        jdbc.execute("update telegram_slot_drafts set revision=revision+1");
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(replacementTransport(TelegramTransport.Outcome.acknowledged(),deletes)).dispatchOne()).isTrue();
        assertThat(deletionStatus()).isEqualTo("cancelled");assertThat(deletes.get()).isZero();
        prepare();navigate(50,"Меню");jdbc.execute("truncate delivery_rate_limits");
        assertThat(sender(message->TelegramTransport.Outcome.unknown("lost_send_response")).dispatchOne()).isTrue();
        assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where category='telegram_panel_delete'",Integer.class)).isZero();
    }
    @Test void cleanupClaimRecoveryPreservesOneIntentAndRejectsDeadWorkerToken() throws Exception {
        var deletes=new AtomicInteger();replacement("Меню",deletes);
        var workers=java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var gate=new java.util.concurrent.CountDownLatch(1);
            var first=workers.submit(()->{gate.await();return queue.claimSupported(1,Duration.ofSeconds(30),"123");});
            var second=workers.submit(()->{gate.await();return queue.claimSupported(1,Duration.ofSeconds(30),"123");});gate.countDown();
            var leases=new java.util.ArrayList<>(first.get(15,java.util.concurrent.TimeUnit.SECONDS));leases.addAll(second.get(15,java.util.concurrent.TimeUnit.SECONDS));
            assertThat(leases).hasSize(1);var dead=leases.getFirst();
            jdbc.update("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second' where id=?",dead.id());
            assertThat(queue.recoverExpiredLeases()).isEqualTo(1);assertThat(queue.start(dead.id(),dead.token())).isFalse();
            var fresh=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(fresh.id(),fresh.token())).isTrue();
            jdbc.update("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second' where id=?",fresh.id());
            assertThat(queue.recoverExpiredLeases()).isEqualTo(1);assertThat(deletionStatus()).isEqualTo("unknown");
            assertThat(queue.claimSupported(1,Duration.ofSeconds(30),"123")).isEmpty();assertThat(deletes.get()).isZero();
        } finally {workers.shutdownNow();}
    }
    @Test void cleanupRepeatsCancelCutoffAndSourceChecksImmediatelyBeforeHttp() {
        for(var change:java.util.List.of("cancel","expiry","source")) {
            prepare();var deletes=new AtomicInteger();replacement("Меню",deletes);
            var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
            switch(change) {
                case "cancel"->queue.cancel(lease.id());
                case "expiry"->jdbc.update("update notification_deliveries set expires_at=intended_at where id=?",lease.id());
                case "source"->jdbc.execute("update notification_deliveries set payload=jsonb_set(payload,'{slotDraftId}','\"foreign\"') where payload->>'command'='slots'");
            }
            assertThat(queue.panelDeleteReadyForSending(lease.id(),lease.token(),"123")).isFalse();
            assertThat(deletionStatus()).isEqualTo("failed");assertThat(deletes.get()).isZero();
            assertThat(jdbc.queryForObject("select result_status from delivery_attempts where delivery_id=?",String.class,lease.id())).isEqualTo("failed");
        }
    }
    @Test void typedBackWalksDurableContextWithoutPublishingOrLosingPendingDay() {
        enterDay();press(5,"h17");var before=pending();var old=offered("h18");
        for(var step:java.util.List.of("Неделя ","Выбери неделю","Сохранённые слоты")) {
            navigate(10+revision(),"Назад");sendNavigation();
            assertThat(pending()).isEqualTo(before);assertThat(count("availability_weeks")).isZero();
            assertThat(jdbc.queryForObject("select panel->>'text' from telegram_slot_drafts",String.class)).contains(step);
            assertThatCode(()->slots.requireConfirmedPanel("123",42,11,draft,revision())).doesNotThrowAnyException();
        }
        // Returning to the picker from the summary reuses the editor, including its unsaved hours.
        press(20,"e");press(21,"w");press(22,"d");
        assertThat(jdbc.queryForObject("select panel->>'text' from telegram_slot_drafts",String.class)).contains("17:00");
        apply(callback(23,"old-before-back",old));sendNavigation();assertThat(ackText.get()).contains("устарел");
    }
    @Test void typedBackFromRootOrWithoutEditorReturnsOwnProfileAndFencesOldButtons() {
        navigate(2,"Назад");sendNavigation();
        assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("cancelled");
        assertThat(jdbc.queryForObject("select payload->>'text' from outbox_events where payload->>'command'='back'",String.class)).contains("Owner");
        navigate(3,"Назад");sendNavigation();assertThat(count("telegram_slot_drafts")).isEqualTo(1);
        apply(callback(4,"old-root",data));sendNavigation();assertThat(ackText.get()).contains("устарел");
    }
    @Test void typedBackRecoversUnknownPanelWithoutReplayingProviderEdit() {
        var day=enterWeek();apply(callback(4,"unknown-day",day));drain(true);var editsBefore=edits.get();
        assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,revision())).isInstanceOf(RuntimeException.class);
        navigate(5,"Назад");sendNavigation();
        assertThat(edits.get()).isEqualTo(editsBefore);
        assertThatCode(()->slots.requireConfirmedPanel("123",42,11,draft,revision())).doesNotThrowAnyException();
        assertThat(jdbc.queryForObject("select panel->>'text' from telegram_slot_drafts",String.class)).startsWith("Неделя ");
    }
    @Test void failedTypedBackReplyRollsBackRevisionBaselineAndPendingEdits() {
        enterDay();press(5,"h17");var before=pending();var rev=revision();var outbox=count("outbox_events");
        var baseline=jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class);
        jdbc.execute("alter table outbox_events add constraint reject_slot_back check(payload->>'command'<>'back') not valid");
        try {navigate(6,"Назад");assertThat(revision()).isEqualTo(rev);assertThat(pending()).isEqualTo(before);
            assertThat(count("outbox_events")).isEqualTo(outbox);
            assertThat(jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class)).isEqualTo(baseline);}
        finally {jdbc.execute("alter table outbox_events drop constraint reject_slot_back");}
        jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=6");
        assertThat(commands.processOne("123")).isTrue();sendNavigation();assertThat(revision()).isEqualTo(rev+1);
    }
    @Test void typedBackWithStaleAuthoritativeVersionExitsWithoutOverwritingSavedSlots() {
        enterDay();press(5,"h17");
        jdbc.execute("insert into availability_weeks(id,user_id,week_start,version,out_of_week) select 'external-week',user_id,week_start,1,true from telegram_slot_drafts");
        navigate(6,"Назад");sendNavigation();
        assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("cancelled");
        assertThat(jdbc.queryForObject("select out_of_week from availability_weeks",Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(1);
    }
    @Test void supportedPrivateNavigationDiscardsPendingEditorAndRejectsOldButtons() {
        for(var text:java.util.List.of("Меню","Профиль","Помощь","/start")) {
            prepare();enterDay();press(5,"h17");var old=offered("h18");
            navigate(6,text);
            assertThat(jdbc.queryForObject("select status from telegram_slot_drafts where id=?",String.class,draft)).isEqualTo("cancelled");
            assertThat(count("availability_weeks")).isZero();
            jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();
            apply(callback(7,"old-after-navigation",old));
            jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();assertThat(ackText.get()).isNotEmpty();
        }
    }
    @Test void menuCancelsAlreadyMaterializedEditorEditBeforeProviderCall() {
        var day=enterWeek();var before=edits.get();apply(callback(4,"pending-day",day));planner.materialize(20,"123");
        navigate(5,"Меню");planner.materialize(20,"123");
        for(int n=0;n<5;n++) {jdbc.execute("truncate delivery_rate_limits");sender(transport(false)).dispatchOne();}
        assertThat(edits.get()).isEqualTo(before);
        assertThat(jdbc.queryForObject("select status from notification_deliveries where payload->>'operation'='edit' and payload->>'slotRevision'='3'",String.class)).isEqualTo("cancelled");
        assertThat(count("availability_weeks")).isZero();
    }
    @Test void failedNavigationReplyRollsBackEditorExitAndRetriesAtomically() {
        enterDay();press(5,"h17");var before=pending();var outbox=count("outbox_events");
        jdbc.execute("alter table outbox_events add constraint reject_slot_navigation check(payload->>'command'<>'menu') not valid");
        try {navigate(6,"Меню");assertThat(pending()).isEqualTo(before);assertThat(count("outbox_events")).isEqualTo(outbox);
            assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("open");}
        finally {jdbc.execute("alter table outbox_events drop constraint reject_slot_navigation");}
        jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=6");
        assertThat(commands.processOne("123")).isTrue();
        assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("cancelled");
        assertThat(count("availability_weeks")).isZero();
    }
    @Test void navigationClosesExpiredOrRoleChangedEditorButIsolatesAnotherBot() {
        enterDay();
        jdbc.execute("""
                insert into telegram_slot_drafts(id,bot_id,user_id,chat_id,profile_version,week_start,base_version,payload)
                select 'sd_other_bot','456',user_id,chat_id,profile_version,week_start,base_version,payload from telegram_slot_drafts
                """);
        jdbc.execute("update telegram_slot_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second' where bot_id='123'");
        jdbc.execute("update users set role='faculty_helper',version=version+1");navigate(5,"Меню");
        assertThat(jdbc.queryForObject("select status from telegram_slot_drafts where bot_id='123'",String.class)).isEqualTo("cancelled");
        assertThat(jdbc.queryForObject("select status from telegram_slot_drafts where bot_id='456'",String.class)).isEqualTo("open");
        assertThat(jdbc.queryForObject("select payload->>'text' from outbox_events where payload->>'command'='menu'",String.class)).isEqualTo("Меню задач.");
    }
    @Test void malformedOrForeignCallbackEnvelopeCannotMutateOrQueueResponse() {
        for(var change:java.util.List.of("from","bot","chat","inline","forwarded","inaccessible","instance")) {
            var update=callback(2,"bad-"+change,data);var cb=(ObjectNode)update.path("callback_query");var msg=(ObjectNode)cb.path("message");
            switch(change) {
                case "from"->((ObjectNode)cb.path("from")).put("id",43);
                case "bot"->((ObjectNode)msg.path("from")).put("id",456);
                case "chat"->((ObjectNode)msg.path("chat")).put("type","group");
                case "inline"->cb.put("inline_message_id","foreign");
                case "forwarded"->msg.putObject("forward_origin");
                case "inaccessible"->msg.put("date",0);
                case "instance"->cb.remove("chat_instance");
            }
            apply(update);assertThat(revision()).isZero();assertThat(count("outbox_events")).isEqualTo(1);assertThat(count("telegram_callback_effects")).isZero();
            assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=2",String.class)).isEqualTo("failed");
            jdbc.execute("delete from telegram_inbox where update_id=2");
        }
    }
    @Test void unavailableEditorGetsOnlySafeAckWhileFutureActionsStayRetryable() {
        jdbc.execute("update users set role='faculty_helper'");apply(callback(2,"old-owner",data));
        assertThat(revision()).isZero();assertThat(count("outbox_events")).isEqualTo(2);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isTrue();assertThat(ackText.get()).contains("устарел");assertThat(edits.get()).isZero();
        apply(callback(3,"future",data.replace(":e",":w0")));
        assertThat(jdbc.queryForObject("select status from telegram_inbox where update_id=3",String.class)).isEqualTo("retry");
        assertThat(count("telegram_callback_effects")).isEqualTo(1);
    }
    @Test void outboxFailureRollsBackPanelRevisionAckAndJournalAndSameCallbackRetries() {
        jdbc.execute("alter table outbox_events add constraint reject_callback_edit check(payload->>'operation'<>'edit')");
        try {apply(callback(2,"retry",data));assertThat(revision()).isZero();assertThat(count("outbox_events")).isEqualTo(1);assertThat(count("telegram_callback_effects")).isZero();}
        finally {jdbc.execute("alter table outbox_events drop constraint reject_callback_edit");}
        assertThat(jdbc.queryForObject("select panel->>'text' from telegram_slot_drafts",String.class)).startsWith("Сохранённые слоты");
        jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=2");assertThat(commands.processOne("123")).isTrue();
        assertThat(revision()).isEqualTo(1);drain(false);assertThat(edits.get()).isEqualTo(1);assertThat(acks.get()).isEqualTo(1);
    }
    @Test void lostEditResponseNeverAuthorizesNewPanelOrAutomaticallyResends() {
        apply(callback(2,"unknown",data));drain(true);
        assertThat(jdbc.queryForObject("select status from notification_deliveries where payload->>'operation'='edit'",String.class)).isEqualTo("unknown");
        assertThatThrownBy(()->slots.requireConfirmedPanel("123",42,11,draft,1)).isInstanceOf(RuntimeException.class);
        jdbc.execute("truncate delivery_rate_limits");assertThat(sender(transport(false)).dispatchOne()).isFalse();assertThat(edits.get()).isEqualTo(1);
    }
    @Test void expiredAckIsNotRebasedAndChangedOwnerCancelsEditBeforeHttp() {
        apply(callback(2,"expired-ack",data));
        jdbc.execute("update outbox_events set available_at=clock_timestamp()-interval '31 seconds' where payload->>'operation'='ack'");
        jdbc.execute("update users set version=version+1");planner.materialize(20,"123");
        assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'operation'='ack'",String.class)).isEqualTo("cancelled");
        assertThat(jdbc.queryForObject("select status from outbox_events where payload->>'operation'='edit'",String.class)).isEqualTo("cancelled");
        assertThat(count("notification_deliveries")).isEqualTo(1);
    }
    @Test void ackRejectsFabricatedMessageIdAndOrdinarySendStillRequiresProviderId() {
        apply(callback(2,"ack-id",data));planner.materialize(20,"123");
        jdbc.execute("truncate delivery_rate_limits");var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();
        assertThat(queue.start(lease.id(),lease.token())).isTrue();
        assertThatThrownBy(()->queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(999))).isInstanceOf(RuntimeException.class);
        assertThat(queue.finish(lease.id(),lease.token(),new DeliveryQueue.Result("sent",null,null,null))).isTrue();
        var edit=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(edit.id(),edit.token())).isTrue();
        assertThatThrownBy(()->queue.finish(edit.id(),edit.token(),new DeliveryQueue.Result("sent",null,null,null))).isInstanceOf(RuntimeException.class);
    }
    @Test void callbackSourceTamperingFailsBeforeQueueAndFinalHttpGate() {
        apply(callback(2,"tamper",data));
        jdbc.execute("update telegram_inbox set payload=jsonb_set(payload,'{callback_query,from,id}','\"42\"') where update_id=2");
        planner.materialize(20,"123");assertThat(count("notification_deliveries")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from outbox_events where status='failed'",Integer.class)).isEqualTo(2);
    }
    @Test void editParentSnapshotMustStillMatchAtFinalPreHttpGate() {
        apply(callback(2,"parent-tamper",data));planner.materialize(20,"123");
        var ack=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(ack.id(),ack.token())).isTrue();
        assertThat(queue.finish(ack.id(),ack.token(),new DeliveryQueue.Result("sent",null,null,null))).isTrue();
        var edit=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(edit.id(),edit.token())).isTrue();
        jdbc.execute("update outbox_events set payload=jsonb_set(payload,'{text}','\"changed\"') where payload->>'command'='slots'");
        assertThat(queue.commandReplyReadyForSending(edit.id(),edit.token(),"123")).isFalse();
        assertThat(jdbc.queryForObject("select status from notification_deliveries where payload->>'operation'='edit'",String.class)).isEqualTo("cancelled");
    }
}
