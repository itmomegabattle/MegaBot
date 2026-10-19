package ru.itmomegabattle.megabot.meetings;

import java.util.UUID;
import java.util.List;
import java.util.ArrayList;
import java.util.Locale;
import java.time.Clock;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.notifications.TelegramTransport;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/** Durable private creation dialog; final domain effects share the draft transaction. */
@Service
@Transactional
public class TelegramMeetingDraftService {
    public static final String AUDIENCE_REFUSAL="Откройте «Назначить собрание» заново и дождитесь выбора аудитории.";
    /** Same exact source choice at materialization, sending and confirmed prompt lookup. */
    public static final String AUDIENCE_SOURCE_SQL="""
            (d.payload->>'command'<>'meeting_audience' or
             d.payload->>'meetingAudience'=case lower(regexp_replace(i.payload->'message'->>'text','^\\s+|\\s+$','','g'))
                when 'собрать всю команду' then 'all' when 'выбрать блок' then 'block' else null end)
            """;
    public static final String TEXT_SOURCE_SQL="""
            (d.payload->>'command'<>'meeting_text' or
             (jsonb_typeof(d.payload->'meetingInput')='string' and jsonb_typeof(i.payload->'message'->'text')='string'
              and d.payload->>'meetingInput'=i.payload->'message'->>'text'))
            """;
    /** Concrete previously committed offer; aliases q/qo/qi refer to its immutable delivery snapshot/source. */
    private static final String OFFER_SQL="""
            q.category='telegram_command_reply' and q.status='sent' and q.telegram_message_id>0
            and not q.cancel_requested and not q.disable_notification and q.message_thread_id is null
            and q.operation_id=qo.id and q.payload=qo.payload and qo.status='completed'
            and qo.aggregate_type='telegram_inbox' and qo.event_type='telegram_command_reply' and qi.status='completed'
            and q.payload->>'botId'=qi.bot_id and qi.chat_key=qi.bot_id||':chat:'||q.chat_id::text
            and q.chat_id>0 and q.payload->>'chatId'=q.chat_id::text and q.recipient_id=q.payload->>'recipientId'
            and not jsonb_exists(q.payload,'operation')
            and qi.payload->'message'->'chat'->>'type'='private'
            and qi.payload->'message'->'chat'->>'id'=q.chat_id::text
            and qi.payload->'message'->'from'->>'id'=q.chat_id::text
            and qi.payload->'message'->'from'->'is_bot'='false'::jsonb
            and qi.payload->'message'->>'message_id'=q.payload->>'sourceMessageId'
            and not jsonb_exists_any(qi.payload->'message',array['sender_chat','forward_origin','via_bot','business_connection_id'])
            and ((q.payload->>'command'='meeting_begin' and lower(regexp_replace(qi.payload->'message'->>'text','^[[:space:]]+|[[:space:]]+$','','g'))='назначить собрание')
              or (q.payload->>'command'='back' and lower(regexp_replace(qi.payload->'message'->>'text','^[[:space:]]+|[[:space:]]+$','','g'))='назад')
              or (q.payload->>'command'='meeting_audience' and q.payload->>'meetingAudience'=case lower(regexp_replace(qi.payload->'message'->>'text','^[[:space:]]+|[[:space:]]+$','','g'))
                when 'собрать всю команду' then 'all' when 'выбрать блок' then 'block' else null end)
              or (q.payload->>'command'='meeting_text' and jsonb_typeof(q.payload->'meetingInput')='string'
                and q.payload->'meetingInput'=qi.payload->'message'->'text'))
            """;
    /** Shared by mutation lookup, planner and sender; no inferred ordering of Telegram IDs. */
    public static final String CONSUMED_OFFER_SQL="""
            (not jsonb_exists(d.payload,'meetingDraftId') or d.payload->>'command' not in ('meeting_audience','meeting_text','back') or (
              jsonb_typeof(d.payload->'meetingOfferId')='string'
              and (d.payload->>'command'<>'back' or lower(regexp_replace(i.payload->'message'->>'text','^[[:space:]]+|[[:space:]]+$','','g'))='назад')
              and not jsonb_exists_any(i.payload->'message',array['message_thread_id','is_topic_message','business_connection_id','sender_business_bot','external_reply','guest_query_id','guest_bot_caller_user','guest_bot_caller_chat','receiver_user','ephemeral_message_id','direct_messages_topic'])
              and jsonb_typeof(i.payload->'message'->'reply_to_message'->'message_id')='number'
              and jsonb_typeof(i.payload->'message'->'reply_to_message'->'date')='number'
              and (i.payload->'message'->'reply_to_message'->>'date') ~ '^[1-9][0-9]*$'
              and i.payload->'message'->'reply_to_message'->'chat'->>'type'='private'
              and jsonb_typeof(i.payload->'message'->'reply_to_message'->'chat'->'id')='number'
              and i.payload->'message'->'reply_to_message'->'chat'->>'id'=d.payload->>'chatId'
              and jsonb_typeof(i.payload->'message'->'reply_to_message'->'from'->'id')='number'
              and i.payload->'message'->'reply_to_message'->'from'->>'id'=d.payload->>'botId'
              and i.payload->'message'->'reply_to_message'->'from'->'is_bot'='true'::jsonb
              and not jsonb_exists_any(i.payload->'message'->'reply_to_message',array['message_thread_id','is_topic_message','sender_chat','forward_origin','via_bot','business_connection_id','sender_business_bot','external_reply','guest_query_id','guest_bot_caller_user','guest_bot_caller_chat','receiver_user','ephemeral_message_id','direct_messages_topic'])
              and exists(select 1 from notification_deliveries q join outbox_events qo on qo.id=q.command_reply_outbox_id
                join telegram_inbox qi on qi.id=qo.aggregate_id where q.id=d.payload->>'meetingOfferId'
                and q.telegram_message_id::text=i.payload->'message'->'reply_to_message'->>'message_id'
                and q.payload->>'botId'=d.payload->>'botId' and q.payload->>'chatId'=d.payload->>'chatId'
                and q.payload->>'recipientId'=d.payload->>'recipientId' and q.payload->>'recipientRole'=d.payload->>'recipientRole'
                and q.payload->>'profileVersion'=d.payload->>'profileVersion' and q.payload->>'meetingDraftId'=d.payload->>'meetingDraftId'
                and jsonb_typeof(q.payload->'meetingRevision')='number' and jsonb_typeof(d.payload->'meetingRevision')='number'
                and (q.payload->'meetingRevision'=d.payload->'meetingRevision'
                  or (case when jsonb_typeof(q.payload->'meetingRevision')='number' then (q.payload->>'meetingRevision')::numeric end)+1
                    =case when jsonb_typeof(d.payload->'meetingRevision')='number' then (d.payload->>'meetingRevision')::numeric end)
                and
            """+OFFER_SQL+")))";
    /** Shared current private prompt predicate; d needs only its payload column. */
    public static final String CURRENT_PANEL_SQL="""
            ((not jsonb_exists_any(d.payload,array['meetingDraftId','meetingRevision'])
              and not (d.payload->>'command'='meeting_begin' and coalesce(d.payload->>'recipientRole' in ('admin','organizer'),false))
              and (d.payload->>'command' not in ('meeting_audience','meeting_text') or not coalesce(d.payload->>'recipientRole' in ('admin','organizer'),false)
                or (d.payload->>'text'='Откройте «Назначить собрание» заново и дождитесь выбора аудитории.'
                  and d.payload->'replyMarkup'='{"keyboard":[[{"text":"Назначить собрание"}],[{"text":"Меню"},{"text":"Назад"}]],"resize_keyboard":true,"is_persistent":false,"one_time_keyboard":false}'::jsonb)))
             or (d.payload->>'command' in ('meeting_begin','meeting_audience','meeting_text','back') and exists(
                select 1 from telegram_meeting_drafts s join users u on u.id=s.user_id
                where s.id=d.payload->>'meetingDraftId' and s.bot_id=d.payload->>'botId'
                and s.chat_id::text=d.payload->>'chatId' and s.user_id=d.payload->>'recipientId'
                and s.revision::text=d.payload->>'meetingRevision' and s.profile_version::text=d.payload->>'profileVersion'
                and jsonb_typeof(d.payload->'meetingRevision')='number' and jsonb_typeof(d.payload->'profileVersion')='number'
                and (s.status='open' or (s.status='cancelled' and d.payload->>'command'='back' and s.step='choose_type' and s.panel->'exit'='true'::jsonb)
                  or (s.status='completed' and d.payload->>'command'='meeting_text'
                  and s.panel->>'completedMeetingId'=s.meeting_id and jsonb_typeof(s.panel->'meetingVersion')='number'
                  and exists(select 1 from meetings m where m.id=s.meeting_id and m.host_id=s.user_id
                    and m.status='scheduled' and m.version::text=s.panel->>'meetingVersion')))
                and s.step=s.panel->>'step' and d.payload->>'command'=s.panel->>'command'
                and coalesce(d.payload->>'meetingAudience','')=coalesce(s.panel->>'audienceMode','') and s.expires_at>clock_timestamp()
                and coalesce(d.payload->>'meetingOfferId','')=coalesce(s.panel->>'offerId','')
                and (d.payload->>'command'<>'meeting_text' or d.payload->>'meetingInput'=s.panel->>'input')
                and u.active and u.registered and u.telegram_id=s.chat_id and u.version=s.profile_version
                and u.role in ('admin','organizer') and u.role=d.payload->>'recipientRole'
                and exists(select 1 from chat_bindings b where b.bot_id=s.bot_id and b.chat_id=s.chat_id and b.type='private')
                and d.payload->>'text'=s.panel->>'text' and d.payload->'replyMarkup'=s.panel->'markup')))
            """;
    private final JdbcClient jdbc;
    private final ObjectMapper json;
    private final MeetingService meetings;
    private final Clock clock;

