package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.SqlTime;
import tools.jackson.databind.ObjectMapper;

/** One immutable author notice per expired revision, through the existing delivery queue. */
@Service
public class BroadcastExpiryPlanner {
	private final JdbcClient jdbc; private final DeliveryQueue queue; private final ObjectMapper json;
	public BroadcastExpiryPlanner(JdbcClient jdbc,DeliveryQueue queue,ObjectMapper json) {
		this.jdbc=jdbc;this.queue=queue;this.json=json;
	}
	@Transactional
	public int materialize(int limit) {
		if(limit<1 || limit>100)throw new IllegalArgumentException("invalid_expiry_notice_batch");
		var sources=jdbc.sql("""
				select b.id,b.content_revision,b.author_id,b.title,b.expires_at,u.telegram_id,
				u.active and u.registered and u.role in ('admin','organizer') as author_available
				from broadcasts b join users u on u.id=b.author_id
				where b.status in ('scheduled','sending','expired','completed') and b.expires_at<=clock_timestamp()
				and not exists(select 1 from broadcast_expiry_notices n where n.broadcast_id=b.id and n.revision=b.content_revision)
				and exists(select 1 from broadcast_targets t join notification_deliveries d on d.broadcast_target_id=t.id
				 where t.broadcast_id=b.id and t.revision=b.content_revision and d.status='expired'
				 and not exists(select 1 from notification_deliveries child where child.retry_of=d.id))
				and not exists(select 1 from broadcast_targets t join notification_deliveries d on d.broadcast_target_id=t.id
				 where t.broadcast_id=b.id and t.revision=b.content_revision and d.status in ('planned','retry','claimed','sending'))
				order by b.expires_at,b.id for update of b skip locked limit :limit
				""").param("limit",limit).query((r,i)->new Source(r.getString("id"),r.getLong("content_revision"),r.getString("author_id"),r.getString("title"),r.getTimestamp("expires_at").toInstant(),(Long)r.getObject("telegram_id"),r.getBoolean("author_available"))).list();
		int created=0;
		for(var b:sources) {
			var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
			var expiry=b.due().plusSeconds(86400);var chat=b.chat()!=null && b.chat()>0 && b.available()?b.chat():null;
			var state=!expiry.isAfter(now)?"expired":chat==null?"unavailable":"queued";
			var notice="expiry_"+UUID.randomUUID();
			if(jdbc.sql("""
					insert into broadcast_expiry_notices(id,broadcast_id,revision,author_id,chat_id,state,intended_at,expires_at)
					values (:id,:broadcast,:revision,:author,:chat,:state,:due,:expiry) on conflict (broadcast_id,revision) do nothing
					""").param("id",notice).param("broadcast",b.id()).param("revision",b.revision()).param("author",b.author()).param("chat",chat).param("state",state).param("due",SqlTime.of(b.due())).param("expiry",SqlTime.of(expiry)).update()==0)continue;
			created++;
			if(!"queued".equals(state))continue;
			var counts=jdbc.sql("""
					select status,count(*) as amount from broadcast_target_delivery_summary
					where broadcast_id=:id and revision=:revision group by status
					""").param("id",b.id()).param("revision",b.revision()).query((r,i)->Map.entry(r.getString("status"),r.getLong("amount"))).list();
			var text=new StringBuilder("Срок отправки рассылки истёк.");
			// Title is bounded here too: imported legacy rows need not satisfy the current HTTP limit.
			if(!b.title().isBlank())text.append("\nРассылка: ").append(b.title().codePoints().limit(120).collect(StringBuilder::new,StringBuilder::appendCodePoint,StringBuilder::append));
			text.append("\nИтог по адресатам на момент уведомления:");
			for(var count:counts)text.append("\n").append(switch(count.getKey()) {
				case "sent"->"Подтверждено Telegram";case "expired"->"Срок истёк для оставшихся отправок";
				case "unknown"->"Результат неизвестен (сообщение могло прийти)";
				case "partial"->"Подтверждена только часть текста";
				case "failed"->"Ошибка отправки";case "cancelled"->"Отменено";default->"Telegram недоступен";
			}).append(": ").append(count.getValue());
			text.append("\nПросроченные попытки автоматически не отправляются. Если в журнале есть неизвестный результат, сообщение могло прийти ранее: expiry новой попытки не доказывает недоставку предыдущей. Для актуального текста создайте новую рассылку, учитывая возможные дубли.");
			var payload=json.writeValueAsString(Map.of("text",text.toString(),"broadcastId",b.id(),"contentRevision",b.revision()));
			var delivery=queue.enqueue(new DeliveryQueue.NewDelivery(b.id(),"broadcast-expiry:"+b.id()+":"+b.revision(),"broadcast_expired",b.author(),chat,null,payload,false,b.due(),now,expiry));
			jdbc.sql("update notification_deliveries set broadcast_expiry_notice_id=:notice where id=:id").param("notice",notice).param("id",delivery).update();
		}
		return created;
	}
	private record Source(String id,long revision,String author,String title,Instant due,Long chat,boolean available) {}
}
