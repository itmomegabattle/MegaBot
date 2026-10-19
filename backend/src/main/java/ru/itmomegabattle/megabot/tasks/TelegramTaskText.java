package ru.itmomegabattle.megabot.tasks;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.notifications.TelegramTransport;
import ru.itmomegabattle.megabot.team.UserEntity;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Read-only snapshots; task mutations still belong to TaskService. */
@Service
public class TelegramTaskText {
    private static final List<String> COMMANDS=List.of("tasks","my_tasks","open_tasks","completed_tasks");
    public static final String SOURCE_SQL="""
            (d.payload->>'command' not in ('tasks','my_tasks','open_tasks','completed_tasks') or
              d.payload->>'command'=case lower(regexp_replace(i.payload->'message'->>'text','^[[:space:]]+|[[:space:]]+$','','g'))
                when 'задачи' then 'tasks' when '/tasks' then 'tasks' when 'мои задачи' then 'my_tasks'
                when 'свободные задачи' then 'open_tasks' when 'выполненные задачи' then 'completed_tasks' else null end)
            """;
    private static final String FACULTY_REFUSAL="Этот раздел доступен организаторам и администратору. Откройте «Мои задачи».";
    private static final String SELECTED_SQL="""
            ((:section in ('tasks','my_tasks') and t.status not in ('completed','cancelled')
                and exists(select 1 from task_assignees own where own.task_id=t.id and own.user_id=:actor))
             or (:section='completed_tasks' and t.status='completed'
                and exists(select 1 from task_assignees own where own.task_id=t.id and own.user_id=:actor))
             or (:section='open_tasks' and :core and t.status='open' and t.faculty_id is null and not t.faculty_all))
            """;
    /** d needs only payload. The same read policy is rechecked at planner/start/pre-HTTP. */
    public static final String CURRENT_VIEW_SQL="""
            (d.payload->>'command' not in ('tasks','my_tasks','open_tasks','completed_tasks')
             or not jsonb_exists(d.payload,'recipientId')
             or exists(select 1 from users u cross join lateral (select case when jsonb_typeof(d.payload->'taskView')='array'
                 then d.payload->'taskView' else '[]'::jsonb end refs) snapshot
               where u.id=d.payload->>'recipientId' and u.active and u.registered
               and u.telegram_id::text=d.payload->>'chatId' and u.role=d.payload->>'recipientRole'
               and u.role in ('admin','organizer','faculty_responsible','faculty_helper')
               and jsonb_typeof(d.payload->'profileVersion')='number' and u.version::text=d.payload->>'profileVersion'
               and exists(select 1 from chat_bindings b where b.bot_id=d.payload->>'botId' and b.chat_id=u.telegram_id and b.type='private')
               and jsonb_typeof(d.payload->'taskView')='array' and jsonb_array_length(snapshot.refs)<=10
               and ((u.role in ('admin','organizer') and not jsonb_exists(d.payload,'taskFacultyId'))
                 or (u.role in ('faculty_responsible','faculty_helper') and jsonb_exists(d.payload,'taskFacultyId')
                   and d.payload->'taskFacultyId'=coalesce(to_jsonb((select faculty_id from faculty_memberships where user_id=u.id)),'null'::jsonb)))
               and ((u.role in ('faculty_responsible','faculty_helper') and d.payload->>'command' in ('open_tasks','completed_tasks')
                 and snapshot.refs='[]'::jsonb
                 and d.payload->>'text'='Этот раздел доступен организаторам и администратору. Откройте «Мои задачи».'
                 and d.payload->'replyMarkup'='{"keyboard":[[{"text":"Мои задачи"},{"text":"Помощь"}]],"resize_keyboard":true,"is_persistent":false,"one_time_keyboard":false}'::jsonb)
                or ((u.role in ('admin','organizer') or d.payload->>'command' in ('tasks','my_tasks'))
                 and (select count(distinct ref->>'id') from jsonb_array_elements(snapshot.refs) ref
                   join tasks t on t.id=ref->>'id' where jsonb_typeof(ref->'id')='string'
                     and jsonb_typeof(ref->'version')='number' and t.version::text=ref->>'version' and
            """+TaskService.VISIBLE_SQL.replace(":core","(u.role in ('admin','organizer'))").replace(":actor","u.id")+" and "
            +SELECTED_SQL.replace(":section","(d.payload->>'command')").replace(":core","(u.role in ('admin','organizer'))").replace(":actor","u.id")
            +")=jsonb_array_length(snapshot.refs)))))";
    private static final DateTimeFormatter DATE=DateTimeFormatter.ofPattern("dd.MM.uuuu, HH:mm").withZone(ZoneId.of("Europe/Moscow"));
    private final JdbcClient jdbc;
    private final ObjectMapper json;
    public TelegramTaskText(JdbcClient jdbc,ObjectMapper json) {this.jdbc=jdbc;this.json=json;}

    public static boolean supported(String command) {return COMMANDS.contains(command);}