    public TelegramMeetingDraftService(JdbcClient jdbc, ObjectMapper json, MeetingService meetings, Clock clock) {
        this.jdbc=jdbc; this.json=json; this.meetings=meetings; this.clock=clock;
    }

    public Draft begin(String bot, long chat) {
        var owner=owner(bot,chat);
        leaveDialog(bot,chat,owner.actor().id());
        var id="meeting_draft_"+UUID.randomUUID();
        jdbc.sql("""
                insert into telegram_meeting_drafts(id,bot_id,chat_id,user_id,profile_version,step)
                values (:id,:bot,:chat,:user,:profile,'choose_type')
                """).param("id",id).param("bot",bot).param("chat",chat)
                .param("user",owner.actor().id()).param("profile",owner.version()).update();
        return load(bot,chat,id,owner);
    }

    public Panel beginPanel(String bot,long chat) {
        return audiencePanel(begin(bot,chat),"meeting_begin");
    }

    public static String audienceMode(String text) {
        return switch(text==null?"":text.trim().toLowerCase(Locale.ROOT)) {
            case "собрать всю команду"->"all";case "выбрать блок"->"block";default->null;
        };
    }

    public Panel chooseAudiencePanel(String bot,long chat,String mode,JsonNode message) {
        Draft draft;String offer;
        try {
            draft=open(bot,chat);
            offer=consumedOffer(bot,chat,draft,message);
            if(!"choose_type".equals(draft.step()) || offer==null)return null;
        }catch(ApiException unavailable) {return null;}
        return bindOffer(audiencePanel(chooseAudience(bot,chat,draft.id(),draft.revision(),mode),"meeting_audience"),offer);
    }

