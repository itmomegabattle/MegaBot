package ru.itmomegabattle.megabot.availability;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.time.format.DateTimeFormatter;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.notifications.TelegramTransport;
import tools.jackson.databind.ObjectMapper;

/** Internal DB-only editor state. No HTTP endpoint, provider calls or automatic consumer. */
@Service
@Transactional
public class TelegramSlotDraftService {
    /** Shared predicate for outbox materialization, final sender gate and confirmed panel lookup (payload alias d). */
    public static final String CURRENT_PANEL_SQL="""
            ((not jsonb_exists_any(d.payload,array['slotDraftId','slotRevision','slotSettingsVersion'])
              and d.payload->>'command'<>'slot_callback'
              and not (d.payload->>'command'='slots' and coalesce(d.payload->>'recipientRole' in ('admin','organizer'),false)))
             or (d.payload->>'command' in ('slots','slot_callback','back') and exists(
                select 1 from telegram_slot_drafts s join users u on u.id=s.user_id
                left join availability_weeks w on w.user_id=s.user_id and w.week_start=s.week_start
                where s.id=d.payload->>'slotDraftId' and s.bot_id=d.payload->>'botId'
                and s.chat_id::text=d.payload->>'chatId' and s.user_id=d.payload->>'recipientId'
                and s.revision::text=d.payload->>'slotRevision' and s.profile_version::text=d.payload->>'profileVersion'
                and s.status='open' and s.expires_at>clock_timestamp() and coalesce(w.version,0)=s.base_version
                and u.active and u.registered and u.telegram_id=s.chat_id and u.version=s.profile_version
                and u.role in ('admin','organizer') and u.role=d.payload->>'recipientRole'
                and exists(select 1 from chat_bindings b where b.bot_id=s.bot_id and b.chat_id=s.chat_id and b.type='private')
                and d.payload->>'slotSettingsVersion'=coalesce((select version::text from app_settings where setting_key='availability'),'0')
                and s.week_start >= date_trunc('week',clock_timestamp() at time zone 'Europe/Moscow')::date
                and d.payload->'replyMarkup'=s.panel->'markup' and d.payload->>'text'=s.panel->>'text')))
            """;
    private final JdbcClient jdbc;
    private final ObjectMapper json;
    private final AvailabilityService availability;

    TelegramSlotDraftService(JdbcClient jdbc, ObjectMapper json, AvailabilityService availability) {
        this.jdbc=jdbc; this.json=json; this.availability=availability;
    }

    /** Entry panel: persisted self summary and an opaque callback, not an executable callback handler. */
    public Panel openPanel(String bot,long chat) {
        var owner=owner(bot,chat);
        var response=availability.get(owner.actor(),null);
        var draft=open(bot,chat,response.weeks().getFirst().weekStart());
        return summaryPanel(draft,response);
    }

    private Panel summaryPanel(Draft draft,AvailabilityController.AvailabilityResponse response) {
        var text=new StringBuilder("Сохранённые слоты\n");
        var format=DateTimeFormatter.ofPattern("dd.MM");
        var dayNames=List.of("Пн","Вт","Ср","Чт","Пт","Сб","Вс");
        for(var week:response.weeks()) {
            text.append("\nНеделя ").append(week.weekStart().format(format)).append("–")
                    .append(week.weekStart().plusDays(6).format(format)).append('\n');
            if(week.outOfWeek()) {text.append("Я в ауте\n");continue;}
            for(var offset:response.settings().activeDays()) {
                var date=week.weekStart().plusDays(offset);
                var day=week.days().stream().filter(d->d.date().equals(date)).findFirst();
                text.append(dayNames.get(offset)).append(": ");
                if(day.isEmpty() || day.get().status().equals("unanswered"))text.append("не отмечено");
                else if(day.get().status().equals("unavailable"))text.append("не смогу");
                else text.append(hours(day.get().startMinutes()));
                text.append('\n');
            }
        }
        var markup=new TelegramTransport.InlineKeyboard(List.of(List.of(new TelegramTransport.InlineButton(
                "Изменить слоты","sl:"+draft.id()+":"+draft.revision()+":e")))).markup();
        return storePanel(new Panel(text.toString(),markup,draft.id(),draft.revision(),response.settings().version()));
    }

