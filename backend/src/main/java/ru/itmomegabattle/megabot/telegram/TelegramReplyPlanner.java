package ru.itmomegabattle.megabot.telegram;

import java.time.Instant;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;
import ru.itmomegabattle.megabot.notifications.TelegramTransport;
import ru.itmomegabattle.megabot.availability.TelegramSlotDraftService;
import tools.jackson.databind.ObjectMapper;

/** No new worker: command replies enter the existing sender atomically with outbox completion. */
@Service
public class TelegramReplyPlanner {
	private final JdbcClient jdbc;private final DeliveryQueue queue;private final ObjectMapper json;
	private final ru.itmomegabattle.megabot.meetings.TelegramMeetingRsvp meetings;
	public TelegramReplyPlanner(JdbcClient jdbc,DeliveryQueue queue,ObjectMapper json,ru.itmomegabattle.megabot.meetings.TelegramMeetingRsvp meetings) { this.jdbc=jdbc;this.queue=queue;this.json=json;this.meetings=meetings; }
	@Transactional
	public int materialize(int limit,String bot) {
		if(limit<1 || limit>100 || bot==null || !bot.matches("[0-9]{1,20}"))throw new IllegalArgumentException("invalid_reply_batch");
		var events=jdbc.sql("""
				select o.id,o.payload::text,o.available_at,i.payload::text from outbox_events o join telegram_inbox i on i.id=o.aggregate_id
				where o.aggregate_type='telegram_inbox' and o.event_type='telegram_command_reply'
				and o.status in ('pending','retry') and o.available_at<=clock_timestamp() and i.status='completed' and i.bot_id=:bot
				order by o.available_at,o.id for update of o skip locked limit :limit
				""").param("bot",bot).param("limit",limit).query((r,i)->new Event(r.getString(1),r.getString(2),r.getTimestamp(3).toInstant(),r.getString(4))).list();
		for(var event:events) {
			long chat;String recipient;String role;String operation;long ttl;
			try {
				var root=json.readTree(event.payload());var target=root.path("chatId");var text=root.path("text");
				operation=TelegramTransport.operation(root);var input=json.readTree(event.input());
				boolean callback=!operation.equals("send");
				if(!root.path("botId").isString() || !bot.equals(root.path("botId").asText()) || !root.path("command").isString()
						|| (callback?!(TelegramSlotCallbackHandler.supported(input) || TelegramMeetingCallbackHandler.supported(input)):!TelegramPrivateCommandHandler.replyMatchesInput(root,input))
						|| !target.isIntegralNumber() || !target.canConvertToLong() || target.longValue()<1 || !text.isString())throw new IllegalArgumentException();
				chat=target.longValue();recipient=root.has("recipientId")?root.path("recipientId").asText():null;
				if("meeting_audience".equals(root.path("command").asText()) && !root.path("meetingAudience").asText().equals(
						ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.audienceMode(input.path("message").path("text").asText())))throw new IllegalArgumentException();
				role=root.path("recipientRole").asText();
				if(recipient!=null && (!root.path("recipientId").isString() || recipient.isBlank() || !root.path("recipientRole").isString()))throw new IllegalArgumentException();
				if(operation.equals("ack"))TelegramTransport.ackFrom(chat,root);
				else if(operation.equals("edit"))TelegramTransport.editFrom(chat,root);
				else {if(!root.has("replyMarkup"))throw new IllegalArgumentException();TelegramTransport.Message.withMarkup(chat,null,text.asText(),false,root.path("replyMarkup"));}
				if(callback && !jdbc.sql("select exists(select 1 from outbox_events o join telegram_inbox i on i.id=o.aggregate_id cross join (select cast(:payload as jsonb) payload,cast(:chat as bigint) chat_id,cast(:recipient as text) recipient_id) d where o.id=:id and "+TelegramSlotCallbackHandler.SOURCE_SQL+")")
						.param("payload",event.payload()).param("chat",chat).param("recipient",recipient).param("id",event.id()).query(Boolean.class).single())throw new IllegalArgumentException();
				ttl=operation.equals("ack")?30:900;
			}catch(RuntimeException invalid) { complete(event.id(),"failed","invalid_command_reply");continue; }
            if(!jdbc.sql("select coalesce("+ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.CONSUMED_OFFER_SQL+",false) from (select cast(:payload as jsonb) payload) d cross join (select cast(:input as jsonb) payload) i")
                    .param("payload",event.payload()).param("input",event.input()).query(Boolean.class).single()) {
                complete(event.id(),"cancelled","stale_meeting_offer");continue;
            }
            if(!jdbc.sql("select coalesce("+ru.itmomegabattle.megabot.tasks.TelegramTaskText.CURRENT_VIEW_SQL+" and "+ru.itmomegabattle.megabot.tasks.TelegramTaskText.SOURCE_SQL+",false) from (select cast(:payload as jsonb) payload) d cross join (select cast(:input as jsonb) payload) i")
                    .param("input",event.input()).param("payload",event.payload()).query(Boolean.class).single()) {
                complete(event.id(),"cancelled","stale_task_view");continue;
            }
			if(!meetings.editAllowed(event.payload())) {complete(event.id(),"cancelled","stale_meeting_panel");continue;}
			if(!jdbc.sql("select coalesce("+ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService.CURRENT_PANEL_SQL+",false) from (select cast(:payload as jsonb) payload) d")
					.param("payload",event.payload()).query(Boolean.class).single()) {
				complete(event.id(),"cancelled","stale_meeting_draft");continue;
			}
			if(!jdbc.sql("select coalesce("+TelegramSlotDraftService.CURRENT_PANEL_SQL+",false) from (select cast(:payload as jsonb) payload) d")
					.param("payload",event.payload()).query(Boolean.class).single()) {
				complete(event.id(),"cancelled","stale_slot_panel");continue;
			}
			var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
			if(!event.due().plusSeconds(ttl).isAfter(now)) { complete(event.id(),"cancelled","command_reply_expired");continue; }
			if(recipient!=null && jdbc.sql("""
					select count(*) from users u where u.id=:id and u.active and u.registered and u.telegram_id=:chat and u.role=:role
					and exists(select 1 from chat_bindings b where b.bot_id=:bot and b.chat_id=:chat and b.type='private')
					""").param("id",recipient).param("chat",chat).param("role",role).param("bot",bot).query(Long.class).single()==0) {
				complete(event.id(),"cancelled","stale_command_reply");continue;
			}
			// FK/unique/category constraints fence source ownership; both writes roll back on any DB failure.
			queue.enqueue(new DeliveryQueue.NewDelivery(event.id(),"command-reply:"+event.id(),"telegram_command_reply",recipient,chat,null,
					event.payload(),false,event.due(),event.due(),event.due().plusSeconds(ttl)));
			complete(event.id(),"completed",null);
		}
		return events.size();
	}
	private void complete(String id,String status,String code) {
		jdbc.sql("update outbox_events set status=:status,last_error_code=:code,attempts=attempts+1,lease_token=null,leased_until=null,updated_at=clock_timestamp() where id=:id")
				.param("id",id).param("status",status).param("code",code).update();
	}
	private record Event(String id,String payload,Instant due,String input) {}
}
