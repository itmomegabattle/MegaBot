package ru.itmomegabattle.megabot.notifications;

import java.time.Duration;
import java.time.Instant;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.SqlTime;

/** Shared conservative leaky bucket, keyed by bot identity (never token) and chat, not topic. */
@Service
public class DeliveryQuota {
	private final JdbcClient jdbc;
	public DeliveryQuota(JdbcClient jdbc) { this.jdbc=jdbc; }
	@Transactional
	public Decision reserve(String bot,long chatId,Limits limits) {
		validate(bot,chatId);var global=bot+":global";var chat=bot+":chat:"+chatId;
		var g=lock(global);var c=lock(chat);
		var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
		var due=max(max(g.next(),g.blocked()),max(c.next(),c.blocked()));
		if(due.isAfter(now))return new Decision(false,due);
		advance(global,now.plusMillis(interval(1000,limits.botPerSecond())));
		advance(chat,now.plusMillis(chatId>0?interval(1000,limits.privatePerSecond()):interval(60000,limits.groupPerMinute())));
		return new Decision(true,now);
	}
	@Transactional
	public void block(String bot,long chatId,Duration retryAfter) {
		validate(bot,chatId);
		if(retryAfter==null || retryAfter.isNegative() || retryAfter.compareTo(Duration.ofDays(365))>0)throw new IllegalArgumentException("invalid_quota_delay");
		// Telegram does not reliably identify the flood scope: conservatively pause this bot and chat.
		var global=bot+":global";var chat=bot+":chat:"+chatId;lock(global);lock(chat);
		var millis=Math.max(1000,retryAfter.toMillis());
		jdbc.sql("update delivery_rate_limits set blocked_until=greatest(blocked_until,clock_timestamp()+(:millis*interval '1 millisecond')),updated_at=clock_timestamp() where bucket_key in (:global,:chat)")
				.param("millis",millis).param("global",global).param("chat",chat).update();
	}
	private Bucket lock(String key) {
		jdbc.sql("insert into delivery_rate_limits(bucket_key) values (:key) on conflict do nothing").param("key",key).update();
		return jdbc.sql("select next_at,blocked_until from delivery_rate_limits where bucket_key=:key for update").param("key",key)
				.query((r,i)->new Bucket(r.getTimestamp(1).toInstant(),r.getTimestamp(2).toInstant())).single();
	}
	private void advance(String key,Instant next) { jdbc.sql("update delivery_rate_limits set next_at=:next,updated_at=clock_timestamp() where bucket_key=:key").param("key",key).param("next",SqlTime.of(next)).update(); }
	private static Instant max(Instant a,Instant b) { return a.isAfter(b)?a:b; }
	private static long interval(long window,int rate) { return (window+rate-1)/rate; }
	private static void validate(String bot,long chat) { if(bot==null || !bot.matches("[0-9]{1,20}") || chat==0)throw new IllegalArgumentException("invalid_quota_target"); }
	public record Limits(int botPerSecond,int privatePerSecond,int groupPerMinute) {
		public Limits { if(botPerSecond<1 || botPerSecond>1000 || privatePerSecond<1 || privatePerSecond>1000 || groupPerMinute<1 || groupPerMinute>60000)throw new IllegalArgumentException("invalid_quota_limits"); }
		public static Limits defaults() { return new Limits(20,1,20); }
	}
	public record Decision(boolean allowed,Instant availableAt) {}
	private record Bucket(Instant next,Instant blocked) {}
}