    /** Validation failures produce a bounded ack; no mutations occur until every source check passes. */
    public Panel beginEditing(String bot,long chat,long messageId,String id,long revision,String action) {
        try {
            requireConfirmedPanel(bot,chat,messageId,id,revision);
            var stored=jdbc.sql("select panel::text from telegram_slot_drafts where id=:id").param("id",id).query(String.class).single();
            var markup=TelegramTransport.InlineKeyboard.parse(json.readTree(stored).path("markup"));
            if(!action.startsWith("sl:"+id+":"+revision+":") || markup.rows().stream().flatMap(List::stream)
                    .noneMatch(button->button.callbackData().equals(action)))return null;
        }catch(ApiException stale) {return null;}
        return navigate(bot,chat,id,revision,action.substring(action.lastIndexOf(':')+1));
    }

    /** Typed navigation trusts the verified private owner, never a supplied callback/message ID. */
    public Panel backPanel(String bot,long chat) {
        Draft draft;String operation;
        try {
            var owner=owner(bot,chat);
            var id=jdbc.sql("select id from telegram_slot_drafts where bot_id=:bot and chat_id=:chat and user_id=:user and status='open'")
                    .param("bot",bot).param("chat",chat).param("user",owner.actor().id()).query(String.class).optional();
            if(id.isEmpty())return null;
            draft=load(bot,chat,id.get(),owner);
            if(snapshot(owner,draft.week()).version()!=draft.request().expectedVersion())return null;
            var stored=jdbc.sql("select panel::text from telegram_slot_drafts where id=:id").param("id",draft.id()).query(String.class).single();
            if(stored==null)return null;
            var actions=TelegramTransport.InlineKeyboard.parse(json.readTree(stored).path("markup")).rows().stream()
                    .flatMap(List::stream).map(b->b.callbackData().substring(b.callbackData().lastIndexOf(':')+1)).toList();
            if(actions.contains("c"))operation="w"+draft.week().format(DateTimeFormatter.BASIC_ISO_DATE);
            else if(actions.contains("b"))operation="b";
            else if(actions.stream().anyMatch(a->a.startsWith("w")))operation="r";
            else return null;
        }catch(ApiException stale) {return null;}
        return navigate(bot,chat,draft.id(),draft.revision(),operation);
    }

