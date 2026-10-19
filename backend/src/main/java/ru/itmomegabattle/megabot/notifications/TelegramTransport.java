package ru.itmomegabattle.megabot.notifications;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/** One network attempt; no retry, DB transaction or raw provider error leaves this boundary. */
public interface TelegramTransport {
	Outcome send(Message message);
	default Outcome edit(Edit edit) { return Outcome.failed("unsupported_edit_transport"); }
	default Outcome acknowledge(Acknowledgement ack) { return Outcome.failed("unsupported_ack_transport"); }
	default Outcome delete(Deletion deletion) { return Outcome.failed("unsupported_delete_transport"); }
	static String operation(JsonNode payload) {
		if(!payload.has("operation"))return "send";
		if(payload.path("operation").isString()) {
			var op=payload.path("operation").asText();var command=payload.path("command").asText();
			if(op.equals("edit") && (command.equals("slot_callback") || command.equals("meeting_callback")) || op.equals("ack") && command.equals("callback_ack"))return op;
			if(op.equals("delete") && command.equals("slot_panel_delete"))return op;
		}
		throw new IllegalArgumentException("invalid_telegram_operation");
	}
	static Edit editFrom(long chat,JsonNode payload) {
		var id=payload.path("targetMessageId");
		if(!id.isIntegralNumber() || !id.canConvertToLong() || !payload.path("text").isString())throw new IllegalArgumentException("invalid_panel_edit");
		return new Edit(chat,id.longValue(),payload.path("text").asText(),InlineKeyboard.parse(payload.path("replyMarkup")));
	}
	static Deletion deletionFrom(long chat,JsonNode payload) {
		var id=payload.path("targetMessageId");
		if(!id.isIntegralNumber() || !id.canConvertToLong() || payload.has("replyMarkup") || payload.has("text"))
			throw new IllegalArgumentException("invalid_panel_delete");
		return new Deletion(chat,id.longValue());
	}
	record Deletion(long chatId,long messageId) {
		public Deletion { if(chatId<1 || messageId<1)throw new IllegalArgumentException("invalid_panel_delete"); }
	}
	static Acknowledgement ackFrom(long chat,JsonNode payload) {
		if(!payload.path("text").isString() || !payload.path("sourceCallbackId").isString()
				|| payload.has("replyMarkup") || payload.has("targetMessageId") || payload.has("recipientId") || payload.has("recipientRole"))
			throw new IllegalArgumentException("invalid_callback_ack");
		return new Acknowledgement(chat,payload.path("sourceCallbackId").asText(),payload.path("text").asText());
	}
	record Edit(long chatId,long messageId,String text,InlineKeyboard keyboard) {
		public Edit {
			if(chatId<1 || messageId<1 || keyboard==null)throw new IllegalArgumentException("invalid_panel_edit");
			new Message(chatId,null,text,false,null,keyboard);
		}
	}
	record Acknowledgement(long chatId,String callbackId,String text) {
		public Acknowledgement {
			if(chatId<1 || callbackId==null || callbackId.isBlank() || callbackId.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>256
					|| !java.nio.charset.StandardCharsets.UTF_8.newEncoder().canEncode(callbackId) || text==null || text.length()>200)
				throw new IllegalArgumentException("invalid_callback_ack");
		}
	}
	record Message(long chatId,Long threadId,String text,boolean silent,ReplyKeyboard keyboard,InlineKeyboard inlineKeyboard) {
		public Message(long chatId,Long threadId,String text,boolean silent) { this(chatId,threadId,text,silent,null,null); }
		public Message(long chatId,Long threadId,String text,boolean silent,ReplyKeyboard keyboard) { this(chatId,threadId,text,silent,keyboard,null); }
		public Message {
			if(chatId==0 || threadId!=null && threadId<1 || text==null || text.isBlank() || text.length()>4000)
				throw new IllegalArgumentException("invalid_telegram_message");
			if((keyboard!=null || inlineKeyboard!=null) && (chatId<1 || threadId!=null))throw new IllegalArgumentException("invalid_keyboard_target");
			if(keyboard!=null && inlineKeyboard!=null)throw new IllegalArgumentException("conflicting_keyboards");
		}
		/** One shared strict parser for planner and sender; no arbitrary Bot API fields. */
		public static Message withMarkup(long chatId,Long threadId,String text,boolean silent,JsonNode markup) {
			if(markup==null)return new Message(chatId,threadId,text,silent);
			return markup.has("inline_keyboard")?new Message(chatId,threadId,text,silent,null,InlineKeyboard.parse(markup)):
					new Message(chatId,threadId,text,silent,ReplyKeyboard.parse(markup));
		}
	}
	/** Private callback buttons only. URLs, payments, login and Web Apps are deliberately unsupported. */
	record InlineButton(String text,String callbackData) {
		public InlineButton {
			if(text==null || text.isBlank() || text.length()>128 || callbackData==null || callbackData.isBlank()
					|| callbackData.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>64
					|| !java.nio.charset.StandardCharsets.UTF_8.newEncoder().canEncode(callbackData))throw new IllegalArgumentException("invalid_inline_keyboard");
		}
	}
	record InlineKeyboard(List<List<InlineButton>> rows) {
		public InlineKeyboard {
			// Bounded for slot-day/week panels; raise only with a concrete larger panel and its tests.
			if(rows==null || rows.isEmpty() || rows.size()>16)throw invalid();
			rows=rows.stream().map(row->{
				if(row==null || row.isEmpty() || row.size()>8 || row.stream().anyMatch(java.util.Objects::isNull))throw invalid();
				return List.copyOf(row);
			}).toList();
		}
		public Map<String,Object> markup() {
			return Map.of("inline_keyboard",rows.stream().map(row->row.stream()
					.map(button->Map.of("text",button.text(),"callback_data",button.callbackData())).toList()).toList());
		}
		public static InlineKeyboard parse(JsonNode node) {
			if(node==null || !node.isObject() || node.size()!=1 || !node.path("inline_keyboard").isArray())throw invalid();
			var rows=new java.util.ArrayList<List<InlineButton>>();
			for(var row:node.path("inline_keyboard")) {
				if(!row.isArray())throw invalid();var buttons=new java.util.ArrayList<InlineButton>();
				for(var button:row) {
					if(!button.isObject() || button.size()!=2 || !button.path("text").isString() || !button.path("callback_data").isString())throw invalid();
					buttons.add(new InlineButton(button.path("text").asText(),button.path("callback_data").asText()));
				}
				rows.add(buttons);
			}
			return new InlineKeyboard(rows);
		}
		private static IllegalArgumentException invalid() { return new IllegalArgumentException("invalid_inline_keyboard"); }
	}
	/** Text-only private menu. No arbitrary Bot API fields cross this boundary. */
	record ReplyKeyboard(List<List<String>> rows,boolean forceReply) {
		public ReplyKeyboard(List<List<String>> rows) { this(rows,false); }
		public ReplyKeyboard {
			if(rows==null || rows.isEmpty() || rows.size()>8)throw invalid();
			rows=rows.stream().map(row->{
				if(row==null || row.isEmpty() || row.size()>8 || row.stream().anyMatch(s->s==null || s.isBlank() || s.length()>128))throw invalid();
				return List.copyOf(row);
			}).toList();
		}
		public Map<String,Object> markup() {
			var markup=new java.util.LinkedHashMap<String,Object>(Map.of("keyboard",rows.stream().map(row->row.stream().map(s->Map.of("text",s)).toList()).toList(),
					"resize_keyboard",true,"is_persistent",false,"one_time_keyboard",false));
			if(forceReply)markup.put("force_reply",true);
			return Map.copyOf(markup);
		}
		public static ReplyKeyboard parse(JsonNode node) {
			if(node==null || !node.isObject() || node.size()!=(node.has("force_reply")?5:4)
					|| node.has("force_reply") && (!node.path("force_reply").isBoolean() || !node.path("force_reply").booleanValue())
					|| !node.path("resize_keyboard").isBoolean() || !node.path("resize_keyboard").booleanValue()
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
			return new ReplyKeyboard(rows,node.has("force_reply"));
		}
		private static IllegalArgumentException invalid() { return new IllegalArgumentException("invalid_reply_keyboard"); }
	}
	enum Kind { SENT, RETRY, FAILED, UNKNOWN }
	record Outcome(Kind kind,String code,Long messageId,Duration retryAfter) {
		public static Outcome sent(long id) { return new Outcome(Kind.SENT,null,id,null); }
		public static Outcome acknowledged() { return new Outcome(Kind.SENT,null,null,null); }
		public static Outcome retry(String code,Duration delay) { return new Outcome(Kind.RETRY,code,null,delay); }
		public static Outcome failed(String code) { return new Outcome(Kind.FAILED,code,null,null); }
		public static Outcome unknown(String code) { return new Outcome(Kind.UNKNOWN,code,null,null); }
	}
}
