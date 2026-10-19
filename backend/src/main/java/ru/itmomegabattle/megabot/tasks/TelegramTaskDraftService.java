package ru.itmomegabattle.megabot.tasks;

import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Internal domain draft operations. Telegram callers must separately prove the committed-SENT offer. */
@Service @Transactional
public class TelegramTaskDraftService {
    private final JdbcClient jdbc; private final ObjectMapper json; private final TaskService tasks;
    public TelegramTaskDraftService(JdbcClient jdbc,ObjectMapper json,TaskService tasks) {this.jdbc=jdbc;this.json=json;this.tasks=tasks;}

    public Draft begin(String bot,long chat) {
        var owner=owner(bot,chat);
        var choices=json.createArrayNode();
        jdbc.sql("select t.id,t.version from tasks t where "+TaskService.VISIBLE_SQL+
                " and t.status not in ('completed','cancelled') order by t.created_at,t.id limit 10")
                .param("actor",owner.actor().id()).param("core",false).query((r,i)->{
                    choices.addObject().put("id",r.getString(1)).put("version",r.getLong(2));return r.getString(1);
                }).list();
        if(choices.isEmpty())throw stale();
        jdbc.sql("update telegram_task_drafts set status='cancelled',revision=revision+1 where bot_id=:bot and chat_id=:chat and status='open'")
                .param("bot",bot).param("chat",chat).update();
        var id="task_draft_"+UUID.randomUUID();
        jdbc.sql("""
                insert into telegram_task_drafts(id,bot_id,chat_id,user_id,profile_version,recipient_role,faculty_id,choices)
                values (:id,:bot,:chat,:user,:profile,:role,:faculty,cast(:choices as jsonb))
                """).param("id",id).param("bot",bot).param("chat",chat).param("user",owner.actor().id())
                .param("profile",owner.version()).param("role",owner.actor().role()).param("faculty",owner.faculty())
                .param("choices",json.writeValueAsString(choices)).update();
        return load(bot,chat,id,owner);
    }
    public Draft load(String bot,long chat,String id) {return load(bot,chat,id,owner(bot,chat));}
    public Draft select(String bot,long chat,String id,long revision,int index) {
        var owner=owner(bot,chat);var draft=checked(load(bot,chat,id,owner),revision,"pick");
        if(index<0 || index>=draft.choices().size())throw stale();
        currentTask(draft.choices().get(index),owner);
        return advance(draft,"status",index,null,"open");
    }
    public Draft chooseStatus(String bot,long chat,String id,long revision,String next) {
        var owner=owner(bot,chat);var draft=checked(load(bot,chat,id,owner),revision,"status");
        if(next==null || !List.of("waiting","in_progress","completed").contains(next))throw stale();
        currentTask(draft.choices().get(draft.index()),owner);
        return advance(draft,"confirm",draft.index(),next,"open");
    }
    public Draft confirm(String bot,long chat,String id,long revision) {
        var owner=owner(bot,chat);var draft=checked(load(bot,chat,id,owner),revision,"confirm");
        var choice=draft.choices().get(draft.index());currentTask(choice,owner);
        tasks.facultyStatus(choice.path("id").asText(),choice.path("version").longValue(),draft.next(),owner.actor());
        return advance(draft,"confirm",draft.index(),draft.next(),"completed");
    }
    public Draft back(String bot,long chat,String id,long revision) {
        var owner=owner(bot,chat);var draft=checked(load(bot,chat,id,owner),revision,null);
        return switch(draft.step()) {
            case "confirm"->advance(draft,"status",draft.index(),null,"open");
            case "status"->advance(draft,"pick",null,null,"open");
            default->advance(draft,"pick",null,null,"cancelled");
        };
    }
    public void leave(String bot,long chat) {
        var owner=owner(bot,chat);
        jdbc.sql("update telegram_task_drafts set status='cancelled',revision=revision+1 where bot_id=:bot and chat_id=:chat and user_id=:user and status='open'")
                .param("bot",bot).param("chat",chat).param("user",owner.actor().id()).update();
    }
    private void currentTask(JsonNode choice,Owner owner) {
        TaskMaintenanceGate.shared(jdbc);
        if(jdbc.sql("select t.id from tasks t where "+TaskService.VISIBLE_SQL+
                " and t.id=:id and t.version=:version and t.status not in ('completed','cancelled') for update of t")
                .param("actor",owner.actor().id()).param("core",false).param("id",choice.path("id").asText())
                .param("version",choice.path("version").longValue()).query(String.class).optional().isEmpty())throw stale();
    }
    private Owner owner(String bot,long chat) {
        if(bot==null || !bot.matches("[1-9][0-9]{0,19}") || chat<1)throw stale();
        return jdbc.sql("""
                select u.id,u.username,u.real_name,u.role,u.version,f.faculty_id from users u
                join faculty_memberships f on f.user_id=u.id where u.telegram_id=:chat and u.active and u.registered
                and u.role in ('faculty_responsible','faculty_helper') and exists
                (select 1 from chat_bindings b where b.bot_id=:bot and b.chat_id=:chat and b.type='private')
                for no key update of u for share of f
                """).param("bot",bot).param("chat",chat).query((r,i)->new Owner(new AuthenticatedUser(r.getString(1),
                        r.getString(2),r.getString(3),r.getString(4)),r.getLong(5),r.getString(6))).optional().orElseThrow(TelegramTaskDraftService::stale);
    }
    private Draft load(String bot,long chat,String id,Owner owner) {
        return jdbc.sql("""
                select id,revision,step,choices::text,selected_index,selected_status from telegram_task_drafts
                where id=:id and bot_id=:bot and chat_id=:chat and user_id=:user and profile_version=:profile
                and recipient_role=:role and faculty_id=:faculty and status='open' and expires_at>clock_timestamp() for update
                """).param("id",id).param("bot",bot).param("chat",chat).param("user",owner.actor().id()).param("profile",owner.version())
                .param("role",owner.actor().role()).param("faculty",owner.faculty())
                .query((r,i)->new Draft(r.getString(1),r.getLong(2),r.getString(3),json.readTree(r.getString(4)),(Integer)r.getObject(5),r.getString(6)))
                .optional().orElseThrow(TelegramTaskDraftService::stale);
    }
    private Draft checked(Draft draft,long revision,String step) {
        if(draft.revision()!=revision || step!=null && !step.equals(draft.step()))throw stale();return draft;
    }
    private Draft advance(Draft draft,String step,Integer index,String next,String status) {
        if(jdbc.sql("""
                update telegram_task_drafts set step=:step,selected_index=:index,selected_status=:next,status=:status,revision=revision+1
                where id=:id and revision=:revision and status='open' and expires_at>clock_timestamp()
                """).param("step",step).param("index",index).param("next",next).param("status",status)
                .param("id",draft.id()).param("revision",draft.revision()).update()!=1)throw stale();
        return new Draft(draft.id(),draft.revision()+1,step,draft.choices().deepCopy(),index,next);
    }
    private static ApiException stale() {return new ApiException(HttpStatus.CONFLICT,"task_draft_unavailable","Задача или диалог устарели. Откройте список заново.");}
    public record Draft(String id,long revision,String step,JsonNode choices,Integer index,String next) {}
    private record Owner(AuthenticatedUser actor,long version,String faculty) {}
}