    public Panel backAudiencePanel(String bot,long chat,JsonNode message,java.util.function.Supplier<String> entryText) {
        Draft draft;
        try { draft=open(bot,chat); }catch(ApiException unavailable) {return null;}
        var offer=consumedOffer(bot,chat,draft,message);
        if(offer==null)return refusalPanel();
        var next=back(bot,chat,draft.id(),draft.revision());
        return bindOffer("choose_type".equals(draft.step())?entryBackPanel(next,entryText.get()):audiencePanel(next,"back"),offer);
    }

    private Panel refusalPanel() {
        return new Panel(null,0,AUDIENCE_REFUSAL,
                json.valueToTree(new TelegramTransport.ReplyKeyboard(List.of(List.of("Назначить собрание"),List.of("Меню","Назад"))).markup()));
    }

    private Panel entryBackPanel(Draft draft,String text) {
        var markup=json.valueToTree(new TelegramTransport.ReplyKeyboard(List.of(List.of("Назначить собрание"),List.of("Меню","Назад"))).markup());
        var panel=json.createObjectNode().put("text",text).put("command","back").put("step","choose_type").put("exit",true);
        panel.set("markup",markup);
        if(jdbc.sql("""
                update telegram_meeting_drafts set panel=cast(:panel as jsonb)
                where id=:id and revision=:revision and status='cancelled' and step='choose_type' and expires_at>clock_timestamp()
                """).param("panel",json.writeValueAsString(panel)).param("id",draft.id()).param("revision",draft.revision()).update()!=1)throw stale();
        return new Panel(draft.id(),draft.revision(),text,markup);
    }

