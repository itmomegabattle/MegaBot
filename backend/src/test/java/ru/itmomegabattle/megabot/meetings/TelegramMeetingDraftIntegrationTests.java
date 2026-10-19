package ru.itmomegabattle.megabot.meetings;

import static org.assertj.core.api.Assertions.*;
import java.util.concurrent.*;
import java.time.*;
import java.time.format.DateTimeFormatter;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.common.ApiException;

@SpringBootTest
@Import(TestcontainersConfiguration.class)
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
class TelegramMeetingDraftIntegrationTests {
    @Autowired TelegramMeetingDraftService drafts;
    @Autowired MeetingService meetings;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void prepare() {
        jdbc.execute("truncate users,competencies,chat_bindings,audit_events,outbox_events,integration_jobs cascade");
        jdbc.execute("""
                insert into users(id,telegram_id,username,real_name,role,registered) values
                ('owner',901,'owner','Owner','organizer',true),('other',902,'other','Other','admin',true),
                ('faculty',903,'faculty','Faculty','faculty_helper',true),('historic',null,'historic','Historic','organizer',false)
                """);
        jdbc.execute("""
                insert into chat_bindings(id,bot_id,chat_id,type) values
                ('a','123',901,'private'),('b','456',901,'private'),('c','123',902,'private'),('d','123',903,'private')
                """);
        jdbc.execute("""
                insert into competencies(id,name,scope,active) values
                ('core','Core','core',true),('empty','Empty','core',true),
                ('faculty','Faculty','faculty',true),('inactive','Inactive','core',false)
                """);
        jdbc.execute("insert into user_competencies(user_id,competency_id) values ('other','core'),('historic','core'),('faculty','core')");
    }

    @Test void persistsAudienceStepsAndFixedDeadlineWithoutDomainEffects() {
        var draft=drafts.begin("123",901);
        var deadline=jdbc.queryForObject("select expires_at::text from telegram_meeting_drafts where id=?",String.class,draft.id());
        var pick=drafts.chooseAudience("123",901,draft.id(),0,"block");
        var confirm=drafts.selectBlock("123",901,draft.id(),pick.revision(),"core");
        var topic=drafts.confirmBlock("123",901,draft.id(),confirm.revision());
        assertThat(topic.step()).isEqualTo("topic");
        assertThat(topic.revision()).isEqualTo(3);
        assertThat(topic.payload().path("competencyId").asText()).isEqualTo("core");
        assertThat(drafts.load("123",901,draft.id()).payload()).isEqualTo(topic.payload());
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_meeting_drafts where id=?",String.class,draft.id())).isEqualTo(deadline);
        assertThat(meetings.blockAudience("core")).containsExactlyInAnyOrder("other","historic");
        for(var table:new String[]{"meetings","outbox_events","audit_events","integration_jobs"})
            assertThat(jdbc.queryForObject("select count(*) from "+table,Long.class)).as(table).isZero();
    }

    @Test void freshBeginReplacesOnlySameBotChatAndCancellationRequiresCurrentRevision() {
        var first=drafts.begin("123",901);
        var otherBot=drafts.begin("456",901);
        var otherUser=drafts.begin("123",902);
        var fresh=drafts.begin("123",901);
        assertThatThrownBy(()->drafts.load("123",901,first.id())).isInstanceOf(ApiException.class);
        assertThat(drafts.load("456",901,otherBot.id()).step()).isEqualTo("choose_type");
        assertThat(drafts.load("123",902,otherUser.id()).step()).isEqualTo("choose_type");
        assertThatThrownBy(()->drafts.load("123",902,fresh.id())).isInstanceOf(ApiException.class);
        var topic=drafts.chooseAudience("123",901,fresh.id(),0,"all");
        assertThatThrownBy(()->drafts.cancel("123",901,fresh.id(),0)).isInstanceOf(ApiException.class);
        drafts.cancel("123",901,fresh.id(),topic.revision());
        assertThatThrownBy(()->drafts.load("123",901,fresh.id())).isInstanceOf(ApiException.class);
    }

