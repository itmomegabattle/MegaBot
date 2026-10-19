package ru.itmomegabattle.megabot.telegram;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.meetings.TelegramMeetingRsvp;
import ru.itmomegabattle.megabot.notifications.OutboxWriter;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
class TelegramMeetingCallbackHandler {
	private final TelegramMeetingRsvp meetings;
	private final JdbcClient jdbc;
	private final ObjectMapper json;
	private final OutboxWriter outbox;

	TelegramMeetingCallbackHandler(TelegramMeetingRsvp meetings,JdbcClient jdbc,ObjectMapper json,OutboxWriter outbox) {
		this.meetings=meetings;this.jdbc=jdbc;this.json=json;this.outbox=outbox;
	}

	static boolean supported(JsonNode update) {
		var data=update.path("callback_query").path("data");
		return data.isString() && (TelegramMeetingRsvp.target(data.asText())!=null || legacy(update));
	}

	/** Only emitted Node slot/RSVP grammars; classification grants no domain authority. */
	static boolean legacy(JsonNode update) {
		var data=update.path("callback_query").path("data");if(!data.isString())return false;
		var action=data.asText();if(action.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>64
				|| !java.nio.charset.StandardCharsets.UTF_8.newEncoder().canEncode(action))return false;
		var day="([0-9]|[12][0-9]|3[0-4])";
		return action.equals("slot_edit") || action.matches("(slot_week|slot_out_week|slot_save_week):[0-4]")
				|| action.matches("(slots_day|slot_toggle_day|slot_unavailable|slot_cancel_day|slot_save_day):"+day)
				|| action.matches("slot_toggle:"+day+":([0-9]|1[0-9]|2[0-3])")
				|| action.matches("meeting_rsvp:[^:\\s\\p{Cntrl}]+:(yes|no|unanswered)");
	}

	@Transactional(propagation=Propagation.MANDATORY)
	void handle(TelegramInboxQueue.Lease lease) {
		var update=json.readTree(lease.payload());var callback=update.path("callback_query");
		if(!supported(update))throw new TelegramSlotCallbackHandler.InvalidCallback();
		TelegramSlotCallbackHandler.requirePrivateSource(lease,callback);
		long chat=callback.path("message").path("chat").path("id").longValue();
		long message=callback.path("message").path("message_id").longValue();
		boolean legacy=legacy(update);
		var reply=legacy?null:meetings.respond(lease.botId(),chat,message,callback.path("data").asText());
		var payload=json.createObjectNode().put("botId",lease.botId()).put("chatId",chat).put("sourceMessageId",message)
				.put("sourceCallbackId",callback.path("id").asText()).put("sourceCallbackData",callback.path("data").asText())
				.put("command","callback_ack").put("operation","ack").put("text",legacy?"Кнопка устарела. Откройте раздел заново через меню.":reply==null?"Приглашение устарело или недоступно.":reply.answer());
		var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
		outbox.write("telegram_inbox",lease.id(),"telegram_command_reply","telegram:callback:ack:"+lease.botId()+":"+lease.updateId(),json.writeValueAsString(payload),now);
		if(reply==null)return;
		var edit=payload.deepCopy().put("command","meeting_callback").put("operation","edit").put("targetMessageId",message)
				.put("text",reply.text()).put("recipientId",reply.actor().id()).put("recipientRole",reply.actor().role())
				.put("profileVersion",reply.profileVersion()).put("meetingTargetId",reply.target()).put("meetingResponse",reply.response());
		edit.set("replyMarkup",json.valueToTree(TelegramMeetingRsvp.keyboard(reply.target(),reply.response()).markup()));
		outbox.write("telegram_inbox",lease.id(),"telegram_command_reply","telegram:callback:edit:"+lease.botId()+":"+lease.updateId(),json.writeValueAsString(edit),now);
	}
}
