package ru.itmomegabattle.megabot.telegram;

import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.ApiException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Internal intake only: transport must authenticate the configured bot before calling. */
@Service
public class TelegramInbox {
	public static final int MAX_UPDATE_BYTES=1024*1024;
	private final JdbcClient jdbc;
	private final ObjectMapper json;
	TelegramInbox(JdbcClient jdbc,ObjectMapper json) { this.jdbc=jdbc;this.json=json; }

	/** Return only after its own COMMIT. False means already durable, not already processed. */
	@Transactional(propagation=Propagation.REQUIRES_NEW,timeout=5)
	public boolean accept(String botId,byte[] payload) {
		if(botId==null || !botId.matches("[1-9][0-9]{0,19}")) throw new IllegalArgumentException("Invalid configured bot ID");
		if(payload==null || payload.length==0) throw invalid();
		if(payload.length>MAX_UPDATE_BYTES)
			throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE,"telegram_update_too_large","Telegram update превышает допустимый размер");
		JsonNode update;
		try { update=json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(payload); }
		catch(JacksonException malformed) { throw invalid(); }
		if(update==null || !update.isObject()) throw invalid();
		var id=update.path("update_id");
		if(!id.isIntegralNumber() || !id.canConvertToLong() || id.longValue()<0) throw invalid();
		// ponytail: existing unique constraint arbitrates concurrent retries; keep the first payload/state.
		return jdbc.sql("""
				insert into telegram_inbox(id,bot_id,update_id,chat_key,payload,status)
				values (:id,:bot,:update,:chat,cast(:payload as jsonb),'received')
				on conflict (bot_id,update_id) do nothing
				""").param("id","inbox_"+UUID.randomUUID()).param("bot",botId).param("update",id.longValue())
				.param("chat",chatKey(botId,update)).param("payload",json.writeValueAsString(update)).update()==1;
	}
	static String chatKey(String botId,JsonNode update) {
		for(var field:update.properties()) {
			var value=field.getValue();
			var chat=value.path("chat").path("id");
			if(!validId(chat)) chat=value.path("message").path("chat").path("id");
			if(validId(chat)) return botId+":chat:"+chat.longValue();
		}
		for(var field:update.properties()) {
			var user=field.getValue().path("from").path("id");
			if(validId(user) && user.longValue()>0) return botId+":user:"+user.longValue();
		}
		return botId+":unscoped"; // Unknown/no-chat updates are preserved for explicit handling, not discarded.
	}
	private static boolean validId(JsonNode id) { return id.isIntegralNumber() && id.canConvertToLong() && id.longValue()!=0; }
	private static ApiException invalid() {
		return new ApiException(HttpStatus.BAD_REQUEST,"invalid_telegram_update","Некорректный Telegram update");
	}
}
