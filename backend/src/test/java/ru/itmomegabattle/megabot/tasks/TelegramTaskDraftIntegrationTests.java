package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.util.concurrent.*;
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
import ru.itmomegabattle.megabot.common.ApiException;

@SpringBootTest @Import(TestcontainersConfiguration.class) @ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TelegramTaskDraftIntegrationTests {
    @Autowired TelegramTaskDraftService drafts; @Autowired JdbcTemplate jdbc; @Autowired PlatformTransactionManager transactions;
    @BeforeEach void prepare() {
        jdbc.execute("truncate users,faculties,chat_bindings,outbox_events,audit_events,integration_jobs cascade");
        jdbc.execute("insert into users(id,telegram_id,username,real_name,role,registered) values ('faculty',42,'faculty','Факультет','faculty_helper',true),('other',43,'other','Другой','faculty_helper',true),('author',44,'author','Автор','organizer',true)");
        jdbc.execute("insert into faculties(id,name) values ('f1','Первый'),('f2','Второй')");
        jdbc.execute("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('faculty','f1','helper'),('other','f1','helper')");
        jdbc.execute("insert into chat_bindings(id,bot_id,chat_id,type) values ('a','123',42,'private'),('b','456',42,'private'),('c','123',43,'private'),('d','123',44,'private')");
        jdbc.execute("insert into tasks(id,title,priority,status,faculty_id,creator_id) values ('a','Первая','normal','assigned','f1','author'),('b','Вторая','normal','waiting','f1','author')");
        jdbc.execute("insert into task_assignees(task_id,user_id) values ('a','faculty'),('b','faculty'),('a','other')");
    }
    TelegramTaskDraftService.Draft ready() {
        var d=drafts.begin("123",42);var s=drafts.select("123",42,d.id(),0,0);
        return drafts.chooseStatus("123",42,d.id(),s.revision(),"completed");
    }
    void unavailable(Runnable action) {assertThatThrownBy(action::run).isInstanceOf(ApiException.class);}
    @Test void durableStepsKeepSnapshotAndDeadlineAndCommitSharedCompletionOnce() {
        var d=drafts.begin("123",42);
        var expiry=jdbc.queryForObject("select expires_at::text from telegram_task_drafts where id=?",String.class,d.id());
        var s=drafts.select("123",42,d.id(),0,0);var c=drafts.chooseStatus("123",42,d.id(),1,"completed");
        assertThat(drafts.load("123",42,d.id())).isEqualTo(c);
        var done=drafts.confirm("123",42,d.id(),2);
        assertThat(done.revision()).isEqualTo(3);assertThat(done.step()).isEqualTo("confirm");
        assertThat(jdbc.queryForObject("select status from tasks where id='a'",String.class)).isEqualTo("completed");
        assertThat(jdbc.queryForObject("select count(*) from task_assignees where task_id='a'",Long.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_task_drafts where id=?",String.class,d.id())).isEqualTo(expiry);
        unavailable(()->drafts.confirm("123",42,d.id(),2));
        assertThat(jdbc.queryForObject("select count(*) from outbox_events where event_type='task.status'",Long.class)).isEqualTo(1);
    }
    @Test void selectionUsesOfferedIdentityNotFreshListPosition() {
        var d=drafts.begin("123",42);
        jdbc.execute("insert into tasks(id,title,priority,status,faculty_id,creator_id,created_at) values ('0','Поздняя вставка','normal','assigned','f1','author','2000-01-01')");
        jdbc.execute("insert into task_assignees(task_id,user_id) values ('0','faculty')");
        assertThat(drafts.select("123",42,d.id(),0,0).choices().get(0).path("id").asText()).isEqualTo("a");
        unavailable(()->drafts.select("123",42,d.id(),0,1));
        var fresh=drafts.begin("123",42);unavailable(()->drafts.select("123",42,fresh.id(),0,-1));
        unavailable(()->drafts.select("123",42,fresh.id(),0,10));
        assertThat(jdbc.queryForObject("select revision from telegram_task_drafts where id=?",Long.class,fresh.id())).isZero();
    }
    @Test void wrongActorBotRoleProfileFacultyOrBindingCannotResume() {
        var d=drafts.begin("123",42);
        unavailable(()->drafts.load("456",42,d.id()));unavailable(()->drafts.load("123",43,d.id()));
        unavailable(()->drafts.begin("123",44));
        jdbc.execute("update users set version=version+1 where id='faculty'");unavailable(()->drafts.load("123",42,d.id()));
        var next=drafts.begin("123",42);jdbc.execute("update faculty_memberships set faculty_id='f2' where user_id='faculty'");
        unavailable(()->drafts.load("123",42,next.id()));
        jdbc.execute("update faculty_memberships set faculty_id='f1' where user_id='faculty'");
        jdbc.execute("update users set role='faculty_responsible' where id='faculty'");unavailable(()->drafts.load("123",42,next.id()));
        jdbc.execute("update users set role='faculty_helper' where id='faculty'");jdbc.execute("delete from chat_bindings where id='a'");
        unavailable(()->drafts.load("123",42,next.id()));
    }
    @Test void staleTaskVersionAssignmentAndTerminalStateRefuseConfirmationWithoutRevival() {
        var d=ready();jdbc.execute("update tasks set version=version+1 where id='a'");
        unavailable(()->drafts.confirm("123",42,d.id(),2));
        jdbc.execute("update tasks set version=0 where id='a'");jdbc.execute("delete from task_assignees where task_id='a' and user_id='faculty'");
        unavailable(()->drafts.confirm("123",42,d.id(),2));
        jdbc.execute("insert into task_assignees(task_id,user_id) values ('a','faculty')");
        jdbc.execute("update tasks set status='cancelled',cancelled_at=clock_timestamp(),cancelled_by='author' where id='a'");
        unavailable(()->drafts.confirm("123",42,d.id(),2));
        assertThat(jdbc.queryForObject("select count(*) from outbox_events",Long.class)).isZero();
    }
    @Test void backAndLeaveDoNotMutateTaskAndBeginOnlyReplacesSameBotChat() {
        var d=ready();var other=drafts.begin("456",42);var foreign=drafts.begin("123",43);
        assertThat(drafts.back("123",42,d.id(),2).step()).isEqualTo("status");
        assertThat(drafts.back("123",42,d.id(),3).step()).isEqualTo("pick");
        drafts.back("123",42,d.id(),4);unavailable(()->drafts.load("123",42,d.id()));
        var fresh=drafts.begin("123",42);drafts.begin("123",42);unavailable(()->drafts.load("123",42,fresh.id()));
        drafts.leave("123",42);assertThat(drafts.load("456",42,other.id()).step()).isEqualTo("pick");
        assertThat(drafts.load("123",43,foreign.id()).step()).isEqualTo("pick");
        assertThat(jdbc.queryForObject("select sum(version) from tasks",Long.class)).isZero();
    }
    @Test void expiryAndInvalidChoiceCannotExtendOrAdvanceDraft() {
        var d=drafts.begin("123",42);drafts.select("123",42,d.id(),0,0);
        unavailable(()->drafts.chooseStatus("123",42,d.id(),1,"cancelled"));
        jdbc.update("update telegram_task_drafts set created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' where id=?",d.id());
        unavailable(()->drafts.chooseStatus("123",42,d.id(),1,"completed"));
        assertThat(jdbc.queryForObject("select revision from telegram_task_drafts where id=?",Long.class,d.id())).isEqualTo(1);
    }
    @Test void actualOutboxFailureAndCallerRollbackPreserveConfirmationForRetry() {
        var d=ready();
        jdbc.execute("alter table outbox_events add constraint reject_task_draft_test check (event_type<>'task.status')");
        try {assertThatThrownBy(()->drafts.confirm("123",42,d.id(),2)).isInstanceOf(org.springframework.dao.DataAccessException.class);}
        finally {jdbc.execute("alter table outbox_events drop constraint reject_task_draft_test");}
        assertThat(drafts.load("123",42,d.id())).isEqualTo(d);
        assertThat(jdbc.queryForObject("select version from tasks where id='a'",Long.class)).isZero();
        new TransactionTemplate(transactions).executeWithoutResult(tx->{drafts.confirm("123",42,d.id(),2);tx.setRollbackOnly();});
        assertThat(drafts.load("123",42,d.id())).isEqualTo(d);
        assertThat(jdbc.queryForObject("select count(*) from task_status_history",Long.class)).isZero();
        drafts.confirm("123",42,d.id(),2);
    }
    @Test void concurrentConfirmationsProduceOneDomainCommit() throws Exception {
        var d=ready();var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Boolean> confirm=()->{start.await();try {drafts.confirm("123",42,d.id(),2);return true;}catch(ApiException stale){return false;}};
            var a=pool.submit(confirm);var b=pool.submit(confirm);start.countDown();
            assertThat(java.util.List.of(a.get(30,TimeUnit.SECONDS),b.get(30,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(jdbc.queryForObject("select version from tasks where id='a'",Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from task_status_history",Long.class)).isEqualTo(1);
    }
}