    private Panel navigate(String bot,long chat,String id,long revision,String operation) {
        Draft draft; LocalDate selectedWeek=null,selectedDay=null; WeekSelection selection=null;
        DayBaseline entry=null; AvailabilityController.SaveWeekRequest restored=null,edited=null; LocalDate saveDate=null;
        AvailabilityController.AvailabilityResponse response;
        try {
            draft=get(bot,chat,id);
            requireRevision(draft,revision);
            response=availability.get(owner(bot,chat).actor(),null);
            availability.validateWeek(draft.week(),draft.request());
            if(operation.startsWith("w")) {
                selectedWeek=LocalDate.parse(operation.substring(1),DateTimeFormatter.BASIC_ISO_DATE);
                selection=selectedWeek(owner(bot,chat),draft,selectedWeek);
            } else if(operation.startsWith("d")) {
                selectedDay=LocalDate.parse(operation.substring(1),DateTimeFormatter.BASIC_ISO_DATE);
                entry=dayEntry(draft,selectedDay);
            } else if(operation.equals("c")) {
                var baseline=baseline(id);
                if(baseline==null)return null;
                restored=cancelledDay(draft,baseline.date());selectedWeek=draft.week();
            } else if(operation.startsWith("h") || operation.equals("a") || operation.equals("u") || operation.equals("s")) {
                var baseline=baseline(id);
                if(baseline==null)return null;
                selectedDay=baseline.date();day(draft,selectedDay);
                if(operation.equals("s")) {saveDate=selectedDay;selectedDay=null;selectedWeek=draft.week();}
                else edited=editedDay(draft,selectedDay,operation,response.settings());
            } else if(operation.equals("o") || operation.equals("v")) {
                selectedWeek=draft.week();
                edited=operation.equals("o")?new AvailabilityController.SaveWeekRequest(!draft.request().outOfWeek(),List.of(),draft.request().expectedVersion()):draft.request();
                availability.validateWeek(draft.week(),edited);
            } else if(!operation.equals("e") && !operation.equals("b") && !operation.equals("r"))return null;
        }catch(ApiException | java.time.format.DateTimeParseException stale) {return null;}
        // Do not catch failures after the first write: the panel, baseline and outbox must roll back together.
        Draft next;
        if(saveDate!=null)next=saveDay(bot,chat,id,revision,saveDate);
        else if(operation.equals("v")) {save(bot,chat,id,revision);next=get(bot,chat,id);}
        else if(edited!=null)next=advance(draft,edited,operation.equals("o"));
        else if(entry!=null)next=enterDay(draft,entry);
        else if(restored!=null)next=advance(draft,restored,true);
        else if(selection!=null)next=moveWeek(draft,selectedWeek,selection);
        else next=advance(draft,draft.request(),true);
        if(operation.equals("r"))return summaryPanel(next,response);
        var format=DateTimeFormatter.ofPattern("dd.MM");
        var rows=new ArrayList<List<TelegramTransport.InlineButton>>();
        String text;
        if(selectedDay!=null) {
            var current=day(next,selectedDay);
            text="Слоты на "+selectedDay.format(format)+"\n"+dayStatus(current);
            var hourRow=new ArrayList<TelegramTransport.InlineButton>();
            for(int hour=response.settings().firstHour();hour<=response.settings().lastHour();hour++) {
                var label=(current.startMinutes().contains(hour*60)?"✓ ":"")+String.format(java.util.Locale.ROOT,"%02d:00",hour);
                hourRow.add(new TelegramTransport.InlineButton(label,"sl:"+id+":"+next.revision()+":h"+hour));
                if(hourRow.size()==4) {rows.add(List.copyOf(hourRow));hourRow.clear();}
            }
            if(!hourRow.isEmpty())rows.add(List.copyOf(hourRow));
            rows.add(List.of(new TelegramTransport.InlineButton(current.startMinutes().size()==response.settings().lastHour()-response.settings().firstHour()+1?"Очистить день":"Весь день",
                    "sl:"+id+":"+next.revision()+":a"),new TelegramTransport.InlineButton((current.status().equals("unavailable")?"✓ ":"")+"Не смогу","sl:"+id+":"+next.revision()+":u")));
            rows.add(List.of(new TelegramTransport.InlineButton("Сохранить день","sl:"+id+":"+next.revision()+":s")));
            rows.add(List.of(new TelegramTransport.InlineButton("Отменить изменения дня","sl:"+id+":"+next.revision()+":c")));
            rows.add(List.of(new TelegramTransport.InlineButton("К неделе","sl:"+id+":"+next.revision()+":w"+next.week().format(DateTimeFormatter.BASIC_ISO_DATE))));
        } else if(selectedWeek!=null) {
            text="Неделя "+selectedWeek.format(format)+"–"+selectedWeek.plusDays(6).format(format);
            if(next.request().outOfWeek())text+="\nЯ в ауте";
            else for(var offset:response.settings().activeDays()) {
                var date=next.week().plusDays(offset);
                rows.add(List.of(new TelegramTransport.InlineButton(date.format(format)+": "+dayStatus(day(next,date)),
                        "sl:"+id+":"+next.revision()+":d"+date.format(DateTimeFormatter.BASIC_ISO_DATE))));
            }
            rows.add(List.of(new TelegramTransport.InlineButton((next.request().outOfWeek()?"✓ ":"")+"Я в ауте","sl:"+id+":"+next.revision()+":o")));
            rows.add(List.of(new TelegramTransport.InlineButton("Сохранить неделю","sl:"+id+":"+next.revision()+":v")));
            if(operation.equals("s") || operation.equals("v"))text="Сохранено.\n"+text;
            rows.add(List.of(new TelegramTransport.InlineButton("К выбору недели","sl:"+id+":"+next.revision()+":b")));
        } else {
            text="Изменение слотов\n\nВыбери неделю.";
            for(var view:response.weeks()) {
                var week=view.weekStart();
                rows.add(List.of(new TelegramTransport.InlineButton("Неделя "+week.format(format)+"–"+week.plusDays(6).format(format),
                        "sl:"+id+":"+next.revision()+":w"+week.format(DateTimeFormatter.BASIC_ISO_DATE))));
            }
        }
        return storePanel(new Panel(text,new TelegramTransport.InlineKeyboard(rows).markup(),
                id,next.revision(),response.settings().version()));
    }