    @Test void rejectsInvalidAudienceStepsAndRechecksMembershipAtConfirmation() {
        var draft=drafts.begin("123",901);
        assertThatThrownBy(()->drafts.chooseAudience("123",901,draft.id(),0,"selected")).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.selectBlock("123",901,draft.id(),0,"core")).isInstanceOf(ApiException.class);
        drafts.chooseAudience("123",901,draft.id(),0,"block");
        for(var block:new String[]{"missing","inactive","faculty","empty"})
            assertThatThrownBy(()->drafts.selectBlock("123",901,draft.id(),1,block)).isInstanceOf(ApiException.class);
        assertThat(drafts.load("123",901,draft.id()).revision()).isEqualTo(1);
        drafts.selectBlock("123",901,draft.id(),1,"core");
        jdbc.execute("delete from user_competencies where competency_id='core'");
        assertThatThrownBy(()->drafts.confirmBlock("123",901,draft.id(),2)).isInstanceOf(ApiException.class);
        assertThat(drafts.load("123",901,draft.id()).step()).isEqualTo("confirm_competency");
    }

    @Test void ownerProfileBindingAndExpiryCannotBeRebasedByMutation() {
        assertThatThrownBy(()->drafts.begin("123",903)).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.begin("unknown",901)).isInstanceOf(ApiException.class);
        var draft=drafts.begin("123",901);
        jdbc.execute("update users set version=version+1 where id='owner'");
        assertThatThrownBy(()->drafts.chooseAudience("123",901,draft.id(),0,"all")).isInstanceOf(ApiException.class);
        var fresh=drafts.begin("123",901);
        jdbc.execute("delete from chat_bindings where bot_id='123' and chat_id=901");
        assertThatThrownBy(()->drafts.load("123",901,fresh.id())).isInstanceOf(ApiException.class);
        jdbc.execute("insert into chat_bindings(id,bot_id,chat_id,type) values ('restored','123',901,'private')");
        jdbc.execute("update users set registered=false where id='owner'");
        assertThatThrownBy(()->drafts.load("123",901,fresh.id())).isInstanceOf(ApiException.class);
        jdbc.execute("update users set registered=true where id='owner'");
        jdbc.execute("update users set role='faculty_helper' where id='owner'");
        assertThatThrownBy(()->drafts.load("123",901,fresh.id())).isInstanceOf(ApiException.class);
        jdbc.execute("update users set role='organizer',active=false,deactivated_at=clock_timestamp() where id='owner'");
        assertThatThrownBy(()->drafts.load("123",901,fresh.id())).isInstanceOf(ApiException.class);
        jdbc.execute("update users set active=true,deactivated_at=null where id='owner'");
        jdbc.update("update telegram_meeting_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=?",fresh.id());
        assertThatThrownBy(()->drafts.chooseAudience("123",901,fresh.id(),0,"all")).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select revision from telegram_meeting_drafts where id=?",Long.class,fresh.id())).isZero();
    }

    @Test void reboundTelegramIdentityCannotCancelOrAdoptPreviousOwnersDraft() {
        var old=drafts.begin("123",901);
        jdbc.execute("update users set telegram_id=null where id='owner'");
        jdbc.execute("update users set telegram_id=901 where id='other'");
        assertThatThrownBy(()->drafts.load("123",901,old.id())).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.begin("123",901)).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("select status from telegram_meeting_drafts where id=?",String.class,old.id())).isEqualTo("open");
        assertThat(jdbc.queryForObject("select user_id from telegram_meeting_drafts where id=?",String.class,old.id())).isEqualTo("owner");
        assertThat(jdbc.queryForObject("select count(*) from telegram_meeting_drafts",Long.class)).isEqualTo(1);
    }

    @Test void databaseRejectionRollsBackReplacementAndTransition() {
        var draft=drafts.begin("123",901);
        jdbc.execute("alter table telegram_meeting_drafts add constraint test_reject_cancel check(status='open')");
        try {
            assertThatThrownBy(()->drafts.begin("123",901)).isInstanceOf(RuntimeException.class);
            assertThat(drafts.load("123",901,draft.id()).revision()).isZero();
            assertThat(jdbc.queryForObject("select count(*) from telegram_meeting_drafts",Long.class)).isEqualTo(1);
        } finally { jdbc.execute("alter table telegram_meeting_drafts drop constraint test_reject_cancel"); }
        jdbc.execute("alter table telegram_meeting_drafts add constraint test_reject_step check(step='choose_type')");
        try {
            assertThatThrownBy(()->drafts.chooseAudience("123",901,draft.id(),0,"all")).isInstanceOf(RuntimeException.class);
            var unchanged=drafts.load("123",901,draft.id());
            assertThat(unchanged.revision()).isZero();
            assertThat(unchanged.payload().size()).isZero();
        } finally { jdbc.execute("alter table telegram_meeting_drafts drop constraint test_reject_step"); }
    }

    @Test @Timeout(30) void competingSameRevisionHasExactlyOneWinner() throws Exception {
        var draft=drafts.begin("123",901);
        var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Boolean> choose=()->{
                start.await();
                try { drafts.chooseAudience("123",901,draft.id(),0,"all"); return true; }
                catch(ApiException stale) { return false; }
            };
            var first=pool.submit(choose); var second=pool.submit(choose); start.countDown();
            assertThat(java.util.List.of(first.get(15,TimeUnit.SECONDS),second.get(15,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(drafts.load("123",901,draft.id()).revision()).isEqualTo(1);
    }

    private TelegramMeetingDraftService.Draft ready(boolean block,String date) {
        var draft=drafts.begin("123",901);
        draft=drafts.chooseAudience("123",901,draft.id(),draft.revision(),block?"block":"all");
        if(block) {
            draft=drafts.selectBlock("123",901,draft.id(),draft.revision(),"core");
            draft=drafts.confirmBlock("123",901,draft.id(),draft.revision());
        }
        draft=drafts.enterTopic("123",901,draft.id(),draft.revision(),"  Тема собрания  ");
        draft=drafts.enterDescription("123",901,draft.id(),draft.revision(),"Пропустить");
        return drafts.enterDate("123",901,draft.id(),draft.revision(),date);
    }
    private String futureDate() {
        return LocalDate.now(MeetingRules.PROJECT_ZONE).plusDays(2).format(DateTimeFormatter.ofPattern("dd.MM.uuuu"));
    }

    @Test void completeDialogCreatesOnceWithExistingAtomicDomainSideEffects() {
        var draft=ready(false,futureDate());
        var deadline=jdbc.queryForObject("select expires_at::text from telegram_meeting_drafts",String.class);
        var meeting=drafts.create("123",901,draft.id(),draft.revision(),"2:17");
        var row=jdbc.queryForMap("select * from meetings where id=?",meeting);
        assertThat(row).containsEntry("title","Общее собрание").containsEntry("topic","Тема собрания").containsEntry("description",null)
                .containsEntry("host_id","owner").containsEntry("audience_mode","all");
        assertThat(((Number)row.get("duration_minutes")).intValue()).isEqualTo(60);
        assertThat(jdbc.queryForList("select user_id from meeting_invitations where meeting_id=?",String.class,meeting))
                .containsExactlyInAnyOrder("owner","other","historic");
        assertThat(jdbc.queryForObject("select status from telegram_meeting_drafts where id=?",String.class,draft.id())).isEqualTo("completed");
        assertThat(jdbc.queryForObject("select meeting_id from telegram_meeting_drafts where id=?",String.class,draft.id())).isEqualTo(meeting);
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_meeting_drafts",String.class)).isEqualTo(deadline);
        assertThat(jdbc.queryForObject("select payload->>'time' from telegram_meeting_drafts",String.class)).isEqualTo("02:17");
        assertThat(jdbc.queryForObject("select count(*) from outbox_events",Long.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from integration_jobs",Long.class)).isEqualTo(1);
        assertThatThrownBy(()->drafts.create("123",901,draft.id(),draft.revision(),"2:17")).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select count(*) from meetings",Long.class)).isEqualTo(1);
        var block=ready(true,futureDate());
        jdbc.execute("delete from user_competencies where user_id='historic'");
        var blockMeeting=drafts.create("123",901,block.id(),block.revision(),"23:59");
        assertThat(jdbc.queryForObject("select title from meetings where id=?",String.class,blockMeeting)).isEqualTo("Собрание блока Core");
        assertThat(jdbc.queryForList("select user_id from meeting_invitations where meeting_id=?",String.class,blockMeeting))
                .containsExactlyInAnyOrder("owner","other");
    }

    @Test void textLimitsAndInvalidDateDoNotAdvanceOrLoseEarlierInput() {
        var initial=drafts.begin("123",901);
        var draft=drafts.chooseAudience("123",901,initial.id(),0,"all");
        for(var text:new String[]{"   ","x".repeat(501)})
            assertThatThrownBy(()->drafts.enterTopic("123",901,draft.id(),draft.revision(),text)).isInstanceOf(ApiException.class);
        var description=drafts.enterTopic("123",901,draft.id(),draft.revision(),"тема");
        assertThatThrownBy(()->drafts.enterDescription("123",901,draft.id(),description.revision(),"x".repeat(4001))).isInstanceOf(ApiException.class);
        var date=drafts.enterDescription("123",901,draft.id(),description.revision(),"  Подробности\nсобрания  ");
        assertThatThrownBy(()->drafts.enterDate("123",901,draft.id(),date.revision(),"31.02.2027")).isInstanceOf(ApiException.class);
        assertThat(drafts.load("123",901,draft.id()).payload().path("description").asText()).isEqualTo("Подробности\nсобрания");
        assertThat(drafts.load("123",901,draft.id()).revision()).isEqualTo(date.revision());
    }

    @Test void backTraversesDurableStepsWithoutExtendingExpiryAndCanCancelRoot() {
        var draft=ready(true,futureDate());
        var deadline=jdbc.queryForObject("select expires_at::text from telegram_meeting_drafts",String.class);
        for(var step:new String[]{"date","description","topic","confirm_competency","pick_competency","choose_type"}) {
            draft=drafts.back("123",901,draft.id(),draft.revision());
            assertThat(draft.step()).isEqualTo(step);
        }
        assertThat(draft.payload().size()).isZero();
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_meeting_drafts",String.class)).isEqualTo(deadline);
        drafts.back("123",901,draft.id(),draft.revision());
        assertThat(jdbc.queryForObject("select status from telegram_meeting_drafts",String.class)).isEqualTo("cancelled");
        assertThat(jdbc.queryForObject("select count(*) from meetings",Long.class)).isZero();
    }

    @Test void finalDomainRechecksAudienceAndPastStartWithoutCompletingDraft() {
        var block=ready(true,futureDate());
        jdbc.execute("update competencies set active=false where id='core'");
        assertThatThrownBy(()->drafts.create("123",901,block.id(),block.revision(),"18")).isInstanceOf(ApiException.class);
        assertThat(drafts.load("123",901,block.id()).step()).isEqualTo("time");
        var past=ready(false,LocalDate.now(MeetingRules.PROJECT_ZONE).minusDays(1).format(DateTimeFormatter.ofPattern("dd.MM.uuuu")));
        assertThatThrownBy(()->drafts.create("123",901,past.id(),past.revision(),"23:59")).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.create("123",901,past.id(),past.revision(),"24:00")).isInstanceOf(ApiException.class);
        for(var table:new String[]{"meetings","outbox_events","audit_events","integration_jobs"})
            assertThat(jdbc.queryForObject("select count(*) from "+table,Long.class)).as(table).isZero();
    }

    @Test void expiryDuringDomainCreateRollsBackMeetingSideEffectsAndDraftTogether() {
        var draft=ready(false,futureDate());
        jdbc.execute("""
                create function fixture_expire_meeting_draft() returns trigger language plpgsql as $$
                begin
                  update telegram_meeting_drafts set created_at=clock_timestamp()-interval '20 minutes',
                    expires_at=clock_timestamp()-interval '1 minute' where status='open';
                  return NEW;
                end $$
                """);
        jdbc.execute("create trigger fixture_expire_meeting_draft before insert on meetings for each row execute function fixture_expire_meeting_draft()");
        try {
            assertThatThrownBy(()->drafts.create("123",901,draft.id(),draft.revision(),"18")).isInstanceOf(ApiException.class);
            assertThat(drafts.load("123",901,draft.id()).revision()).isEqualTo(draft.revision());
            for(var table:new String[]{"meetings","outbox_events","audit_events","integration_jobs"})
                assertThat(jdbc.queryForObject("select count(*) from "+table,Long.class)).as(table).isZero();
        } finally {
            jdbc.execute("drop trigger fixture_expire_meeting_draft on meetings");
            jdbc.execute("drop function fixture_expire_meeting_draft()");
        }
    }

    @Test @Timeout(30) void concurrentFinalCreateCommitsExactlyOneMeeting() throws Exception {
        var draft=ready(false,futureDate());
        var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Boolean> create=()->{
                start.await();
                try { drafts.create("123",901,draft.id(),draft.revision(),"23:59"); return true; }
                catch(ApiException stale) { return false; }
            };
            var first=pool.submit(create); var second=pool.submit(create); start.countDown();
            assertThat(java.util.List.of(first.get(15,TimeUnit.SECONDS),second.get(15,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(jdbc.queryForObject("select count(*) from meetings",Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from integration_jobs",Long.class)).isEqualTo(1);
    }
}