    /** Null means unsupported, not a global fallback for arbitrary private text. */
    public Panel consumeTextPanel(String bot,long chat,String text,JsonNode message) {
        if(text==null || text.strip().startsWith("/"))return null;
        Draft draft;
        try { draft=open(bot,chat); }catch(ApiException unavailable) {return null;}
        if(!List.of("pick_competency","confirm_competency","topic","description","date","time").contains(draft.step()))return null;
        var offer=consumedOffer(bot,chat,draft,message);
        if(offer==null)return refusalPanel();
        if("time".equals(draft.step())) {
            try {
                var request=creationRequest(draft,text);
                MeetingRules.normalize(request,clock);
                if("block".equals(request.audienceMode()))meetings.blockAudience(request.competencyId());
            }catch(ApiException invalid) {
                if(invalid.status()!=HttpStatus.BAD_REQUEST)throw invalid;
                return bindOffer(audiencePanel(draft,"meeting_text",text,invalid.getMessage()),offer);
            }
            // A domain race/error must roll back the entire transaction, never commit a redraw after rollback-only.
            var meeting=create(bot,chat,draft.id(),draft.revision(),text);
            return bindOffer(completedPanel(draft,text,meeting),offer);
        }
        Draft next;
        try {
            next=switch(draft.step()) {
                case "pick_competency"->{
                    var stored=json.readTree(jdbc.sql("select panel::text from telegram_meeting_drafts where id=:id").param("id",draft.id()).query(String.class).single());
                    var option=stored.path("options").get(text.strip());
                    if(option==null || !option.isString())throw new ApiException(HttpStatus.BAD_REQUEST,"invalid_meeting_block","Выберите блок кнопкой из показанного списка.");
                    yield selectBlock(bot,chat,draft.id(),draft.revision(),option.asText());
                }
                case "confirm_competency"->{
                    if(!"подтвердить".equals(text.strip().toLowerCase(Locale.ROOT)))throw new ApiException(HttpStatus.BAD_REQUEST,"invalid_meeting_confirmation","Нажмите «Подтвердить» или «Назад».");
                    yield confirmBlock(bot,chat,draft.id(),draft.revision());
                }
                case "topic"->enterTopic(bot,chat,draft.id(),draft.revision(),text);
                case "description"->enterDescription(bot,chat,draft.id(),draft.revision(),text);
                case "date"->enterDate(bot,chat,draft.id(),draft.revision(),text);
                default->throw stale();
            };
        }catch(ApiException invalid) {
            if(invalid.status()!=HttpStatus.BAD_REQUEST)throw invalid;
            return bindOffer(audiencePanel(draft,"meeting_text",text,invalid.getMessage()),offer);
        }
        return bindOffer(audiencePanel(next,"meeting_text",text,null),offer);
    }

    private Draft open(String bot,long chat) {
        var owner=owner(bot,chat);
        var id=jdbc.sql("select id from telegram_meeting_drafts where bot_id=:bot and chat_id=:chat and user_id=:user and status='open'")
                .param("bot",bot).param("chat",chat).param("user",owner.actor().id()).query(String.class).optional().orElseThrow(TelegramMeetingDraftService::stale);
        return load(bot,chat,id,owner);
    }

    private Panel audiencePanel(Draft draft,String command) {
        return audiencePanel(draft,command,null,null);
    }

