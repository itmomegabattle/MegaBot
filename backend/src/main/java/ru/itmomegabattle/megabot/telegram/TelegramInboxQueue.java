package ru.itmomegabattle.megabot.telegram;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

/** Internal lifecycle only. No scheduler: command handlers must exist before consumption is enabled. */
@Service
public class TelegramInboxQueue {
	private final JdbcClient jdbc;
	private final ObjectMapper json;
	TelegramInboxQueue(JdbcClient jdbc,ObjectMapper json) { this.jdbc=jdbc;this.json=json; }

	/** One durable head per chat; a delayed retry or locked head blocks its followers. */
	@Transactional(propagation=Propagation.REQUIRES_NEW,isolation=Isolation.READ_COMMITTED,timeout=5)
	public List<Lease> claim(String botId,int limit,Duration duration) {
		if(botId==null || !botId.matches("[1-9][0-9]{0,19}") || limit<1 || limit>100)
			throw new IllegalArgumentException("Invalid inbox claim");
		var seconds=seconds(duration,300);
		// ponytail: serialize short claims per bot, not processing; per-chat locks if measured throughput needs it.
		// Fresh statement snapshot after this lock also covers late commits with earlier received_at.
		jdbc.sql("select pg_advisory_xact_lock(hashtextextended('telegram_inbox_claim:'||:bot,0))")
				.param("bot",botId).query((row,index)->true).single();
		return jdbc.sql("""
				with picked as (
				 select i.id from telegram_inbox i
				 where i.bot_id=:bot and ((i.status in ('received','retry') and i.available_at<=clock_timestamp()
				 and not exists(select 1 from telegram_inbox busy where busy.bot_id=i.bot_id
				 and busy.chat_key=i.chat_key and busy.status='processing'))
				 or (i.status='processing' and i.leased_until<=clock_timestamp()))
				 and not exists (
				  select 1 from telegram_inbox head where head.chat_key=i.chat_key and head.bot_id=i.bot_id
				  and head.status in ('received','retry','processing')
				  and (i.status<>'processing' or head.status='processing')
				  and (head.received_at,head.update_id,head.id)<(i.received_at,i.update_id,i.id)
				 )
				 order by i.received_at,i.update_id,i.id for update of i skip locked limit :limit
				)
				update telegram_inbox i set status='processing',attempts=attempts+1,
				lease_token=:token||i.id,leased_until=clock_timestamp()+make_interval(secs=>:seconds),
				updated_at=clock_timestamp() from picked where i.id=picked.id
				returning i.id,i.lease_token,i.bot_id,i.update_id,i.chat_key,i.payload::text,i.attempts
				""").param("bot",botId).param("limit",limit).param("seconds",seconds)
				.param("token",UUID.randomUUID()+":").query((row,index)->new Lease(row.getString("id"),
					row.getString("lease_token"),row.getString("bot_id"),row.getLong("update_id"),
					row.getString("chat_key"),row.getString("payload"),row.getInt("attempts"))).list();
	}

	/** DB effects must join this transaction (no REQUIRES_NEW/async); enqueue replies, never call providers. */
	@Transactional(propagation=Propagation.REQUIRES_NEW,timeout=5)
	public boolean apply(String id,String token,Consumer<Lease> action) {
		if(action==null) throw new IllegalArgumentException("Missing inbox action");
		var current=jdbc.sql("""
				select id,lease_token,bot_id,update_id,chat_key,payload::text,attempts from telegram_inbox
				where id=:id and lease_token=:token and status='processing' and leased_until>clock_timestamp()
				for update
				""").param("id",id).param("token",token).query((row,index)->new Lease(row.getString("id"),
					row.getString("lease_token"),row.getString("bot_id"),row.getLong("update_id"),
					row.getString("chat_key"),row.getString("payload"),row.getInt("attempts"))).optional();
		// Recheck after the lock wait: an unchanged row can retain a pre-wait predicate evaluation.
		if(current.isEmpty() || !ownsLease(id,token)) return false;
		boolean duplicate=false;
		var callback=json.readTree(current.get().payload()).get("callback_query");
		if(callback!=null) {
			var callbackId=callback.path("id");
			if(!callbackId.isString() || callbackId.asText().isBlank()
					|| callbackId.asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>256
					|| !java.nio.charset.StandardCharsets.UTF_8.newEncoder().canEncode(callbackId.asText()))throw new InvalidCallbackId();
			// PostgreSQL arbitrates competing copies, including copies delivered to different chat keys.
			duplicate=jdbc.sql("""
					insert into telegram_callback_effects(bot_id,callback_id,first_inbox_id)
					values (:bot,:callback,:inbox) on conflict(bot_id,callback_id) do nothing
					""").param("bot",current.get().botId()).param("callback",callbackId.asText()).param("inbox",id).update()==0;
			// An insert can wait for another transaction longer than this owner's remaining lease.
			if(!ownsLease(id,token))throw new IllegalStateException("Inbox lease expired during processing");
		}
		if(!duplicate)action.accept(current.get());
		if(jdbc.sql("""
				update telegram_inbox set status='completed',processed_at=clock_timestamp(),updated_at=clock_timestamp(),
				lease_token=null,leased_until=null,last_error=:code where id=:id and lease_token=:token
				and status='processing' and leased_until>clock_timestamp()
				""").param("id",id).param("token",token).param("code",duplicate?"duplicate_callback":null).update()!=1)
			throw new IllegalStateException("Inbox lease expired during processing");
		return true;
	}

	/** Safe codes only, never exception messages/payload. Null delay explicitly marks a permanent failure. */
	@Transactional(propagation=Propagation.REQUIRES_NEW,timeout=5)
	public boolean reject(String id,String token,String code,Duration retryDelay) {
		if(code==null || !code.matches("[a-z0-9_]{1,64}")) throw new IllegalArgumentException("Invalid inbox error code");
		var delay=retryDelay==null?0:seconds(retryDelay,86400);
		if(jdbc.sql("select id from telegram_inbox where id=:id and lease_token=:token and status='processing' for update")
				.param("id",id).param("token",token).query(String.class).optional().isEmpty()) return false;
		return jdbc.sql("""
				update telegram_inbox set status=:status,last_error=:code,lease_token=null,leased_until=null,
				available_at=clock_timestamp()+make_interval(secs=>:seconds),updated_at=clock_timestamp()
				where id=:id and lease_token=:token and status='processing' and leased_until>clock_timestamp()
				""").param("id",id).param("token",token).param("status",retryDelay==null?"failed":"retry")
				.param("code",code).param("seconds",delay).update()==1;
	}
	private boolean ownsLease(String id,String token) {
		return jdbc.sql("select exists(select 1 from telegram_inbox where id=:id and lease_token=:token and status='processing' and leased_until>clock_timestamp())")
				.param("id",id).param("token",token).query(Boolean.class).single();
	}
	private static long seconds(Duration duration,long max) {
		if(duration==null || duration.isZero() || duration.isNegative() || duration.compareTo(Duration.ofSeconds(max))>0)
			throw new IllegalArgumentException("Invalid inbox duration");
		return duration.toSeconds()+(duration.getNano()>0?1:0);
	}
	public record Lease(String id,String token,String botId,long updateId,String chatKey,String payload,int attempts) {}
	static class InvalidCallbackId extends RuntimeException {}
}
