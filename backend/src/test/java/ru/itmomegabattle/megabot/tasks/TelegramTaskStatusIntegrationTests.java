package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.util.List;
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
import ru.itmomegabattle.megabot.common.ApiException;

/** Domain confirmation boundary only; Telegram dialog/source recovery acceptance is separate. */
@SpringBootTest @Import(TestcontainersConfiguration.class) @ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TelegramTaskStatusIntegrationTests {
    @Autowired TaskService tasks; @Autowired JdbcTemplate jdbc; @Autowired PlatformTransactionManager transactions;
    final AuthenticatedUser faculty=new AuthenticatedUser("faculty","faculty","Факультет","faculty_helper");
    @BeforeEach void prepare() {
        jdbc.execute("truncate users,faculties,outbox_events,audit_events,integration_jobs cascade");
        jdbc.execute("insert into users(id,telegram_id,username,real_name,role,registered) values ('faculty',42,'faculty','Факультет','faculty_helper',true),('other',43,'other','Коллега','faculty_helper',true),('author',44,'author','Автор','organizer',true)");
        jdbc.execute("insert into faculties(id,name) values ('f1','Первый'),('f2','Второй')");
        jdbc.execute("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('faculty','f1','helper'),('other','f1','helper')");
        jdbc.execute("insert into tasks(id,title,priority,status,faculty_id,creator_id) values ('task','Задача','normal','assigned','f1','author')");
        jdbc.execute("insert into task_assignees(task_id,user_id) values ('task','faculty'),('task','other')");
    }
    void apply(long version,String status) {new TransactionTemplate(transactions).executeWithoutResult(tx->tasks.facultyStatus("task",version,status,faculty));}
    void rejected(long version,String status) {assertThatThrownBy(()->apply(version,status)).isInstanceOf(ApiException.class);}
    @Test void completionUsesSharedDomainEffectsAndRetainsColleague() {
        apply(0,"completed");
        assertThat(jdbc.queryForObject("select status from tasks where id='task'",String.class)).isEqualTo("completed");
        assertThat(jdbc.queryForObject("select completed_by from tasks where id='task'",String.class)).isEqualTo("faculty");
        assertThat(jdbc.queryForObject("select completed_at is not null from tasks where id='task'",Boolean.class)).isTrue();
        assertThat(jdbc.queryForList("select user_id from task_assignees order by user_id",String.class)).containsExactly("faculty","other");
        assertThat(jdbc.queryForObject("select count(*) from task_status_history",Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from outbox_events where event_type='task.status'",Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from audit_events where entity_id='task'",Long.class)).isEqualTo(1);
    }
    @Test void currentSameStatusIsNoopButStaleSameStatusIsRejected() {
        apply(0,"waiting");apply(1,"waiting");rejected(0,"waiting");
        assertThat(jdbc.queryForObject("select version from tasks where id='task'",Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from outbox_events where event_type='task.status'",Long.class)).isEqualTo(1);
    }
    @Test void terminalTasksCannotBeReopenedEvenWithCurrentVersion() {
        apply(0,"completed");rejected(1,"in_progress");rejected(1,"completed");
        jdbc.execute("update tasks set status='cancelled',completed_at=null,completed_by=null,cancelled_at=clock_timestamp(),cancelled_by='author' where id='task'");
        rejected(1,"waiting");
        assertThat(jdbc.queryForObject("select status from tasks where id='task'",String.class)).isEqualTo("cancelled");
    }
    @Test void assignmentMembershipAndFacultyScopeAreRequired() {
        jdbc.execute("delete from task_assignees where user_id='faculty'");rejected(0,"completed");
        jdbc.execute("insert into task_assignees(task_id,user_id) values ('task','faculty')");
        jdbc.execute("update faculty_memberships set faculty_id='f2' where user_id='faculty'");rejected(0,"completed");
        jdbc.execute("update tasks set faculty_id=null,faculty_all=true where id='task'");apply(0,"waiting");
        jdbc.execute("delete from faculty_memberships where user_id='faculty'");rejected(1,"completed");
        assertThat(jdbc.queryForObject("select version from tasks where id='task'",Long.class)).isEqualTo(1);
    }
    @Test void invalidChoicesAndCoreActorCannotUseFacultyEntry() {
        for(var next:List.of("assigned","open","cancelled","COMPLETED","completed ",""))rejected(0,next);
        rejected(0,null);
        assertThatThrownBy(()->new TransactionTemplate(transactions).executeWithoutResult(tx->tasks.facultyStatus("task",0,"completed",new AuthenticatedUser("author","author","Автор","organizer"))))
                .isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select version from tasks where id='task'",Long.class)).isZero();
    }
    @Test void callerTransactionIsMandatoryAndRollbackRemovesAllEffects() {
        assertThatThrownBy(()->tasks.facultyStatus("task",0,"completed",faculty)).isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);
        new TransactionTemplate(transactions).executeWithoutResult(tx->{tasks.facultyStatus("task",0,"completed",faculty);tx.setRollbackOnly();});
        assertThat(jdbc.queryForObject("select version from tasks where id='task'",Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from task_status_history",Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from outbox_events",Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Long.class)).isZero();
    }
}