    private Panel audiencePanel(Draft draft,String command,String input,String error) {
        String text;
        var rows=new ArrayList<List<String>>();var options=json.createObjectNode();
        switch(draft.step()) {
            case "choose_type"->{text="Кого приглашаем?";rows.add(List.of("Собрать всю команду","Выбрать блок"));}
            case "topic"->text="Напиши тему собрания одним сообщением.";
            case "description"->{text="Теперь напиши описание собрания или нажми «Пропустить».";rows.add(List.of("Пропустить"));}
            case "date"->text="Введи дату собрания: например, 14.08.2026, 14.08 или «завтра».";
            case "time"->text="Введи время: например, 18:00, 18.30 или просто 18.";
            case "confirm_competency"->{
                var competency=draft.payload().path("competencyId").asText();
                var name=jdbc.sql("select name from competencies where id=:id").param("id",competency).query(String.class).optional().orElse("Блок недоступен");
                var members=jdbc.sql("""
                        select u.real_name from users u join user_competencies uc on uc.user_id=u.id
                        where uc.competency_id=:id and u.active and u.role in ('admin','organizer') order by u.id limit 9
                        """).param("id",competency).query(String.class).list();
                var preview=new StringBuilder("Выбран блок: ").append(bounded(name,160)).append(".\n\nУчастники:\n");
                if(members.isEmpty())preview.append("В этом блоке нет активных участников. Выбери другой блок через «Назад».");
                else {members.stream().limit(8).forEach(member->preview.append("• ").append(bounded(member,100)).append('\n'));if(members.size()>8)preview.append("И другие участники блока.\n");}
                text=preview.append("\nПроверь выбранный блок.").toString();rows.add(List.of("Подтвердить"));
            }
            case "pick_competency"->{
                var blocks=jdbc.sql("select id,name from competencies where scope='core' and active order by lower(name),id limit 57")
                        .query((r,i)->new String[]{r.getString(1),r.getString(2)}).list();
                // ponytail: existing reply-keyboard ceiling is 8x8; pagination when a catalog exceeds 56 choices.
                text=blocks.isEmpty()?"Пока нет ни одного блока. Админ может добавить блоки в разделе «Команда».":
                        blocks.size()>56?"Слишком много блоков для этой клавиатуры. Назначьте собрание через Mini App или нажмите «Назад».":"Выбери блок.";
                if(blocks.size()<=56)for(int i=0;i<blocks.size();i++) {
                    var name=blocks.get(i)[1];int end=Math.min(110,name.length());
                    if(end>0 && end<name.length() && Character.isHighSurrogate(name.charAt(end-1)))end--;
                    var label=(i+1)+". "+name.substring(0,end)+(end<name.length()?"…":"");options.put(label,blocks.get(i)[0]);
                    if(i%8==0)rows.add(new ArrayList<>());rows.getLast().add(label);
                }
            }
            default->throw stale();
        }
        rows.add(List.of("Меню","Назад"));
        var markup=json.valueToTree(new TelegramTransport.ReplyKeyboard(rows,true).markup());
        if(error!=null && "pick_competency".equals(draft.step())) {
            // A retry must keep the same offered label→ID mapping until explicit navigation.
            var previous=json.readTree(jdbc.sql("select panel::text from telegram_meeting_drafts where id=:id").param("id",draft.id()).query(String.class).single());
            options=(ObjectNode)previous.path("options").deepCopy();markup=previous.path("markup").deepCopy();
        }
        if(error!=null)text=bounded(error,500)+"\n\n"+text;
        var panel=json.createObjectNode().put("text",text).put("command",command).put("step",draft.step());
        if(input!=null)panel.put("input",input);
        if("meeting_audience".equals(command))panel.put("audienceMode",draft.payload().path("audienceMode").asText());
        panel.set("markup",markup);panel.set("options",options);
        if(jdbc.sql("""
                update telegram_meeting_drafts set panel=cast(:panel as jsonb)
                where id=:id and revision=:revision and status='open' and expires_at>clock_timestamp()
                """).param("panel",json.writeValueAsString(panel)).param("id",draft.id()).param("revision",draft.revision()).update()!=1)throw stale();
        return new Panel(draft.id(),draft.revision(),text,markup);
    }

    private static String bounded(String text,int limit) {
        if(text.length()<=limit)return text;
        int end=Character.isHighSurrogate(text.charAt(limit-1))?limit-1:limit;
        return text.substring(0,end)+"…";
    }

    private Panel completedPanel(Draft draft,String input,String meeting) {
        var text="Собрание назначено.\n"+LocalDate.parse(draft.payload().path("date").asText())
                .format(DateTimeFormatter.ofPattern("dd.MM.uuuu"))+", "+TelegramMeetingInput.time(input)+" (МСК).";
        var markup=json.valueToTree(new TelegramTransport.ReplyKeyboard(List.of(List.of("Встречи","Назначить собрание"),List.of("Меню","Назад"))).markup());
        var panel=json.createObjectNode().put("text",text).put("command","meeting_text").put("step","time")
                .put("input",input).put("completedMeetingId",meeting).put("meetingVersion",0);
        panel.set("markup",markup);
        if(jdbc.sql("""
                update telegram_meeting_drafts set panel=cast(:panel as jsonb)
                where id=:id and revision=:revision and status='completed' and meeting_id=:meeting and expires_at>clock_timestamp()
                """).param("panel",json.writeValueAsString(panel)).param("id",draft.id()).param("revision",draft.revision()+1)
                .param("meeting",meeting).update()!=1)throw stale();
        return new Panel(draft.id(),draft.revision()+1,text,markup);
    }

