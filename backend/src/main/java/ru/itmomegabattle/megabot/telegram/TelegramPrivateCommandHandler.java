package ru.itmomegabattle.megabot.telegram;

import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.auth.TelegramIdentityService;
import ru.itmomegabattle.megabot.auth.VerifiedTelegramUser;
import ru.itmomegabattle.megabot.notifications.OutboxWriter;
import ru.itmomegabattle.megabot.notifications.TelegramTransport;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
class TelegramPrivateCommandHandler {
	private final TelegramIdentityService identities;private final JdbcClient jdbc;
	private final ObjectMapper json;private final OutboxWriter outbox;
	private final TelegramProfileText profiles;
	TelegramPrivateCommandHandler(TelegramIdentityService identities,JdbcClient jdbc,ObjectMapper json,OutboxWriter outbox,TelegramProfileText profiles) {
		this.identities=identities;this.jdbc=jdbc;this.json=json;this.outbox=outbox;this.profiles=profiles;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public void handle(TelegramInboxQueue.Lease lease) {
		var update=json.readTree(lease.payload());var message=update.path("message");
		var text=message.path("text");var command=command(text.isString()?text.asText():null);
		if(command==null || !message.path("chat").path("type").asText().equals("private"))
			throw new UnsupportedCommand(); // Preserve commands/groups/callbacks until their handlers exist.
		var from=message.path("from");var chat=message.path("chat").path("id");var id=from.path("id");
		if(!positive(id) || !positive(chat) || chat.longValue()!=id.longValue() || !positive(message.path("message_id"))
				|| !positive(message.path("date")) || !from.path("is_bot").isBoolean() || from.path("is_bot").booleanValue()
				|| message.has("sender_chat") || message.has("forward_origin") || message.has("via_bot") || message.has("business_connection_id")
				|| !lease.chatKey().equals(lease.botId()+":chat:"+chat.longValue())) throw new InvalidPrivateCommand();
		var username=optionalText(from,"username",64);var first=optionalText(from,"first_name",128);var last=optionalText(from,"last_name",128);
		if(first==null) throw new InvalidPrivateCommand();
		var user=identities.resolve(new VerifiedTelegramUser(id.longValue(),username,first,last));
		String reply;List<List<String>> keyboard;
		if(user.isEmpty()) {
			reply="Вас нет в списке участников. Попросите админа добавить ваш Telegram в раздел «Команда», а потом нажмите /start ещё раз.";
			keyboard=List.of(List.of("Помощь"));
		} else {
			var member=user.get();boolean faculty=member.getRole().startsWith("faculty_");
			reply=faculty?"Привет, "+member.getRealName()+"! Здесь будут только задачи от команды MEGABATTLE.":
					"Привет, "+member.getRealName()+"!\n\nЯ MegaBot команды ITMO MEGABATTLE. Здесь можно отметить свободные слоты, посмотреть встречи и работать с задачами. Mini App открывается синей кнопкой «Начать» внизу слева.\n\nВыбери нужный раздел кнопками под строкой ввода.";
			keyboard=faculty?List.of(List.of("Мои задачи","Помощь")):List.of(List.of("Профиль","Слоты","Встречи"),
					member.getRole().equals("admin")?List.of("Задачи","МФ","Помощь"):List.of("Задачи","Помощь"));
			if(command.equals("help"))reply=faculty?
					"Здесь ты получаешь задачи от организаторов. В «Мои задачи» можно посмотреть дедлайны и поменять статус задачи. Если нужна помощь, напиши автору задачи из карточки.":
					"Что умеет бот\n\nПрофиль — личная сводка и статистика.\nСлоты — отметить свободные часы кнопками.\nВстречи — посмотреть и назначить собрание.\nЗадачи — личные, свободные и выполненные задачи.\n"
					+(member.getRole().equals("admin")?"МФ — факультеты и их задачи.\n":"")
					+"\nВ командном чате доступны /all, /meeting, /deadlines, /slots, /birthdays и /checkin.";
			if(command.equals("menu") && faculty)reply="Меню задач.";
			if(command.equals("profile") || command.equals("menu") && !faculty) {
				reply=profiles.render(member);
				if(faculty)keyboard=List.of(List.of("Профиль","Мои задачи"),List.of("Помощь"));
			}
			jdbc.sql("update users set joined_at=coalesce(joined_at,clock_timestamp()),last_seen_at=clock_timestamp() where id=:user")
					.param("user",member.getId()).update();
			jdbc.sql("insert into chat_bindings(id,bot_id,chat_id,type) values (:id,:bot,:chat,'private') on conflict(bot_id,chat_id,type) do nothing")
					.param("id","binding_"+UUID.randomUUID()).param("bot",lease.botId()).param("chat",chat.longValue()).update();
			jdbc.sql("insert into bot_messages(id,user_id,sender,text,occurred_at) values (:id,:user,'user',:text,clock_timestamp())")
					.param("id","message_"+UUID.randomUUID()).param("user",member.getId()).param("text",text.asText()).update();
		}
		var markup=new TelegramTransport.ReplyKeyboard(keyboard).markup();
		var payload=json.createObjectNode().put("botId",lease.botId()).put("chatId",chat.longValue()).put("text",reply)
				.put("command",command).put("sourceMessageId",message.path("message_id").longValue());
		if(user.isPresent()) payload.put("recipientId",user.get().getId()).put("recipientRole",user.get().getRole());
		if(user.isPresent() && (command.equals("profile") || command.equals("menu") && !user.get().getRole().startsWith("faculty_")))
			payload.put("profileVersion",user.get().getVersion());
		payload.set("replyMarkup",json.valueToTree(markup));
		var now=jdbc.sql("select clock_timestamp()").query((row,index)->row.getTimestamp(1).toInstant()).single();
		outbox.write("telegram_inbox",lease.id(),"telegram_command_reply","telegram:"+command+":"+lease.botId()+":"+lease.updateId(),
				json.writeValueAsString(payload),now);
	}
	/** Exact aliases only; mentions, prefix lookalikes and unsupported dialog navigation stay unhandled. */
	static String command(String text) {
		if(text==null)return null;var normalized=text.trim().toLowerCase(Locale.ROOT);
		if(normalized.equals("/start") || normalized.startsWith("/start "))return "start";
		return switch(normalized) { case "помощь","/help"->"help";case "меню"->"menu";case "профиль"->"profile";default->null; };
	}
	private static boolean positive(JsonNode n) { return n.isIntegralNumber() && n.canConvertToLong() && n.longValue()>0; }
	private static String optionalText(JsonNode node,String key,int max) {
		var value=node.get(key);if(value==null) return null;
		if(!value.isString() || value.asText().length()>max) throw new InvalidPrivateCommand();
		var text=value.asText().trim();return text.isEmpty()?null:text;
	}
	static class UnsupportedCommand extends RuntimeException {}
	static class InvalidPrivateCommand extends RuntimeException {}
}
