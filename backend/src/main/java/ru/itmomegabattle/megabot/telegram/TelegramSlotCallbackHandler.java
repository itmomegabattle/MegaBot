package ru.itmomegabattle.megabot.telegram;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.availability.TelegramSlotDraftService;
import ru.itmomegabattle.megabot.notifications.OutboxWriter;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Local inbox transaction only: edit and ack are durable intents, never provider calls. */
@Service
public class TelegramSlotCallbackHandler {
    public static final String SOURCE_SQL="""
            (i.chat_key=i.bot_id||':chat:'||d.chat_id::text
             and jsonb_typeof(i.payload->'callback_query'->'message'->'chat'->'id')='number'
             and jsonb_typeof(i.payload->'callback_query'->'from'->'id')='number'
             and jsonb_typeof(i.payload->'callback_query'->'message'->'from'->'id')='number'
             and jsonb_typeof(i.payload->'callback_query'->'message'->'message_id')='number'
             and jsonb_typeof(i.payload->'callback_query'->'message'->'date')='number'
             and i.payload->'callback_query'->'message'->>'date' ~ '^[1-9][0-9]{0,18}$'
             and jsonb_typeof(i.payload->'callback_query'->'chat_instance')='string'
             and length(i.payload->'callback_query'->>'chat_instance') between 1 and 256
             and jsonb_typeof(i.payload->'callback_query'->'id')='string' and jsonb_typeof(i.payload->'callback_query'->'data')='string'
             and i.payload->'callback_query'->'message'->'chat'->>'type'='private'
             and i.payload->'callback_query'->'message'->'chat'->>'id'=d.chat_id::text
             and i.payload->'callback_query'->'from'->>'id'=d.chat_id::text
             and i.payload->'callback_query'->'from'->'is_bot'='false'::jsonb
             and i.payload->'callback_query'->'message'->'from'->>'id'=i.bot_id
             and i.payload->'callback_query'->'message'->'from'->'is_bot'='true'::jsonb
             and i.payload->'callback_query'->'message'->>'message_id'=d.payload->>'sourceMessageId'
             and i.payload->'callback_query'->>'id'=d.payload->>'sourceCallbackId'
             and i.payload->'callback_query'->>'data'=d.payload->>'sourceCallbackData'
             and not jsonb_exists_any(i.payload->'callback_query',array['inline_message_id','game_short_name'])
             and not jsonb_exists_any(i.payload->'callback_query'->'message',array['sender_chat','forward_origin','via_bot','business_connection_id','message_thread_id','is_ephemeral','receiver_user','ephemeral_message_id','guest_bot_caller_user','guest_bot_caller_chat'])
			 and (d.payload->>'command'='callback_ack' or (d.payload->>'command'='meeting_callback' and d.payload->>'targetMessageId'=d.payload->>'sourceMessageId') or (d.payload->>'targetMessageId'=d.payload->>'sourceMessageId'
                and exists(select 1 from notification_deliveries parent join outbox_events po on po.id=parent.command_reply_outbox_id
                  where parent.status='sent' and parent.category='telegram_command_reply' and parent.message_thread_id is null
                  and parent.telegram_message_id::text=d.payload->>'targetMessageId' and parent.chat_id=d.chat_id
                  and parent.payload=po.payload and po.status='completed'
                  and parent.payload->>'botId'=i.bot_id and parent.recipient_id=d.recipient_id
                  and parent.payload->>'slotDraftId'=d.payload->>'slotDraftId'
                  and exists(select 1 from jsonb_array_elements(parent.payload->'replyMarkup'->'inline_keyboard') keyboard_row(value),
                      lateral jsonb_array_elements(keyboard_row.value) button(value) where button.value->>'callback_data'=d.payload->>'sourceCallbackData')))))
            """;
    private final JdbcClient jdbc;private final ObjectMapper json;private final OutboxWriter outbox;private final TelegramSlotDraftService slots;
    TelegramSlotCallbackHandler(JdbcClient jdbc,ObjectMapper json,OutboxWriter outbox,TelegramSlotDraftService slots) {
        this.jdbc=jdbc;this.json=json;this.outbox=outbox;this.slots=slots;
    }
    @Transactional(propagation=Propagation.MANDATORY)
    public void handle(TelegramInboxQueue.Lease lease) {
        var callback=json.readTree(lease.payload()).path("callback_query");var data=callback.path("data");
        if(!data.isString() || !data.asText().startsWith("sl:"))throw new TelegramPrivateCommandHandler.UnsupportedCommand();
        if(data.asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>64)throw new InvalidCallback();
        var token=token(data.asText());if(token==null)throw new InvalidCallback();
        if(!supportedAction(token.action()))throw new TelegramPrivateCommandHandler.UnsupportedCommand();
        requirePrivateSource(lease,callback);
        var message=callback.path("message");var chat=message.path("chat");
        var chatId=chat.path("id").longValue();var messageId=message.path("message_id").longValue();
        var panel=slots.beginEditing(lease.botId(),chatId,messageId,token.id(),token.revision(),data.asText());
        var ack=source(lease,callback,chatId,messageId).put("command","callback_ack").put("operation","ack")
                .put("text",panel==null?"Редактор слотов устарел. Откройте слоты заново.":"");
        write(lease,ack,"ack");
        if(panel==null)return;
        var user=jdbc.sql("select id,role,version from users where telegram_id=:chat").param("chat",chatId)
                .query((r,i)->new Owner(r.getString(1),r.getString(2),r.getLong(3))).single();
        var edit=source(lease,callback,chatId,messageId).put("command","slot_callback").put("operation","edit")
                .put("targetMessageId",messageId).put("text",panel.text()).put("recipientId",user.id()).put("recipientRole",user.role())
                .put("profileVersion",user.version()).put("slotDraftId",panel.draftId()).put("slotRevision",panel.revision()).put("slotSettingsVersion",panel.settingsVersion());
        edit.set("replyMarkup",json.valueToTree(panel.markup()));write(lease,edit,"edit");
    }
    static void requirePrivateSource(TelegramInboxQueue.Lease lease,JsonNode callback) {
        var message=callback.path("message");var from=callback.path("from");var chat=message.path("chat");var bot=message.path("from");
        if(!positive(from.path("id")) || !positive(chat.path("id")) || from.path("id").longValue()!=chat.path("id").longValue()
                || !chat.path("type").asText().equals("private") || !positive(message.path("message_id")) || !positive(message.path("date"))
                || !from.path("is_bot").isBoolean() || from.path("is_bot").booleanValue()
                || !positive(bot.path("id")) || !bot.path("id").asText().equals(lease.botId()) || !bot.path("is_bot").isBoolean() || !bot.path("is_bot").booleanValue()
                || !callback.path("chat_instance").isString() || callback.path("chat_instance").asText().isBlank() || callback.path("chat_instance").asText().length()>256
                || callback.has("inline_message_id") || callback.has("game_short_name")
                || !lease.chatKey().equals(lease.botId()+":chat:"+chat.path("id").longValue()))throw new InvalidCallback();
        for(var field:java.util.List.of("sender_chat","forward_origin","via_bot","business_connection_id","message_thread_id","is_ephemeral","receiver_user","ephemeral_message_id","guest_bot_caller_user","guest_bot_caller_chat"))
            if(message.has(field))throw new InvalidCallback();
    }
    private tools.jackson.databind.node.ObjectNode source(TelegramInboxQueue.Lease lease,JsonNode callback,long chat,long message) {
        return json.createObjectNode().put("botId",lease.botId()).put("chatId",chat).put("sourceMessageId",message)
                .put("sourceCallbackId",callback.path("id").asText()).put("sourceCallbackData",callback.path("data").asText());
    }
    private void write(TelegramInboxQueue.Lease lease,JsonNode payload,String operation) {
        var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
        outbox.write("telegram_inbox",lease.id(),"telegram_command_reply","telegram:callback:"+operation+":"+lease.botId()+":"+lease.updateId(),json.writeValueAsString(payload),now);
    }
    static boolean supported(JsonNode update) {var data=update.path("callback_query").path("data");var t=data.isString()?token(data.asText()):null;return t!=null && supportedAction(t.action());}
    private static boolean supportedAction(String action) {return action.matches("e|b|c|a|u|o|s|v|h([0-9]|1[0-9]|2[0-3])|[wd][0-9]{8}");}
    private static Token token(String data) {
        if(data==null || !data.matches("sl:sd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]{0,18}):[a-z][a-z0-9]*"))return null;
        var parts=data.split(":");try {return new Token(parts[1],Long.parseLong(parts[2]),parts[3]);}catch(NumberFormatException invalid){return null;}
    }
    private static boolean positive(JsonNode n) {return n.isIntegralNumber() && n.canConvertToLong() && n.longValue()>0;}
    private record Token(String id,long revision,String action) {}
    private record Owner(String id,String role,long version) {}
    static class InvalidCallback extends RuntimeException {}
}