    /** A committed SENT private prompt with a known provider ID, never an unknown/in-flight SEND. */
    public boolean confirmedPanel(String bot,long chat,String id,long revision) {
        try { current(bot,chat,id,revision,null); }
        catch(ApiException unavailable) { return false; }
        return jdbc.sql("""
                select exists(select 1 from notification_deliveries d join outbox_events o on o.id=d.command_reply_outbox_id
                join telegram_inbox i on i.id=o.aggregate_id
                where d.category='telegram_command_reply' and d.status='sent' and d.telegram_message_id>0
                and not d.cancel_requested and not d.disable_notification and d.message_thread_id is null
                and d.operation_id=o.id and d.payload=o.payload and o.status='completed'
                and o.aggregate_type='telegram_inbox' and o.event_type='telegram_command_reply' and i.status='completed'
                and i.bot_id=:bot and i.chat_key=:bot||':chat:'||cast(:chat as text) and d.chat_id=:chat
                and d.recipient_id=d.payload->>'recipientId' and d.payload->>'meetingDraftId'=:draft
                and not jsonb_exists(d.payload,'operation')
                and i.payload->'message'->'chat'->>'type'='private'
                and i.payload->'message'->'chat'->>'id'=cast(:chat as text)
                and i.payload->'message'->'from'->>'id'=cast(:chat as text)
                and i.payload->'message'->'from'->'is_bot'='false'::jsonb
                and i.payload->'message'->>'message_id'=d.payload->>'sourceMessageId'
                and ((d.payload->>'command'='meeting_begin' and lower(regexp_replace(i.payload->'message'->>'text','^\\s+|\\s+$','','g'))='назначить собрание')
                  or d.payload->>'command' in ('meeting_audience','meeting_text')
                  or (d.payload->>'command'='back' and lower(regexp_replace(i.payload->'message'->>'text','^\\s+|\\s+$','','g'))='назад'))
                and not jsonb_exists_any(i.payload->'message',array['sender_chat','forward_origin','via_bot','business_connection_id'])
                and
                """+CURRENT_PANEL_SQL+" and "+AUDIENCE_SOURCE_SQL+" and "+TEXT_SOURCE_SQL+" and "+CONSUMED_OFFER_SQL+")").param("bot",bot).param("chat",chat).param("draft",id).query(Boolean.class).single();
    }

    private String consumedOffer(String bot,long chat,Draft draft,JsonNode message) {
        if(!confirmedPanel(bot,chat,draft.id(),draft.revision()))return null;
        // Reuse both predicates against each candidate; select the explicit referenced offer, never a maximum ID.
        var target=json.createObjectNode().put("botId",bot).put("chatId",chat).put("recipientId",owner(bot,chat).actor().id())
                .put("meetingDraftId",draft.id()).put("meetingRevision",draft.revision()).put("command","meeting_text");
        return jdbc.sql("""
                select q.id from notification_deliveries q join outbox_events qo on qo.id=q.command_reply_outbox_id
                join telegram_inbox qi on qi.id=qo.aggregate_id
                cross join lateral (select cast(:target as jsonb)||jsonb_build_object('meetingOfferId',q.id,
                  'recipientRole',q.payload->'recipientRole','profileVersion',q.payload->'profileVersion') payload) d
                cross join (select jsonb_build_object('message',cast(:message as jsonb)) payload) i
                where q.payload->>'meetingDraftId'=:draft and q.payload->>'meetingRevision'=:revision
                and q.payload->>'text'=(select panel->>'text' from telegram_meeting_drafts where id=:draft)
                and q.payload->'replyMarkup'=(select panel->'markup' from telegram_meeting_drafts where id=:draft)
                and exists(select 1 from telegram_meeting_drafts s join users u on u.id=s.user_id
                  where s.id=:draft and s.profile_version::text=q.payload->>'profileVersion'
                    and s.user_id=q.recipient_id and u.role=q.payload->>'recipientRole')
                and exists(select 1 from (select q.payload payload) d cross join (select qi.payload payload) i where
                """+AUDIENCE_SOURCE_SQL+" and "+TEXT_SOURCE_SQL+" and "+CONSUMED_OFFER_SQL+") and "+CONSUMED_OFFER_SQL+" limit 1")
                .param("target",json.writeValueAsString(target)).param("message",json.writeValueAsString(message))
                .param("draft",draft.id()).param("revision",Long.toString(draft.revision())).query(String.class).optional().orElse(null);
    }

    private Panel bindOffer(Panel panel,String offer) {
        if(jdbc.sql("update telegram_meeting_drafts set panel=jsonb_set(panel,'{offerId}',to_jsonb(cast(:offer as text))) where id=:id and revision=:revision and panel is not null")
                .param("offer",offer).param("id",panel.draftId()).param("revision",panel.revision()).update()!=1)throw stale();
        return new Panel(panel.draftId(),panel.revision(),panel.text(),panel.markup(),offer);
    }

