package ru.itmomegabattle.megabot.meetings;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.SqlTime;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Meeting -> source -> target/delivery lock order, shared with meeting commands and queue start. */
@Service
public class MeetingNotificationPlanner {
	private final JdbcClient jdbc;private final DeliveryQueue queue;private final ObjectMapper json;
	public MeetingNotificationPlanner(JdbcClient jdbc,DeliveryQueue queue,ObjectMapper json) { this.jdbc=jdbc;this.queue=queue;this.json=json; }
	@Transactional
	public int materialize(int limit,String bot) {
		if(limit<1 || limit>100 || bot==null || !bot.matches("[0-9]{1,20}"))throw new IllegalArgumentException("invalid_meeting_batch");
		jdbc.sql("""
				update outbox_events e set status='cancelled',last_error_code='meeting_unavailable',updated_at=clock_timestamp()
				where aggregate_type='meeting' and event_type in ('meeting.created','meeting.updated','meeting.cancelled','meeting.reminder') and status in ('pending','retry') and available_at<=clock_timestamp()
				and not exists(select 1 from meetings m where m.id=e.aggregate_id)
				""").update();
		var meetings=jdbc.sql("""
				select m.id,m.version,m.status,m.starts_at+make_interval(mins=>m.duration_minutes) as ends_at,m.host_id,m.starts_at from meetings m
				where exists(select 1 from outbox_events e where e.aggregate_type='meeting' and e.aggregate_id=m.id
				and e.event_type in ('meeting.created','meeting.updated','meeting.cancelled','meeting.reminder') and e.status in ('pending','retry') and e.available_at<=clock_timestamp())
				order by m.id for update skip locked limit :limit
				""").param("limit",limit).query((r,i)->new Meeting(r.getString(1),r.getLong(2),r.getString(3),r.getTimestamp(4).toInstant(),r.getString(5),r.getTimestamp(6).toInstant())).list();
		int count=0;
		for(var meeting:meetings) {
			var sources=jdbc.sql("""
					select id,event_type,payload::text,available_at from outbox_events where aggregate_type='meeting' and aggregate_id=:id
					and event_type in ('meeting.created','meeting.updated','meeting.cancelled','meeting.reminder') and status in ('pending','retry') and available_at<=clock_timestamp()
					order by available_at,id for update limit 20
					""").param("id",meeting.id()).query((r,i)->new Source(r.getString(1),r.getString(2).substring(8),r.getString(3),r.getTimestamp(4).toInstant())).list();
			for(var source:sources) {
				count++;Snapshot snapshot;
				try { snapshot=parse(source,meeting.id()); }
				catch(RuntimeException invalid) { finish(source.id(),"failed","invalid_meeting_snapshot");continue; }
				boolean audited=jdbc.sql("""
						select count(*) from audit_events where entity_type='meeting' and entity_id=:meeting and actor_id=:actor and action=:action
						and coalesce(changes->>'version',changes->'after'->>'version')=:version
						""").param("meeting",meeting.id()).param("actor",snapshot.actor()).param("action",snapshot.originAction()).param("version",Long.toString(snapshot.version())).query(Long.class).single()>0;
				if(!audited) { finish(source.id(),"failed","meeting_actor_not_verified");continue; }
				boolean actorValid=jdbc.sql("select count(*) from users where id=:actor and active and registered and (role='admin' or (role='organizer' and id=:host))")
						.param("actor",snapshot.actor()).param("host",meeting.host()).query(Long.class).single()>0;
				var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
				var expires=source.due().plusSeconds(900);
				if(!source.action().equals("cancelled") && meeting.ends().isBefore(expires))expires=meeting.ends();
				if(source.action().equals("reminder") && meeting.starts().isBefore(expires))expires=meeting.starts();
				String state=!actorValid || meeting.version()!=snapshot.version() || !meeting.status().equals(source.action().equals("cancelled")?"cancelled":"scheduled")?"cancelled":!expires.isAfter(now)?"expired":"queued";
				jdbc.sql("insert into meeting_notification_events(id,meeting_id,meeting_version,actor_id,action,expires_at,state) values (:id,:meeting,:version,:actor,:action,:expires,:state)")
						.param("id",source.id()).param("meeting",meeting.id()).param("version",snapshot.version()).param("actor",snapshot.actor()).param("action",source.action()).param("expires",SqlTime.of(expires)).param("state",state).update();
				int unavailable=0,queued=0;
				if(state.equals("queued")) {
					for(var person:snapshot.people()) {
						if(person.chat()==null || person.chat()<=0 || !personValid(meeting.id(),person)) { unavailable++;continue; }
						String text=person.kind().equals("removed")?"Вы больше не приглашены на встречу.\n\n"+snapshot.previousTitle():text(source.action(),snapshot);
						enqueue(source,meeting,person.id(),person.chat(),null,bot,person.kind(),"user:"+person.id(),text,expires);queued++;
					}
					for(var group:snapshot.groups()) {
						boolean allowed=group.bot().equals(bot) && jdbc.sql("select count(*) from chat_bindings where bot_id=:bot and chat_id=:chat and type='important' and important_thread_id=:thread")
								.param("bot",bot).param("chat",group.chat()).param("thread",group.thread()).query(Long.class).single()>0;
						if(!allowed) { unavailable++;continue; }
						enqueue(source,meeting,null,group.chat(),group.thread(),bot,"group","group:"+bot+":"+group.chat()+":"+group.thread(),text(source.action(),snapshot),expires);queued++;
					}
				}
				if(state.equals("queued") && queued==0)state="unavailable";
				jdbc.sql("update meeting_notification_events set state=:state,unavailable_count=:count where id=:id").param("id",source.id()).param("state",state).param("count",unavailable).update();
				finish(source.id(),"completed",null);
			}
		}return count;
	}
	private boolean personValid(String meeting,Person person) {
		return jdbc.sql("""
				select count(*) from users u where u.id=:id and u.active and u.registered and u.role in ('admin','organizer') and u.telegram_id=:chat
				and ((:kind='invited' and exists(select 1 from meeting_invitations i where i.meeting_id=:meeting and i.user_id=u.id))
				or (:kind='removed' and not exists(select 1 from meeting_invitations i where i.meeting_id=:meeting and i.user_id=u.id)))
				""").param("id",person.id()).param("chat",person.chat()).param("kind",person.kind()).param("meeting",meeting).query(Long.class).single()>0;
	}
	private void enqueue(Source source,Meeting meeting,String recipient,long chat,Long thread,String bot,String kind,String key,String text,Instant expires) {
		var target="meeting_target_"+UUID.randomUUID();
		jdbc.sql("insert into meeting_notification_targets(id,event_id,target_key,recipient_id,chat_id,message_thread_id,bot_id,kind) values (:id,:event,:key,:recipient,:chat,:thread,:bot,:kind)")
				.param("id",target).param("event",source.id()).param("key",key).param("recipient",recipient).param("chat",chat).param("thread",thread).param("bot",kind.equals("group")?bot:null).param("kind",kind).update();
		var payload=json.createObjectNode().put("text",text).put("meetingId",meeting.id());
		if(kind.equals("invited") && !source.action().equals("cancelled")) {
			payload.put("botId",bot).put("meetingVersion",meeting.version());
			payload.set("replyMarkup",json.valueToTree(TelegramMeetingRsvp.keyboard(target).markup()));
		}
		var delivery=queue.enqueue(new DeliveryQueue.NewDelivery(source.id(),"meeting:"+source.id()+":"+key,"meeting_event",recipient,chat,thread,
				json.writeValueAsString(payload),false,source.due(),source.due(),expires));
		jdbc.sql("update notification_deliveries set meeting_target_id=:target where id=:id").param("target",target).param("id",delivery).update();
	}
	private void finish(String id,String status,String code) {
		jdbc.sql("update outbox_events set status=:status,last_error_code=:code,attempts=attempts+1,lease_token=null,leased_until=null,updated_at=clock_timestamp() where id=:id")
				.param("id",id).param("status",status).param("code",code).update();
	}
	private Snapshot parse(Source source,String meetingId) {
		var root=json.readTree(source.payload());var m=root.path("meeting");var version=m.path("version");
		String origin=source.action().equals("reminder")?string(root.path("originAction"),20):source.action();
		if(source.action().equals("reminder") && !Set.of("created","updated").contains(origin))throw new IllegalArgumentException();
		if(!root.path("action").asText().equals(source.action()) || !m.path("id").asText().equals(meetingId) || !version.isIntegralNumber() || !version.canConvertToLong() || version.asLong()<0)throw new IllegalArgumentException();
		String actor=string(root.path("actorId"),200),title=string(m.path("title"),160),previousTitle=string(root.path("previousTitle"),160);Instant starts=Instant.parse(string(m.path("startsAt"),100));
		var previous=ids(root.path("previousAudienceUserIds"));var next=ids(root.path("audienceUserIds"));var people=new ArrayList<Person>();var seen=new HashSet<String>();
		var recipients=root.path("recipientSnapshot");if(!recipients.isArray() || recipients.size()>5000)throw new IllegalArgumentException();
		for(var p:recipients) {
			String id=string(p.path("userId"),200),kind=string(p.path("kind"),20);var chat=p.path("telegramId");
			if(!seen.add(id) || !(chat.isNull() || chat.isIntegralNumber() && chat.canConvertToLong()) || !(kind.equals("invited") && next.contains(id) || kind.equals("removed") && source.action().equals("updated") && previous.contains(id) && !next.contains(id)))throw new IllegalArgumentException();
			people.add(new Person(id,chat.isNull()?null:chat.asLong(),kind));
		}
		var groups=new ArrayList<Group>();var groupKeys=new HashSet<String>();var targets=root.path("groupTargets");if(!targets.isArray() || targets.size()>500)throw new IllegalArgumentException();
		for(var g:targets) {
			String bot=string(g.path("botId"),100);var chat=g.path("chatId");var thread=g.path("messageThreadId");
			if(!chat.isIntegralNumber() || !chat.canConvertToLong() || chat.asLong()>=0 || !thread.isIntegralNumber() || !thread.canConvertToLong() || thread.asLong()<1 || !groupKeys.add(bot+":"+chat.asLong()+":"+thread.asLong()))throw new IllegalArgumentException();
			groups.add(new Group(bot,chat.asLong(),thread.asLong()));
		}return new Snapshot(actor,version.asLong(),title,previousTitle,starts,people,groups,origin);
	}
	private Set<String> ids(JsonNode node) {
		if(!node.isArray() || node.size()>5000)throw new IllegalArgumentException();var result=new HashSet<String>();
		for(var id:node)if(!result.add(string(id,200)))throw new IllegalArgumentException();return result;
	}
	private String string(JsonNode node,int max) { if(!node.isString() || node.asText().isBlank() || node.asText().length()>max)throw new IllegalArgumentException();return node.asText(); }
	private String text(String action,Snapshot snapshot) {
		String heading=switch(action) { case "created"->"Новая встреча";case "updated"->"Встреча изменена";case "reminder"->"Напоминание о встрече";default->"Встреча отменена"; };
		return heading+"\n\n"+snapshot.title()+"\n"+DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm").withZone(ZoneId.of("Europe/Moscow")).format(snapshot.starts())+" МСК";
	}
	private record Meeting(String id,long version,String status,Instant ends,String host,Instant starts) {}
	private record Source(String id,String action,String payload,Instant due) {}
	private record Person(String id,Long chat,String kind) {}
	private record Group(String bot,long chat,long thread) {}
	private record Snapshot(String actor,long version,String title,String previousTitle,Instant starts,List<Person> people,List<Group> groups,String originAction) {}
}
