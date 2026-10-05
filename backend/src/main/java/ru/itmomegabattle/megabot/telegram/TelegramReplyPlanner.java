package ru.itmomegabattle.megabot.telegram;

import java.time.Instant;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;
import ru.itmomegabattle.megabot.notifications.TelegramTransport;
import tools.jackson.databind.ObjectMapper;

/** No new worker: command replies enter the existing sender atomically with outbox completion. */
@Service
public class TelegramReplyPlanner {
	private final JdbcClient jdbc;private final DeliveryQueue queue;private final ObjectMapper json;
	public TelegramReplyPlanner(JdbcClient jdbc,DeliveryQueue queue,ObjectMapper json) { this.jdbc=jdbc;this.queue=queue;this.json=json; }
	@Transactional
	public int materialize(int limit,String bot) {
		if(limit<1 || limit>100 || bot==null || !bot.matches("[0-9]{1,20}"))throw new IllegalArgumentException("invalid_reply_batch");
		var events=jdbc.sql("""
				select o.id,o.payload::text,o.available_at,i.payload->'message'->>'text' from outbox_events o join telegram_inbox i on i.id=o.aggregate_id
				where o.aggregate_type='telegram_inbox' and o.event_type='telegram_command_reply'
				and o.status in ('pending','retry') and o.available_at<=clock_timestamp() and i.status='completed' and i.bot_id=:bot
				order by o.available_at,o.id for update of o skip locked limit :limit
				""").param("bot",bot).param("limit",limit).query((r,i)->new Event(r.getString(1),r.getString(2),r.getTimestamp(3).toInstant(),r.getString(4))).list();
		for(var event:events) {
			long chat;String recipient;String role;
			try {
				var root=json.readTree(event.payload());var target=root.path("chatId");var text=root.path("text");
				if(!root.path("botId").isString() || !bot.equals(root.path("botId").asText()) || !root.path("command").isString()
						|| !root.path("command").asText().equals(TelegramPrivateCommandHandler.command(event.input()))
						|| !target.isIntegralNumber() || !target.canConvertToLong() || target.longValue()<1 || !text.isString())throw new IllegalArgumentException();
				chat=target.longValue();recipient=root.has("recipientId")?root.path("recipientId").asText():null;
				role=root.path("recipientRole").asText();
				if(recipient!=null && (!root.path("recipientId").isString() || recipient.isBlank() || !root.path("recipientRole").isString()))throw new IllegalArgumentException();
				new TelegramTransport.Message(chat,null,text.asText(),false,TelegramTransport.ReplyKeyboard.parse(root.path("replyMarkup")));
			}catch(RuntimeException invalid) { complete(event.id(),"failed","invalid_command_reply");continue; }
			var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
			if(!event.due().plusSeconds(900).isAfter(now)) { complete(event.id(),"cancelled","command_reply_expired");continue; }
			if(recipient!=null && jdbc.sql("""
					select count(*) from users u where u.id=:id and u.active and u.registered and u.telegram_id=:chat and u.role=:role
					and exists(select 1 from chat_bindings b where b.bot_id=:bot and b.chat_id=:chat and b.type='private')
					""").param("id",recipient).param("chat",chat).param("role",role).param("bot",bot).query(Long.class).single()==0) {
				complete(event.id(),"cancelled","stale_command_reply");continue;
			}
			// FK/unique/category constraints fence source ownership; both writes roll back on any DB failure.
			queue.enqueue(new DeliveryQueue.NewDelivery(event.id(),"command-reply:"+event.id(),"telegram_command_reply",recipient,chat,null,
					event.payload(),false,event.due(),event.due(),event.due().plusSeconds(900)));
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