    public Draft load(String bot, long chat, String id) { return load(bot,chat,id,owner(bot,chat)); }

    /** Explicit private navigation abandons only this owner's draft, even after expiry or a role change. */
    public void leaveDialog(String bot,long chat,String userId) {
        if(bot==null || !bot.matches("[1-9][0-9]{0,19}") || chat<=0 || userId==null || userId.isBlank())throw stale();
        if(jdbc.sql("select id from users where id=:user and telegram_id=:chat and active for no key update")
                .param("user",userId).param("chat",chat).query(String.class).optional().isEmpty())return;
        jdbc.sql("update telegram_meeting_drafts set status=case when status='open' then 'cancelled' else status end,panel=null where bot_id=:bot and chat_id=:chat and user_id=:user and status in ('open','completed','cancelled') and (status='open' or panel is not null)")
                .param("bot",bot).param("chat",chat).param("user",userId).update();
    }

    public Draft chooseAudience(String bot, long chat, String id, long revision, String mode) {
        var draft=current(bot,chat,id,revision,"choose_type");
        if(!"all".equals(mode) && !"block".equals(mode)) throw stale();
        return advance(draft,"all".equals(mode)?"topic":"pick_competency",json.createObjectNode().put("audienceMode",mode),"open");
    }

    public Draft selectBlock(String bot, long chat, String id, long revision, String competencyId) {
        var draft=current(bot,chat,id,revision,"pick_competency");
        meetings.blockAudience(competencyId);
        var payload=(ObjectNode)draft.payload().deepCopy();
        payload.put("competencyId",competencyId);
        return advance(draft,"confirm_competency",payload,"open");
    }

    public Draft confirmBlock(String bot, long chat, String id, long revision) {
        var draft=current(bot,chat,id,revision,"confirm_competency");
        meetings.blockAudience(draft.payload().path("competencyId").asText());
        return advance(draft,"topic",draft.payload(),"open");
    }

    public void cancel(String bot, long chat, String id, long revision) {
        var draft=current(bot,chat,id,revision,null);
        advance(draft,draft.step(),draft.payload(),"cancelled");
    }

    public Draft enterTopic(String bot,long chat,String id,long revision,String text) {
        var draft=current(bot,chat,id,revision,"topic");
        var topic=MeetingRules.normalizeOptional(text,500,"Тема");
        if(topic==null)throw new ApiException(HttpStatus.BAD_REQUEST,"invalid_meeting_text","Тема не должна быть пустой.");
        var payload=(ObjectNode)draft.payload().deepCopy(); payload.put("topic",topic);
        return advance(draft,"description",payload,"open");
    }

    public Draft enterDescription(String bot,long chat,String id,long revision,String text) {
        var draft=current(bot,chat,id,revision,"description");
        var description=MeetingRules.normalizeOptional(text!=null && "пропустить".equalsIgnoreCase(text.strip())?null:text,4000,"Описание");
        var payload=(ObjectNode)draft.payload().deepCopy(); payload.put("description",description);
        return advance(draft,"date",payload,"open");
    }

    public Draft enterDate(String bot,long chat,String id,long revision,String text) {
        var draft=current(bot,chat,id,revision,"date");
        var payload=(ObjectNode)draft.payload().deepCopy(); payload.put("date",TelegramMeetingInput.date(text,clock).toString());
        return advance(draft,"time",payload,"open");
    }

    public Draft back(String bot,long chat,String id,long revision) {
        var draft=current(bot,chat,id,revision,null);
        var payload=(ObjectNode)draft.payload().deepCopy();
        var step=switch(draft.step()) {
            case "time"->{payload.remove("date");yield "date";}
            case "date"->{payload.remove("description");yield "description";}
            case "description"->{payload.remove("topic");yield "topic";}
            case "topic"->"block".equals(payload.path("audienceMode").asText())?"confirm_competency":"choose_type";
            case "confirm_competency"->{payload.remove("competencyId");yield "pick_competency";}
            case "pick_competency"->"choose_type";
            case "choose_type"->"choose_type";
            default->throw stale();
        };
        if("choose_type".equals(step))payload=json.createObjectNode();
        return advance(draft,step,payload,"choose_type".equals(draft.step())?"cancelled":"open");
    }