    private AvailabilityController.SaveWeekRequest editedDay(Draft draft,LocalDate date,String operation,AvailabilityController.SettingsView settings) {
        var current=day(draft,date);var minutes=new java.util.TreeSet<>(current.startMinutes());
        String status;
        if(operation.equals("u")) {
            minutes.clear();status=current.status().equals("unavailable")?"unanswered":"unavailable";
        } else {
            if(operation.equals("a")) {
                if(minutes.size()==settings.lastHour()-settings.firstHour()+1)minutes.clear();
                else for(int hour=settings.firstHour();hour<=settings.lastHour();hour++)minutes.add(hour*60);
            } else {
                int minute=Integer.parseInt(operation.substring(1))*60;
                if(!minutes.remove(minute))minutes.add(minute);
            }
            status=minutes.isEmpty()?"unanswered":"available";
        }
        var days=new ArrayList<>(draft.request().days().stream().filter(d->!d.date().equals(date)).toList());
        days.add(new AvailabilityController.DayMutation(date,status,List.copyOf(minutes)));
        var request=new AvailabilityController.SaveWeekRequest(false,days,draft.request().expectedVersion());
        return new AvailabilityController.SaveWeekRequest(false,availability.validateWeek(draft.week(),request),request.expectedVersion());
    }

    private static String dayStatus(AvailabilityController.DayMutation day) {
        return switch(day.status()) {
            case "unanswered" -> "не отмечено";
            case "unavailable" -> "не смогу";
            default -> hours(day.startMinutes());
        };
    }

    private Panel storePanel(Panel panel) {
        if(jdbc.sql("update telegram_slot_drafts set panel=cast(:panel as jsonb) where id=:id and expires_at>clock_timestamp()")
                .param("panel",json.writeValueAsString(Map.of("text",panel.text(),"markup",panel.markup())))
                .param("id",panel.draftId()).update()!=1)throw conflict("slot_draft_expired");
        return panel;
    }

    /** A provider ID is accepted only from a committed sent delivery; draft IDs alone grant no authority. */
    public void requireConfirmedPanel(String bot,long chat,long messageId,String id,long revision) {
        var owner=owner(bot,chat);var draft=load(bot,chat,id,owner);requireRevision(draft,revision);
        if(messageId<1 || !jdbc.sql("""
                select exists(select 1 from notification_deliveries d join outbox_events o on o.id=d.command_reply_outbox_id
                join telegram_inbox i on i.id=o.aggregate_id
                where d.status='sent' and d.telegram_message_id=:message and d.chat_id=:chat and d.message_thread_id is null
                and d.category='telegram_command_reply' and d.recipient_id=:user and d.payload=o.payload
                and o.status='completed' and o.aggregate_type='telegram_inbox' and o.event_type='telegram_command_reply'
                and i.status='completed' and i.bot_id=:bot and d.payload->>'command' in ('slots','slot_callback','back')
                and d.payload->>'slotDraftId'=:draft and d.payload->>'slotRevision'=:revision
                and
                """+CURRENT_PANEL_SQL+")").param("message",messageId).param("chat",chat).param("user",owner.actor().id())
                .param("bot",bot).param("draft",id).param("revision",Long.toString(revision)).query(Boolean.class).single())
            throw conflict("slot_panel_unconfirmed");
    }

    public record Panel(String text,Map<String,Object> markup,String draftId,long revision,long settingsVersion) {}

    private static String hours(List<Integer> minutes) {
        var ranges=new ArrayList<String>();
        for(int i=0;i<minutes.size();i++) {
            int first=minutes.get(i),last=first;
            while(i+1<minutes.size() && minutes.get(i+1)==last+60)last=minutes.get(++i);
            var start=String.format(java.util.Locale.ROOT,"%02d:00",first/60);
            ranges.add(first==last?start:start+"–"+String.format(java.util.Locale.ROOT,"%02d:00",last/60));
        }
        return String.join(", ",ranges);
    }

