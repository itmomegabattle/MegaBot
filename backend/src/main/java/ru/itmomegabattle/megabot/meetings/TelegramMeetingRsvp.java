package ru.itmomegabattle.megabot.meetings;

import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.notifications.TelegramTransport;
import tools.jackson.databind.ObjectMapper;

/** Invitations use an opaque persisted target, never a raw legacy meeting ID in callback data. */
@Service
public class TelegramMeetingRsvp {
	private final JdbcClient jdbc;
	private final ObjectMapper json;
	private final MeetingService meetings;

	TelegramMeetingRsvp(JdbcClient jdbc, ObjectMapper json, MeetingService meetings) {
		this.jdbc=jdbc;this.json=json;this.meetings=meetings;
	}

	public static TelegramTransport.InlineKeyboard keyboard(String target) {
		return keyboard(target,"unanswered");
	}
	public static TelegramTransport.InlineKeyboard keyboard(String target,String response) {
		if (target==null || !target.matches("meeting_target_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
			throw new IllegalArgumentException("invalid_meeting_target");
		var prefix="mr:"+target.substring("meeting_target_".length())+":";
		return new TelegramTransport.InlineKeyboard(List.of(
				List.of(new TelegramTransport.InlineButton("yes".equals(response)?"✅ Приду":"Приду",prefix+"y")),
				List.of(new TelegramTransport.InlineButton("no".equals(response)?"❌ Не приду":"Не приду",prefix+"n")),
				List.of(new TelegramTransport.InlineButton("Сбросить ответ",prefix+"u"))));
	}

	public static String target(String data) {
		return data!=null && data.matches("mr:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[ynu]")
				?"meeting_target_"+data.substring(3,39):null;
	}

	private static final String SOURCE="""
			select m.id,u.id,u.username,u.real_name,u.role,d.payload::text,t.id,
			(select i.rsvp from meeting_invitations i where i.meeting_id=m.id and i.user_id=u.id),u.version
			from notification_deliveries d join meeting_notification_targets t on t.id=d.meeting_target_id
			join meeting_notification_events e on e.id=t.event_id join outbox_events o on o.id=e.id
			join meetings m on m.id=e.meeting_id join users u on u.id=t.recipient_id
			join users actor on actor.id=e.actor_id
			where d.category='meeting_event' and t.kind='invited' and t.chat_id>0 and t.message_thread_id is null
			and d.chat_id=t.chat_id and d.recipient_id=t.recipient_id and d.message_thread_id is null
			and not d.disable_notification and not d.cancel_requested and d.operation_id=o.id
			and o.status='completed' and e.state='queued' and e.action in ('created','updated','reminder')
			and m.status='scheduled' and m.version=e.meeting_version
			and m.starts_at+make_interval(mins=>m.duration_minutes)>clock_timestamp()
			and u.active and u.registered and u.role in ('admin','organizer') and u.telegram_id=t.chat_id
			and actor.active and actor.registered and (actor.role='admin' or (actor.role='organizer' and m.host_id=actor.id))
			and d.payload->>'botId'=:bot and d.payload->>'meetingId'=m.id and d.payload->>'meetingVersion'=m.version::text
			and exists(select 1 from meeting_invitations i where i.meeting_id=m.id and i.user_id=u.id)
			""";

	@Transactional(readOnly=true)
	public boolean sendAllowed(String delivery,String token,String bot) {
		var source=jdbc.sql(SOURCE+" and d.id=:delivery and d.lease_token=:token and d.status in ('claimed','sending') and d.leased_until>clock_timestamp() and d.expires_at>clock_timestamp()")
				.param("delivery",delivery).param("token",token).param("bot",bot)
				.query((r,i)->new Source(r.getString(1),null,r.getString(6),r.getString(7))).optional();
		return source.isPresent() && canonical(source.get());
	}

	@Transactional(propagation=Propagation.MANDATORY)
	public Reply respond(String bot,long chat,long message,String data) {
		var target=target(data);if(target==null)return null;
		// Domain parent first, matching meeting updates and outgoing delivery start.
		var meeting=jdbc.sql("select e.meeting_id from meeting_notification_targets t join meeting_notification_events e on e.id=t.event_id where t.id=:target")
				.param("target",target).query(String.class).optional();
		if(meeting.isEmpty())return null;
		jdbc.sql("select id from meetings where id=:meeting for update").param("meeting",meeting.get()).query(String.class).optional();
		jdbc.sql("select id from users where telegram_id=:chat for no key update").param("chat",chat).query(String.class).optional();
		var source=confirmed(bot,chat,message,target);
		if(source.isEmpty() || !canonical(source.get()))return null;
		var response=switch(data.charAt(data.length()-1)){case 'y'->"yes";case 'n'->"no";default->"unanswered";};
		meetings.rsvp(source.get().meeting(),response,source.get().actor());
		var answer=switch(response){case "yes"->"Отметил: вы придёте";case "no"->"Отметил: вы не придёте";default->"Ответ сброшен";};
		return new Reply(answer,json.readTree(source.get().payload()).path("text").asText(),source.get().actor(),source.get().profileVersion(),target,response);
	}

	private java.util.Optional<Source> confirmed(String bot,long chat,long message,String target) {
		return jdbc.sql(SOURCE+" and t.id=:target and t.chat_id=:chat and d.status='sent' and d.telegram_message_id=:message and exists(select 1 from chat_bindings b where b.bot_id=:bot and b.chat_id=:chat and b.type='private')")
				.param("bot",bot).param("target",target).param("chat",chat).param("message",message)
				.query((r,i)->new Source(r.getString(1),new AuthenticatedUser(r.getString(2),r.getString(3),r.getString(4),r.getString(5)),r.getString(6),r.getString(7),r.getString(8),r.getLong(9))).optional();
	}

	@Transactional(readOnly=true)
	public boolean editAllowed(String payload) {
		var root=json.readTree(payload);
		if(!root.path("command").asText().equals("meeting_callback"))return true;
		var target=target(root.path("sourceCallbackData").asText());
		if(target==null || !target.equals(root.path("meetingTargetId").asText()) || root.size()!=15
				|| !root.path("chatId").isIntegralNumber() || !root.path("chatId").canConvertToLong()
				|| !root.path("targetMessageId").isIntegralNumber() || !root.path("targetMessageId").canConvertToLong()
				|| !root.path("profileVersion").isIntegralNumber() || !root.path("profileVersion").canConvertToLong())return false;
		var source=confirmed(root.path("botId").asText(),root.path("chatId").longValue(),root.path("targetMessageId").longValue(),target);
		return source.isPresent() && canonical(source.get())
				&& source.get().actor().id().equals(root.path("recipientId").asText())
				&& source.get().actor().role().equals(root.path("recipientRole").asText())
				&& source.get().profileVersion()==root.path("profileVersion").longValue()
				&& source.get().response().equals(root.path("meetingResponse").asText())
				&& json.readTree(source.get().payload()).path("text").equals(root.path("text"))
				&& root.path("replyMarkup").equals(json.valueToTree(keyboard(target,source.get().response()).markup()));
	}

	private boolean canonical(Source source) {
		try {
			var payload=json.readTree(source.payload());
			return payload.isObject() && payload.size()==5 && payload.path("text").isString()
					&& payload.path("replyMarkup").equals(json.valueToTree(keyboard(source.target()).markup()));
		}catch(IllegalArgumentException invalid){return false;}
	}
	public record Reply(String answer,String text,AuthenticatedUser actor,long profileVersion,String target,String response) {}
	private record Source(String meeting,AuthenticatedUser actor,String payload,String target,String response,long profileVersion) {
		Source(String meeting,AuthenticatedUser actor,String payload,String target){this(meeting,actor,payload,target,null,0);}
	}
}