    public String create(String bot,long chat,String id,long revision,String timeText) {
        var owner=owner(bot,chat);
        var draft=checked(load(bot,chat,id,owner),revision,"time");
        var payload=(ObjectNode)draft.payload().deepCopy();
        var request=creationRequest(draft,timeText);
        // Final domain validation rechecks current audience, future Moscow start and all side effects.
        var meeting=meetings.create(request,owner.actor());
        payload.put("time",request.time().toString());
        if(jdbc.sql("""
                update telegram_meeting_drafts set status='completed',meeting_id=:meeting,payload=cast(:payload as jsonb),revision=revision+1,panel=null
                where id=:id and revision=:revision and status='open' and expires_at>clock_timestamp()
                """).param("meeting",meeting.id()).param("payload",json.writeValueAsString(payload)).param("id",id)
                .param("revision",revision).update()!=1)throw stale();
        return meeting.id();
    }

    private MeetingController.MeetingMutation creationRequest(Draft draft,String timeText) {
        var payload=draft.payload();
        var block="block".equals(payload.path("audienceMode").asText());
        var competency=block?payload.path("competencyId").asText():null;
        var title=block?"Собрание блока "+jdbc.sql("select name from competencies where id=:id").param("id",competency)
                .query(String.class).optional().orElseThrow(TelegramMeetingDraftService::stale):"Общее собрание";
        return new MeetingController.MeetingMutation(title,"meeting",null,LocalDate.parse(payload.path("date").asText()),
                TelegramMeetingInput.time(timeText),60,block?"block":"all",competency,List.of(),payload.path("topic").asText(),
                payload.path("description").isNull()?null:payload.path("description").asText(),0);
    }

    private Draft current(String bot,long chat,String id,long revision,String step) {
        return checked(load(bot,chat,id,owner(bot,chat)),revision,step);
    }

    private Draft checked(Draft draft,long revision,String step) {
        if(draft.revision()!=revision || (step!=null && !step.equals(draft.step()))) throw stale();
        return draft;
    }

    private Draft advance(Draft draft,String step,JsonNode payload,String status) {
        if(jdbc.sql("""
                update telegram_meeting_drafts set step=:step,payload=cast(:payload as jsonb),status=:status,revision=revision+1,panel=null
                where id=:id and revision=:revision and status='open' and expires_at>clock_timestamp()
                """).param("step",step).param("payload",json.writeValueAsString(payload)).param("status",status)
                .param("id",draft.id()).param("revision",draft.revision()).update()!=1) throw stale();
        return new Draft(draft.id(),draft.revision()+1,step,payload.deepCopy());
    }

    private Owner owner(String bot,long chat) {
        if(bot==null || !bot.matches("[1-9][0-9]{0,19}") || chat<=0) throw stale();
        return jdbc.sql("""
                select u.id,u.version,u.username,u.real_name,u.role from users u where u.telegram_id=:chat and u.active and u.registered
                and u.role in ('admin','organizer') and exists (
                    select 1 from chat_bindings b where b.bot_id=:bot and b.chat_id=:chat and b.type='private')
                for no key update of u
                """).param("bot",bot).param("chat",chat).query((r,i)->new Owner(new AuthenticatedUser(r.getString("id"),
                        r.getString("username"),r.getString("real_name"),r.getString("role")),r.getLong("version")))
                .optional().orElseThrow(TelegramMeetingDraftService::stale);
    }

    private Draft load(String bot,long chat,String id,Owner owner) {
        var draft=jdbc.sql("""
                select id,revision,step,payload::text from telegram_meeting_drafts
                where id=:id and bot_id=:bot and chat_id=:chat and user_id=:user and profile_version=:profile
                and status='open' and expires_at>clock_timestamp() for update
                """).param("id",id).param("bot",bot).param("chat",chat).param("user",owner.actor().id()).param("profile",owner.version())
                .query((r,i)->new Draft(r.getString("id"),r.getLong("revision"),r.getString("step"),json.readTree(r.getString("payload"))))
                .optional().orElseThrow(TelegramMeetingDraftService::stale);
        if(!jdbc.sql("select expires_at>clock_timestamp() from telegram_meeting_drafts where id=:id")
                .param("id",id).query(Boolean.class).single()) throw stale();
        return draft;
    }

    private static ApiException stale() {
        return new ApiException(HttpStatus.CONFLICT,"meeting_draft_unavailable","Черновик собрания устарел. Начните заново.");
    }
    public record Draft(String id,long revision,String step,JsonNode payload) {}
    public record Panel(String draftId,long revision,String text,JsonNode markup,String offerId) {
        public Panel(String draftId,long revision,String text,JsonNode markup) {this(draftId,revision,text,markup,null);}
    }
    private record Owner(AuthenticatedUser actor,long version) {}
}