    Draft open(String bot, long chat, LocalDate week) {
        var owner=owner(bot,chat);
        var snapshot=snapshot(owner,week);
        var request=request(snapshot);
        availability.validateWeek(week,request);
        jdbc.sql("update telegram_slot_drafts set status='cancelled' where bot_id=:bot and chat_id=:chat and status='open'")
                .param("bot",bot).param("chat",chat).update();
        var id="sd_"+UUID.randomUUID();
        jdbc.sql("""
                insert into telegram_slot_drafts(id,bot_id,user_id,chat_id,profile_version,week_start,base_version,payload)
                values (:id,:bot,:user,:chat,:profile,:week,:base,cast(:payload as jsonb))
                """).param("id",id).param("bot",bot).param("user",owner.actor().id()).param("chat",chat)
                .param("profile",owner.version()).param("week",week).param("base",snapshot.version())
                .param("payload",json.writeValueAsString(request)).update();
        return load(bot,chat,id,owner);
    }

    Draft get(String bot,long chat,String id) { return load(bot,chat,id,owner(bot,chat)); }

    /** Park other weeks inside the same durable editor; navigation never publishes or discards their edits. */
    Draft selectWeek(String bot,long chat,String id,long revision,LocalDate week) {
        var owner=owner(bot,chat);var draft=load(bot,chat,id,owner);requireRevision(draft,revision);
        return moveWeek(draft,week,selectedWeek(owner,draft,week));
    }

    private WeekSelection selectedWeek(Owner owner,Draft draft,LocalDate week) {
        var id=draft.id();
        var current=snapshot(owner,week);
        var pending=(tools.jackson.databind.node.ObjectNode)json.readTree(jdbc.sql(
                "select pending_weeks::text from telegram_slot_drafts where id=:id").param("id",id).query(String.class).single());
        var selected=week.equals(draft.week())?draft.request():pending.has(week.toString())
                ?json.treeToValue(pending.get(week.toString()),AvailabilityController.SaveWeekRequest.class):request(current);
        if(selected.expectedVersion()!=current.version())throw conflict("stale_version");
        availability.validateWeek(week,selected);
        pending.set(draft.week().toString(),json.valueToTree(draft.request()));
        pending.remove(week.toString());
        return new WeekSelection(selected,pending);
    }

    private Draft moveWeek(Draft draft,LocalDate week,WeekSelection selection) {
        var id=draft.id();var selected=selection.request();var pending=selection.pending();
        if(jdbc.sql("""
                update telegram_slot_drafts set pending_weeks=cast(:pending as jsonb),week_start=:week
                where id=:id and expires_at>clock_timestamp()
                """).param("pending",json.writeValueAsString(pending)).param("week",week).param("id",id).update()!=1)
            throw conflict("slot_draft_expired");
        return advance(new Draft(id,week,draft.revision(),selected),selected,true);
    }

    /** Capture the pending day once, not its saved DB value or its value after each hour toggle. */
    Draft beginDay(String bot,long chat,String id,long revision,LocalDate date) {
        var draft=load(bot,chat,id,owner(bot,chat));requireRevision(draft,revision);
        return enterDay(draft,dayEntry(draft,date));
    }

    private DayBaseline dayEntry(Draft draft,LocalDate date) {
        var day=day(draft,date);var baseline=baseline(draft.id());
        if(baseline!=null && baseline.date().equals(date))return baseline;
        var present=draft.request().days().stream().anyMatch(d->d.date().equals(date));
        return new DayBaseline(date,present?day:null);
    }

    private Draft enterDay(Draft draft,DayBaseline entry) {
        if(jdbc.sql("""
                update telegram_slot_drafts set day_baseline=cast(:baseline as jsonb)
                where id=:id and expires_at>clock_timestamp()
                """).param("baseline",json.writeValueAsString(entry)).param("id",draft.id()).update()!=1)
            throw conflict("slot_draft_expired");
        return advance(draft,draft.request());
    }

    Draft cancelDay(String bot,long chat,String id,long revision,LocalDate date) {
        var draft=load(bot,chat,id,owner(bot,chat));requireRevision(draft,revision);
        return advance(draft,cancelledDay(draft,date),true);
    }

