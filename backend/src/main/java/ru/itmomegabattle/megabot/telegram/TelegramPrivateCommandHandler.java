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
import ru.itmomegabattle.megabot.availability.TelegramSlotDraftService;
import ru.itmomegabattle.megabot.meetings.TelegramMeetingText;
import ru.itmomegabattle.megabot.meetings.TelegramMeetingDraftService;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
class TelegramPrivateCommandHandler {
	private final TelegramIdentityService identities;private final JdbcClient jdbc;
	private final ObjectMapper json;private final OutboxWriter outbox;
	private final TelegramProfileText profiles;
	private final TelegramSlotDraftService slots;
	private final TelegramSlotCallbackHandler callbacks;
	private final TelegramMeetingText meetings;
	private final TelegramMeetingCallbackHandler meetingCallbacks;
	private final TelegramMeetingDraftService meetingDrafts;
	private final ru.itmomegabattle.megabot.tasks.TelegramTaskText tasks;
	TelegramPrivateCommandHandler(TelegramIdentityService identities,JdbcClient jdbc,ObjectMapper json,OutboxWriter outbox,TelegramProfileText profiles,TelegramSlotDraftService slots,TelegramSlotCallbackHandler callbacks,TelegramMeetingText meetings,TelegramMeetingCallbackHandler meetingCallbacks,TelegramMeetingDraftService meetingDrafts,ru.itmomegabattle.megabot.tasks.TelegramTaskText tasks) {
		this.identities=identities;this.jdbc=jdbc;this.json=json;this.outbox=outbox;this.profiles=profiles;this.slots=slots;this.callbacks=callbacks;this.meetings=meetings;this.meetingCallbacks=meetingCallbacks;this.meetingDrafts=meetingDrafts;this.tasks=tasks;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public void handle(TelegramInboxQueue.Lease lease) {
		var update=json.readTree(lease.payload());var message=update.path("message");
		if(update.has("callback_query")) {
			if(update.path("callback_query").path("data").asText().startsWith("mr:") || TelegramMeetingCallbackHandler.legacy(update))meetingCallbacks.handle(lease);else callbacks.handle(lease);
			return;
		}
		var text=message.path("text");var command=command(text.isString()?text.asText():null);
		if(!text.isString() || !message.path("chat").path("type").asText().equals("private"))
			throw new UnsupportedCommand(); // Preserve commands/groups/callbacks until their handlers exist.
		var from=message.path("from");var chat=message.path("chat").path("id");var id=from.path("id");
		if(!positive(id) || !positive(chat) || chat.longValue()!=id.longValue() || !positive(message.path("message_id"))
				|| !positive(message.path("date")) || !from.path("is_bot").isBoolean() || from.path("is_bot").booleanValue()
				|| message.has("sender_chat") || message.has("forward_origin") || message.has("via_bot") || message.has("business_connection_id")
				|| !lease.chatKey().equals(lease.botId()+":chat:"+chat.longValue())) throw new InvalidPrivateCommand();
		var username=optionalText(from,"username",64);var first=optionalText(from,"first_name",128);var last=optionalText(from,"last_name",128);
		if(first==null) throw new InvalidPrivateCommand();
		var user=identities.resolve(new VerifiedTelegramUser(id.longValue(),username,first,last));
		String reply;List<List<String>> keyboard;TelegramSlotDraftService.Panel panel=null;TelegramMeetingDraftService.Panel meetingPanel=null;ru.itmomegabattle.megabot.tasks.TelegramTaskText.Panel taskPanel=null;
		if(command==null) {
			if(user.isEmpty() || user.get().getRole().startsWith("faculty_"))throw new UnsupportedCommand();
			meetingPanel=meetingDrafts.consumeTextPanel(lease.botId(),chat.longValue(),text.asText(),message);
			if(meetingPanel==null)throw new UnsupportedCommand();
			command="meeting_text";
		}
		if(user.isEmpty()) {
			reply="Вас нет в списке участников. Попросите админа добавить ваш Telegram в раздел «Команда», а потом нажмите /start ещё раз.";
			keyboard=List.of(List.of("Помощь"));
		} else {
			var member=user.get();boolean faculty=member.getRole().startsWith("faculty_");
			if(command.equals("back") && !faculty)meetingPanel=meetingDrafts.backAudiencePanel(lease.botId(),chat.longValue(),message,()->meetings.render(member));
			if(!command.equals("meeting_begin") && !command.equals("meeting_audience") && !command.equals("meeting_text") && meetingPanel==null)meetingDrafts.leaveDialog(lease.botId(),chat.longValue(),member.getId());
			if(command.equals("back") && !faculty && meetingPanel==null)panel=slots.backPanel(lease.botId(),chat.longValue());
			if(!command.equals("slots") && !command.equals("meeting_audience") && !command.equals("meeting_text") && panel==null)slots.leaveEditor(lease.botId(),chat.longValue(),member.getId());
			reply=faculty?"Привет, "+member.getRealName()+"! Здесь будут только задачи от команды MEGABATTLE.":
					"Привет, "+member.getRealName()+"!\n\nЯ MegaBot команды ITMO MEGABATTLE. Здесь можно отметить свободные слоты, посмотреть встречи и работать с задачами. Mini App открывается синей кнопкой «Начать» внизу слева.\n\nВыбери нужный раздел кнопками под строкой ввода.";
			keyboard=faculty?List.of(List.of("Мои задачи","Помощь")):List.of(List.of("Профиль","Слоты","Встречи"),
					member.getRole().equals("admin")?List.of("Задачи","МФ","Помощь"):List.of("Задачи","Помощь"));
			if(command.equals("help"))reply=faculty?
					"Здесь ты получаешь задачи от организаторов. В «Мои задачи» можно посмотреть дедлайны и поменять статус задачи. Если нужна помощь, напиши автору задачи из карточки.":
					"Что умеет бот\n\nПрофиль — личная сводка и статистика.\nСлоты — отметить свободные часы кнопками.\nВстречи — посмотреть и назначить собрание.\nЗадачи — личные, свободные и выполненные задачи.\n"
					+(member.getRole().equals("admin")?"МФ — факультеты и их задачи.\n":"")
					+"\nВ командном чате доступны /all, /meeting, /deadlines, /slots, /birthdays и /checkin.";
			if((command.equals("menu") || command.equals("back")) && faculty)reply="Меню задач.";
			if(command.equals("slots") && faculty)reply="Слоты доступны только организаторам и администратору.";
			if(command.equals("meeting_begin") && faculty)reply="Встречи доступны только организаторам и администратору.";
			if(command.equals("meeting_audience")) {
				if(faculty)reply="Встречи доступны только организаторам и администратору.";
				else {
					meetingPanel=meetingDrafts.chooseAudiencePanel(lease.botId(),chat.longValue(),TelegramMeetingDraftService.audienceMode(text.asText()),message);
					reply=TelegramMeetingDraftService.AUDIENCE_REFUSAL;
					keyboard=List.of(List.of("Назначить собрание"),List.of("Меню","Назад"));
				}
			}
			if(command.equals("meetings")) {
				reply=faculty?"Встречи доступны только организаторам и администратору.":meetings.render(member);
				if(!faculty)keyboard=List.of(List.of("Назначить собрание"),List.of("Меню","Назад"));
			}
			if(command.equals("profile") || (command.equals("menu") || command.equals("back")) && !faculty && meetingPanel==null) {
				reply=profiles.render(member);
				if(faculty)keyboard=List.of(List.of("Профиль","Мои задачи"),List.of("Помощь"));
			}
            if(ru.itmomegabattle.megabot.tasks.TelegramTaskText.supported(command)) {taskPanel=tasks.render(member,command);reply=taskPanel.text();}
			jdbc.sql("update users set joined_at=coalesce(joined_at,clock_timestamp()),last_seen_at=clock_timestamp() where id=:user")
					.param("user",member.getId()).update();
			jdbc.sql("insert into chat_bindings(id,bot_id,chat_id,type) values (:id,:bot,:chat,'private') on conflict(bot_id,chat_id,type) do nothing")
					.param("id","binding_"+UUID.randomUUID()).param("bot",lease.botId()).param("chat",chat.longValue()).update();
			if(command.equals("slots") && !faculty) {panel=slots.openPanel(lease.botId(),chat.longValue());reply=panel.text();}
			if(command.equals("meeting_begin") && !faculty) {meetingPanel=meetingDrafts.beginPanel(lease.botId(),chat.longValue());reply=meetingPanel.text();}
			if(panel!=null)reply=panel.text();
			if(meetingPanel!=null)reply=meetingPanel.text();
			jdbc.sql("insert into bot_messages(id,user_id,sender,text,occurred_at) values (:id,:user,'user',:text,clock_timestamp())")
					.param("id","message_"+UUID.randomUUID()).param("user",member.getId()).param("text",text.asText()).update();
		}
		var markup=taskPanel!=null?taskPanel.markup():meetingPanel!=null?meetingPanel.markup():panel==null?new TelegramTransport.ReplyKeyboard(keyboard).markup():panel.markup();
		var payload=json.createObjectNode().put("botId",lease.botId()).put("chatId",chat.longValue()).put("text",reply)
				.put("command",command).put("sourceMessageId",message.path("message_id").longValue());
		if(user.isPresent()) payload.put("recipientId",user.get().getId()).put("recipientRole",user.get().getRole());
		if(user.isPresent() && (command.equals("profile") || command.equals("meetings") || meetingPanel!=null || taskPanel!=null || panel!=null || (command.equals("menu") || command.equals("back")) && !user.get().getRole().startsWith("faculty_")))
			payload.put("profileVersion",user.get().getVersion());
		if(taskPanel!=null) {
            payload.set("taskView",taskPanel.tasks());
            if(user.get().getRole().startsWith("faculty_"))payload.put("taskFacultyId",taskPanel.facultyId());
        }
        if(panel!=null)payload.put("slotDraftId",panel.draftId()).put("slotRevision",panel.revision()).put("slotSettingsVersion",panel.settingsVersion());
		if(meetingPanel!=null && meetingPanel.draftId()!=null)payload.put("meetingDraftId",meetingPanel.draftId()).put("meetingRevision",meetingPanel.revision());
		if(meetingPanel!=null && meetingPanel.offerId()!=null)payload.put("meetingOfferId",meetingPanel.offerId());
		if(command.equals("meeting_audience"))payload.put("meetingAudience",TelegramMeetingDraftService.audienceMode(text.asText()));
		if(command.equals("meeting_text"))payload.put("meetingInput",text.asText());
		payload.set("replyMarkup",json.valueToTree(markup));
		var now=jdbc.sql("select clock_timestamp()").query((row,index)->row.getTimestamp(1).toInstant()).single();
		outbox.write("telegram_inbox",lease.id(),"telegram_command_reply","telegram:"+command+":"+lease.botId()+":"+lease.updateId(),
				json.writeValueAsString(payload),now);
	}
	/** Exact aliases only; mentions and prefix lookalikes stay unhandled. */
	static boolean replyMatchesInput(JsonNode reply,JsonNode input) {
		var text=input.path("message").path("text");
		if("meeting_text".equals(reply.path("command").asText()))return text.isString() && reply.path("meetingInput").isString()
				&& reply.path("meetingInput").asText().equals(text.asText()) && command(text.asText())==null;
		return text.isString() && reply.path("command").asText().equals(command(text.asText()));
	}

	static String command(String text) {
		if(text==null)return null;var normalized=text.trim().toLowerCase(Locale.ROOT);
		if(normalized.equals("/start") || normalized.startsWith("/start "))return "start";
		return switch(normalized) { case "помощь","/help"->"help";case "меню"->"menu";case "назад"->"back";case "профиль"->"profile";case "встречи"->"meetings";case "назначить собрание"->"meeting_begin";case "собрать всю команду","выбрать блок"->"meeting_audience";case "слоты","/slots"->"slots";case "задачи","/tasks"->"tasks";case "мои задачи"->"my_tasks";case "свободные задачи"->"open_tasks";case "выполненные задачи"->"completed_tasks";default->null; };
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
