package ru.itmomegabattle.megabot.notifications;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/** One network attempt; no retry, DB transaction or raw provider error leaves this boundary. */
public interface TelegramTransport {
	Outcome send(Message message);
	record Message(long chatId,Long threadId,String text,boolean silent,ReplyKeyboard keyboard) {
		public Message(long chatId,Long threadId,String text,boolean silent) { this(chatId,threadId,text,silent,null); }
		public Message {
			if(chatId==0 || threadId!=null && threadId<1 || text==null || text.isBlank() || text.length()>4000)
				throw new IllegalArgumentException("invalid_telegram_message");
			if(keyboard!=null && (chatId<1 || threadId!=null))throw new IllegalArgumentException("invalid_keyboard_target");
		}
	}
	/** Text-only private menu. No arbitrary Bot API fields cross this boundary. */
	record ReplyKeyboard(List<List<String>> rows) {
		public ReplyKeyboard {
			if(rows==null || rows.isEmpty() || rows.size()>8)throw invalid();
			rows=rows.stream().map(row->{
				if(row==null || row.isEmpty() || row.size()>8 || row.stream().anyMatch(s->s==null || s.isBlank() || s.length()>128))throw invalid();
				return List.copyOf(row);
			}).toList();
		}
		public Map<String,Object> markup() {
			return Map.of("keyboard",rows.stream().map(row->row.stream().map(s->Map.of("text",s)).toList()).toList(),
					"resize_keyboard",true,"is_persistent",false,"one_time_keyboard",false);
		}
		public static ReplyKeyboard parse(JsonNode node) {
			if(node==null || !node.isObject() || node.size()!=4 || !node.path("resize_keyboard").isBoolean() || !node.path("resize_keyboard").booleanValue()
					|| !node.path("is_persistent").isBoolean() || node.path("is_persistent").booleanValue()
					|| !node.path("one_time_keyboard").isBoolean() || node.path("one_time_keyboard").booleanValue()
					|| !node.path("keyboard").isArray())throw invalid();
			var rows=new java.util.ArrayList<List<String>>();
			for(var row:node.path("keyboard")) {
				if(!row.isArray())throw invalid();var labels=new java.util.ArrayList<String>();
				for(var button:row) {
					if(!button.isObject() || button.size()!=1 || !button.path("text").isString())throw invalid();
					labels.add(button.path("text").asText());
				}
				rows.add(labels);
			}
			return new ReplyKeyboard(rows);
		}
		private static IllegalArgumentException invalid() { return new IllegalArgumentException("invalid_reply_keyboard"); }
	}
	enum Kind { SENT, RETRY, FAILED, UNKNOWN }
	record Outcome(Kind kind,String code,Long messageId,Duration retryAfter) {
		public static Outcome sent(long id) { return new Outcome(Kind.SENT,null,id,null); }
		public static Outcome retry(String code,Duration delay) { return new Outcome(Kind.RETRY,code,null,delay); }
		public static Outcome failed(String code) { return new Outcome(Kind.FAILED,code,null,null); }
		public static Outcome unknown(String code) { return new Outcome(Kind.UNKNOWN,code,null,null); }
	}
}