    private AvailabilityController.SaveWeekRequest cancelledDay(Draft draft,LocalDate date) {
        day(draft,date);var baseline=baseline(draft.id());
        if(baseline==null || !baseline.date().equals(date))throw conflict("slot_day_baseline_unavailable");
        var days=new ArrayList<>(draft.request().days().stream().filter(d->!d.date().equals(date)).toList());
        if(baseline.day()!=null)days.add(baseline.day());
        var restored=new AvailabilityController.SaveWeekRequest(false,days,draft.request().expectedVersion());
        var normalized=availability.validateWeek(draft.week(),restored);
        return new AvailabilityController.SaveWeekRequest(false,normalized,restored.expectedVersion());
    }

    private DayBaseline baseline(String id) {
        return json.readValue(jdbc.sql("select coalesce(day_baseline::text,'null') from telegram_slot_drafts where id=:id")
                .param("id",id).query(String.class).single(),DayBaseline.class);
    }

    Draft replace(String bot,long chat,String id,long revision,AvailabilityController.SaveWeekRequest request) {
        var draft=load(bot,chat,id,owner(bot,chat)); requireRevision(draft,revision);
        if(request==null || request.expectedVersion()!=draft.request().expectedVersion())throw conflict("stale_version");
        var days=availability.validateWeek(draft.week(),request);
        var normalized=new AvailabilityController.SaveWeekRequest(request.outOfWeek(),days,request.expectedVersion());
        return advance(draft,normalized,request.outOfWeek());
    }

    AvailabilityController.WeekView save(String bot,long chat,String id,long revision) {
        var owner=owner(bot,chat);var draft=load(bot,chat,id,owner);requireRevision(draft,revision);
        var result=availability.saveWeek(owner.actor(),null,draft.week(),draft.request());
        advance(draft,request(result),true);return result;
    }

    /** Save only the selected day; keep other pending edits and advance their common week version. */
    Draft saveDay(String bot,long chat,String id,long revision,LocalDate date) {
        var owner=owner(bot,chat);var draft=load(bot,chat,id,owner);requireRevision(draft,revision);
        var day=day(draft,date);
        var pending=availability.validateWeek(draft.week(),draft.request());
        var current=snapshot(owner,draft.week());
        var merged=new ArrayList<AvailabilityController.DayMutation>();
        current.days().stream().filter(d->!d.date().equals(date)).forEach(d->merged.add(
                new AvailabilityController.DayMutation(d.date(),d.status(),d.startMinutes())));
        merged.add(day);
        var saved=availability.saveWeek(owner.actor(),null,draft.week(),new AvailabilityController.SaveWeekRequest(
                false,merged,draft.request().expectedVersion()));
        var baseline=baseline(id);
        return advance(draft,new AvailabilityController.SaveWeekRequest(false,pending,saved.version()),
                baseline!=null && baseline.date().equals(date));
    }

    private AvailabilityController.DayMutation day(Draft draft,LocalDate date) {
        if(draft.request().outOfWeek())throw conflict("slot_draft_out_of_week");
        var day=availability.validateWeek(draft.week(),draft.request()).stream().filter(d->d.date().equals(date)).findFirst()
                .orElse(new AvailabilityController.DayMutation(date,"unanswered",List.of()));
        // Missing/unanswered dates must still belong to an active day in the current horizon.
        availability.validateWeek(draft.week(),new AvailabilityController.SaveWeekRequest(false,List.of(day),draft.request().expectedVersion()));
        return day;
    }

    private Draft advance(Draft draft,AvailabilityController.SaveWeekRequest request) {
        return advance(draft,request,false);
    }

    private Draft advance(Draft draft,AvailabilityController.SaveWeekRequest request,boolean clearBaseline) {
        // Week, audit and draft version share this transaction, including expiry after a SQL wait.
        if(jdbc.sql("""
                update telegram_slot_drafts set payload=cast(:payload as jsonb),base_version=:base,revision=revision+1,panel=null,
                    day_baseline=case when :clear then null else day_baseline end
                where id=:id and expires_at>clock_timestamp()
                """).param("payload",json.writeValueAsString(request)).param("base",request.expectedVersion()).param("clear",clearBaseline)
                .param("id",draft.id()).update()!=1)
            throw conflict("slot_draft_expired");
        return new Draft(draft.id(),draft.week(),draft.revision()+1,request);
    }

