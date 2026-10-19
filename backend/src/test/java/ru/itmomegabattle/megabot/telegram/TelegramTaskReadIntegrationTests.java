package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
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
import tools.jackson.databind.ObjectMapper;

@SpringBootTest @Import(TestcontainersConfiguration.class) @ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TelegramTaskReadIntegrationTests {
    @Autowired TelegramInbox inbox;@Autowired TelegramCommandWorker commands;@Autowired TelegramReplyPlanner planner;
    @Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
    @BeforeEach void clear() {
        jdbc.execute("truncate telegram_inbox,outbox_events,bot_messages,chat_bindings,users,faculties,competencies,delivery_rate_limits,app_settings,audit_events,integration_jobs cascade");
    }
    void member(String role) {
        jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('member',42,'alice','Участник',?,true),('other',43,'other','Автор','organizer',true)",role);
        jdbc.execute("insert into faculties(id,name) values ('f1','Первый'),('f2','Второй')");
        jdbc.execute("insert into task_recovery_operations(id,mode,actor_id,preview_fingerprint,snapshot,task_count,created_at) values ('removal','archive','other','fixture','[]',1,now())");
    }
    void task(String id,String title,String status,String faculty,boolean all,String assigned) {
        jdbc.update("""
                insert into tasks(id,title,description,priority,status,creator_id,faculty_id,faculty_all,completed_at,cancelled_at)
                values (?,?,'Описание','normal',?,'other',?,?,case when ?='completed' then clock_timestamp() end,case when ?='cancelled' then clock_timestamp() end)
                """,id,title,status,faculty,all,status,status);
        if(assigned!=null)jdbc.update("insert into task_assignees(task_id,user_id) values (?,?)",id,assigned);
    }
    void command(long update,String text) {
        inbox.accept("123",json.writeValueAsBytes(Map.of("update_id",update,"message",Map.of("message_id",update+1,"date",Instant.now().getEpochSecond(),
                "chat",Map.of("id",42,"type","private"),"from",Map.of("id",42,"is_bot",false,"first_name","Тест","username","alice"),"text",text))));
        assertThat(commands.processOne("123")).isTrue();
    }
    TelegramTransport.Message send(long provider) {
        var captured=new AtomicReference<TelegramTransport.Message>();
        var sender=new BroadcastDispatcher(queue,quota,m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();captured.set(m);return TelegramTransport.Outcome.sent(provider);},
                json,"123",new DeliveryQuota.Limits(20,1,20),null,null,Clock.systemUTC(),null,null,null,null,planner);
        assertThat(sender.dispatchOne()).isTrue();jdbc.execute("truncate delivery_rate_limits");
        return captured.get();
    }
    @Test void coreSummaryFiltersAssignmentBeforeLimitAndCountsOnlyVisibleCoreBoardWithoutMutation() {
        member("admin");
        jdbc.execute("insert into tasks(id,title,priority,status) select 'a'||n,'Foreign '||n,'normal','assigned' from generate_series(1,120) n");
        jdbc.execute("insert into task_assignees(task_id,user_id) select id,'other' from tasks");
        task("z_owned","Своя после первых 100","assigned",null,false,"member");
        task("open1","Свободная1","open",null,false,null);task("open2","Свободная2","open",null,false,null);
        task("faculty","Не доска","open","f1",false,null);task("removed","Удалённая","open",null,false,null);
        jdbc.execute("update tasks set removed_at=clock_timestamp(),removal_operation_id='removal' where id='removed'");
        command(1,"  ЗАДАЧИ \n");var reply=send(11);
        assertThat(reply.text()).contains("Своя после первых 100","Свободных задач на доске: 2").doesNotContain("Foreign","Не доска","Удалённая");
        assertThat(reply.keyboard().rows()).containsExactly(List.of("Управлять задачами","Создать задачу"),List.of("Свободные задачи","Выполненные задачи"),List.of("Назад"));
        assertThat(jdbc.queryForObject("select jsonb_array_length(payload->'taskView') from outbox_events",Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from integration_jobs",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select version from tasks where id='z_owned'",Long.class)).isZero();
    }
    @Test void openBoardAndCompletedListsKeepScopeOrderAndPreciseMoscowDeadline() {
        member("organizer");task("open","Открытая","open",null,false,null);
        jdbc.execute("update tasks set due_at='2030-01-01T21:17:00Z' where id='open'");
        task("faculty","Чужой контур","open","f1",false,null);task("done1","Ранее","completed",null,false,"member");
        task("done2","Позже","completed",null,false,"member");task("other_done","Чужая завершённая","completed",null,false,"other");
        command(1,"Свободные задачи");assertThat(send(11).text()).contains("Открытая","02.01.2030, 00:17 (МСК)").doesNotContain("Чужой контур","Ранее");
        command(2,"Выполненные задачи");var done=send(12);
        assertThat(done.text()).contains("Последние выполненные задачи","Позже","Ранее").doesNotContain("Чужая завершённая","Открытая");
        assertThat(done.text().indexOf("Позже")).isLessThan(done.text().indexOf("Ранее"));
        assertThat(done.keyboard().rows()).containsExactly(List.of("Назад"));
    }
    @Test void facultyViewRequiresMembershipAssignmentAndScopeAndNeverShowsCoreBoard() {
        member("faculty_helper");jdbc.execute("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('member','f1','helper')");
        task("own","Факультетская","assigned","f1",false,"member");task("all","Для всех факультетов","waiting",null,true,"member");
        task("foreign","Другой факультет","assigned","f2",false,"member");task("core","Организаторская","assigned",null,false,"member");
        task("not_own","Не назначена","assigned","f1",false,"other");task("done","Завершённая","completed","f1",false,"member");
        command(1,"Мои задачи");var reply=send(11);
        assertThat(reply.text()).contains("Факультетская","Для всех факультетов","Автор: Автор","Описание")
                .doesNotContain("Другой факультет","Организаторская","Не назначена","Завершённая","Свободных задач на доске");
        assertThat(reply.keyboard().rows()).containsExactly(List.of("Установить статус задачи"),List.of("Мои задачи","Помощь"));
        command(2,"Свободные задачи");assertThat(send(12).text()).startsWith("Этот раздел доступен организаторам");
        command(3,"Выполненные задачи");assertThat(send(13).text()).startsWith("Этот раздел доступен организаторам");
    }
    @Test void unknownAndEmptyRoleMenusAndExactAliasesRemainBounded() {
        command(1,"/tasks");assertThat(send(11).text()).startsWith("Вас нет в списке участников");
        for(var role:List.of("admin","organizer","faculty_helper","faculty_responsible")) {
            clear();member(role);command(1,"Мои задачи");var reply=send(11);
            assertThat(reply.text()).contains(role.startsWith("faculty_")?"Активных задач пока нет.":"Активных задач нет.");
        }
        for(var bad:List.of("/tasks@bot","/tasks extra","Задачи ещё","Мои задачи ещё"))assertThat(TelegramPrivateCommandHandler.command(bad)).isNull();
    }
    @Test void taskVersionAssignmentRemovalAndLifecycleChangesCancelBeforePlannerOrAfterStart() {
        for(var change:List.of("update tasks set version=version+1","delete from task_assignees where user_id='member'",
                "update tasks set status='completed',completed_at=clock_timestamp()","update tasks set removed_at=clock_timestamp(),removal_operation_id='removal'",
                "update users set version=version+1 where id='member'","update users set role='faculty_helper' where id='member'","delete from chat_bindings")) {
            for(boolean afterStart:List.of(false,true)) {
                clear();member("organizer");task("task","Своя","assigned",null,false,"member");command(1,"Задачи");
                DeliveryQueue.Lease lease=null;
                if(afterStart){planner.materialize(20,"123");lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();}
                jdbc.execute(change);
                if(afterStart)assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
                else {planner.materialize(20,"123");assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("cancelled");}
            }
        }
    }
    @Test void facultyMembershipChangesCancelEvenWithoutProfileVersionChange() {
        for(var change:List.of("update faculty_memberships set faculty_id='f2'","delete from faculty_memberships")) {
            for(boolean afterStart:List.of(false,true)) {
                clear();member("faculty_responsible");jdbc.execute("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('member','f1','responsible')");
                task("task","Закрытые данные","assigned","f1",false,"member");command(1,"Мои задачи");
                DeliveryQueue.Lease lease=null;
                if(afterStart){planner.materialize(20,"123");lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();}
                jdbc.execute(change);assertThat(jdbc.queryForObject("select version from users where id='member'",Long.class)).isZero();
                if(afterStart)assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
                else {planner.materialize(20,"123");assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("cancelled");}
            }
        }
    }
    @Test void malformedOrDuplicatedSnapshotAndSourceAliasTamperingFailClosedWithoutSqlErrors() {
        for(var value:List.of("null","{}","true","[{},{}]","[{\"id\":\"task\",\"version\":0},{\"id\":\"task\",\"version\":0}]","source")) {
            for(boolean afterStart:List.of(false,true)) {
                clear();member("organizer");task("task","Своя","assigned",null,false,"member");command(1,"Задачи");
                DeliveryQueue.Lease lease=null;
                if(afterStart){planner.materialize(20,"123");lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();}
                if(value.equals("source"))jdbc.update("update telegram_inbox set payload=jsonb_set(payload,'{message,text}',cast(? as jsonb))",json.writeValueAsString("Свободные задачи"));
                else {
                    jdbc.update("update outbox_events set payload=jsonb_set(payload,'{taskView}',cast(? as jsonb))",value);
                    if(afterStart)jdbc.execute("update notification_deliveries d set payload=o.payload from outbox_events o where o.id=d.command_reply_outbox_id");
                }
                if(afterStart)assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
                else {planner.materialize(20,"123");assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isIn("cancelled","failed");}
            }
        }
    }
    @Test void boundedUnicodeFacultyListPreservesLegacyDeadlineWithoutGuessingAndSignalsOverflow() {
        member("faculty_helper");jdbc.execute("insert into faculty_memberships(user_id,faculty_id,faculty_role) values ('member','f1','helper')");
        jdbc.update("update users set real_name=? where id='other'","🙂".repeat(200));
        for(int n=0;n<9;n++)task("t"+n,"🙂".repeat(200),"assigned","f1",false,"member");
        jdbc.update("update tasks set description=?,legacy_deadline=?","🙂".repeat(300),"31/01 без года");
        command(1,"Мои задачи");var reply=send(11);
        assertThat(reply.text()).contains("31/01 без года","Остальные задачи доступны в Mini App.").hasSizeLessThan(4001);
        assertThat(java.nio.charset.StandardCharsets.UTF_8.newEncoder().canEncode(reply.text())).isTrue();
        assertThat(jdbc.queryForObject("select jsonb_array_length(payload->'taskView') from outbox_events",Integer.class)).isEqualTo(8);
    }
    @Test void taskReadOutboxFailureRollsBackMeetingNavigationAndRetriesOnce() {
        member("organizer");task("task","Своя","assigned",null,false,"member");command(1,"Назначить собрание");send(11);
        var before=jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class);
        jdbc.execute("alter table outbox_events add constraint fixture_reject_task_view check(payload->>'command'<>'tasks')");
        try {command(2,"Задачи");assertThat(jdbc.queryForObject("select row_to_json(s)::text from telegram_meeting_drafts s",String.class)).isEqualTo(before);}
        finally {jdbc.execute("alter table outbox_events drop constraint fixture_reject_task_view");}
        jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second' where update_id=2");
        assertThat(commands.processOne("123")).isTrue();assertThat(send(12).text()).contains("Своя");
        assertThat(jdbc.queryForObject("select count(*) from outbox_events where payload->>'command'='tasks'",Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select status from telegram_meeting_drafts",String.class)).isEqualTo("cancelled");
        assertThat(jdbc.queryForObject("select version from tasks",Long.class)).isZero();
    }
}