    @Transactional(propagation=Propagation.MANDATORY)
    public Panel render(UserEntity user,String command) {
        if(!supported(command))throw new IllegalArgumentException("invalid_task_view");
        boolean core=List.of("admin","organizer").contains(user.getRole());
        if(!user.isActive() || !user.isRegistered() || (!core && !List.of("faculty_responsible","faculty_helper").contains(user.getRole())))
            throw new ApiException(HttpStatus.FORBIDDEN,"task_view_forbidden","Раздел задач недоступен.");
        var faculty=core?null:jdbc.sql("select faculty_id from faculty_memberships where user_id=:actor").param("actor",user.getId()).query(String.class).optional().orElse(null);
        var refs=json.createArrayNode();
        if(!core && List.of("open_tasks","completed_tasks").contains(command))
            return panel(FACULTY_REFUSAL,List.of(List.of("Мои задачи","Помощь")),refs,faculty);
        int limit=List.of("tasks","my_tasks").contains(command)?8:10;
        var rows=jdbc.sql("""
                select t.id,t.title,t.status,t.description,t.due_at,t.legacy_deadline,t.version,creator.real_name as creator
                from tasks t left join users creator on creator.id=t.creator_id where
                """+TaskService.VISIBLE_SQL+" and "+SELECTED_SQL
                +" order by "+("completed_tasks".equals(command)?"t.created_at desc,t.id desc":"t.created_at,t.id")+" limit :limit")
                .param("core",core).param("actor",user.getId()).param("section",command).param("limit",limit+1)
                .query((r,i)->new Row(r.getString("id"),r.getString("title"),r.getString("status"),r.getString("description"),
                        r.getTimestamp("due_at")==null?null:r.getTimestamp("due_at").toInstant(),r.getString("legacy_deadline"),r.getLong("version"),r.getString("creator"))).list();
        var shown=rows.stream().limit(limit).toList();
        shown.forEach(row->refs.addObject().put("id",row.id()).put("version",row.version()));
        var text=new StringBuilder(switch(command) {
            case "open_tasks"->shown.isEmpty()?"Свободных задач сейчас нет.":"Свободные задачи\n\n";
            case "completed_tasks"->shown.isEmpty()?"Выполненных задач пока нет.":"Последние выполненные задачи\n\n";
            default->!core?(shown.isEmpty()?"Активных задач пока нет.":"Твои задачи:\n\n"):"Мои задачи\n\n";
        });
        if(core && shown.isEmpty() && List.of("tasks","my_tasks").contains(command))text.append("Активных задач нет.");
        for(int n=0;n<shown.size();n++) {
            var row=shown.get(n);
            if(n>0)text.append("\n\n");
            if("completed_tasks".equals(command))text.append("• ").append(bounded(row.title(),160));
            else {
                text.append(n+1).append(". ").append(bounded(row.title(),core?160:120));
                if(!"open_tasks".equals(command))text.append(core?" · ":"\nСтатус: ").append(status(row.status()));
                text.append("\nДедлайн: ").append(row.due()==null?(row.legacy()==null || row.legacy().isBlank()?"не указан":bounded(row.legacy(),60)):DATE.format(row.due())+" (МСК)");
                if(!core)text.append("\nАвтор: ").append(row.creator()==null?"не указан":bounded(row.creator(),40))
                        .append(row.description().isBlank()?"":"\n"+bounded(row.description(),100));
            }
        }
        if(core && "tasks".equals(command)) {
            var count=jdbc.sql("select count(*) from tasks t where "+TaskService.VISIBLE_SQL+" and t.status='open' and t.faculty_id is null and not t.faculty_all")
                    .param("core",true).param("actor",user.getId()).query(Long.class).single();
            text.append("\n\nСвободных задач на доске: ").append(count);
        }
        // ponytail: bounded Telegram read snapshot; full pagination/mutation controls remain a separate flow before enabling the consumer.
        if(rows.size()>limit)text.append("\n\nОстальные задачи доступны в Mini App.");
        List<List<String>> keyboard=!core?(shown.isEmpty()?List.of(List.of("Мои задачи","Помощь")):List.of(List.of("Установить статус задачи"),List.of("Мои задачи","Помощь")))
                :"open_tasks".equals(command)?List.of(List.of("Меню"))
                :"completed_tasks".equals(command)?List.of(List.of("Назад"))
                :List.of(List.of("Управлять задачами","Создать задачу"),List.of("Свободные задачи","Выполненные задачи"),List.of("Назад"));
        return panel(text.toString(),keyboard,refs,faculty);
    }

    private Panel panel(String text,List<List<String>> keyboard,JsonNode refs,String faculty) {
        if(text.length()>4000)throw new IllegalStateException("task_view_too_long");
        return new Panel(text,json.valueToTree(new TelegramTransport.ReplyKeyboard(keyboard).markup()),refs,faculty);
    }
    private static String status(String value) {
        return switch(value) {case "assigned","in_progress"->"В работе";case "waiting"->"Ждет";case "completed"->"Выполнена";case "cancelled"->"Отменена";default->"Открытая";};
    }
    private static String bounded(String text,int limit) {
        if(text.length()<=limit)return text;
        int end=Character.isHighSurrogate(text.charAt(limit-1))?limit-1:limit;
        return text.substring(0,end)+"…";
    }
    private record Row(String id,String title,String status,String description,Instant due,String legacy,long version,String creator) {}
    public record Panel(String text,JsonNode markup,JsonNode tasks,String facultyId) {}
}