    private AvailabilityController.WeekView snapshot(Owner owner,LocalDate week) {
        return availability.get(owner.actor(),null).weeks().stream().filter(w->w.weekStart().equals(week)).findFirst()
                .orElseThrow(()->conflict("week_outside_horizon"));
    }

    private static AvailabilityController.SaveWeekRequest request(AvailabilityController.WeekView week) {
        return new AvailabilityController.SaveWeekRequest(week.outOfWeek(),week.days().stream()
                .map(d->new AvailabilityController.DayMutation(d.date(),d.status(),d.startMinutes())).toList(),week.version());
    }

    /** Validated private navigation closes only this bot/chat owner's editor, including stale/expired drafts. */
    public void leaveEditor(String bot,long chat,String userId) {
        if(bot==null || !bot.matches("[1-9][0-9]{0,19}") || chat<=0 || userId==null || userId.isBlank())
            throw conflict("invalid_slot_owner");
        // Same parent-first lock order as callback mutations and availability saves; roles may have changed.
        if(jdbc.sql("select id from users where id=:user and telegram_id=:chat and active for no key update")
                .param("user",userId).param("chat",chat).query(String.class).optional().isEmpty())return;
        jdbc.sql("update telegram_slot_drafts set status='cancelled' where bot_id=:bot and chat_id=:chat and user_id=:user and status='open'")
                .param("bot",bot).param("chat",chat).param("user",userId).update();
    }

    void cancel(String bot,long chat,String id,long revision) {
        var draft=load(bot,chat,id,owner(bot,chat));requireRevision(draft,revision);finish(id,"cancelled");
    }

    private void finish(String id,String status) {
        // A caller may wait on domain SQL: don't commit changes after this editor's deadline.
        if(jdbc.sql("update telegram_slot_drafts set status=:status where id=:id and expires_at>clock_timestamp()")
                .param("status",status).param("id",id).update()!=1)throw conflict("slot_draft_expired");
    }

    private Owner owner(String bot,long chat) {
        if(bot==null || !bot.matches("[1-9][0-9]{0,19}") || chat<=0)throw conflict("invalid_slot_owner");
        // Stable parent lock first, same order as all availability saves; no trust in callback user IDs/roles.
        return jdbc.sql("""
                select id,username,real_name,role,version from users
                where telegram_id=:chat and active and role in ('admin','organizer') for no key update
                """).param("chat",chat).query((r,i)->new Owner(new AuthenticatedUser(r.getString("id"),
                r.getString("username"),r.getString("real_name"),r.getString("role")),r.getLong("version")))
                .optional().orElseThrow(()->new ApiException(HttpStatus.FORBIDDEN,"slot_owner_unavailable","Слоты недоступны"));
    }

    private Draft load(String bot,long chat,String id,Owner owner) {
        var draft=jdbc.sql("""
                select id,week_start,revision,payload::text from telegram_slot_drafts
                where id=:id and bot_id=:bot and chat_id=:chat and user_id=:user and profile_version=:profile
                and status='open' and expires_at>clock_timestamp() for update
                """).param("id",id).param("bot",bot).param("chat",chat).param("user",owner.actor().id())
                .param("profile",owner.version()).query((r,i)->new Draft(r.getString("id"),r.getObject("week_start",LocalDate.class),
                r.getLong("revision"),json.readValue(r.getString("payload"),AvailabilityController.SaveWeekRequest.class)))
                .optional().orElseThrow(()->conflict("slot_draft_unavailable"));
        if(!jdbc.sql("select expires_at>clock_timestamp() from telegram_slot_drafts where id=:id")
                .param("id",id).query(Boolean.class).single())throw conflict("slot_draft_expired");
        return draft;
    }
    private static void requireRevision(Draft draft,long revision) {
        if(draft.revision()!=revision)throw conflict("stale_slot_draft");
    }
    private static ApiException conflict(String code) { return new ApiException(HttpStatus.CONFLICT,code,"Редактор слотов устарел. Откройте его заново."); }
    record Draft(String id,LocalDate week,long revision,AvailabilityController.SaveWeekRequest request) {}
    private record WeekSelection(AvailabilityController.SaveWeekRequest request,tools.jackson.databind.node.ObjectNode pending) {}
    private record DayBaseline(LocalDate date,AvailabilityController.DayMutation day) {}
    private record Owner(AuthenticatedUser actor,long version) {}
}
