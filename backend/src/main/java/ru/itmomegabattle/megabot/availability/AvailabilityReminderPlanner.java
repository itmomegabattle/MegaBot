package ru.itmomegabattle.megabot.availability;

import java.time.*;
import java.time.temporal.TemporalAdjusters;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.SqlTime;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;
import tools.jackson.databind.ObjectMapper;

/** One immutable audience per Sunday; PostgreSQL owns time, deduplication and queue state. */
@Service
public class AvailabilityReminderPlanner {
	private final JdbcClient jdbc;
	private final AvailabilitySubmissionService availability;
	private final DeliveryQueue queue;
	private final ObjectMapper json;
	public AvailabilityReminderPlanner(JdbcClient jdbc,AvailabilitySubmissionService availability,DeliveryQueue queue,ObjectMapper json) {
		this.jdbc=jdbc;this.availability=availability;this.queue=queue;this.json=json;
	}
	@Transactional
	public int materialize() {
		var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
		var sunday=now.atZone(ZoneId.of("Europe/Moscow")).toLocalDate().with(TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY));
		var due=sunday.atTime(18,0).atZone(ZoneId.of("Europe/Moscow")).toInstant();
		if(now.isBefore(due))return 0;
		var week=sunday.plusDays(1);var expiry=due.plusSeconds(10800);
		var state=expiry.isAfter(now)?"queued":"expired";
		int inserted=jdbc.sql("""
				insert into availability_reminder_occurrences(week_start,intended_at,expires_at,state)
				values (:week,:due,:expiry,:state) on conflict (week_start) do nothing
				""").param("week",week).param("due",SqlTime.of(due)).param("expiry",SqlTime.of(expiry)).param("state",state).update();
		if(inserted==0 || state.equals("expired"))return inserted;
		// ponytail: one weekly audience transaction; split snapshot/materialization if team size makes it too costly.
		var people=jdbc.sql("select id,telegram_id from users where active and registered and role in ('admin','organizer') order by id")
				.query((r,i)->new Person(r.getString(1),(Long)r.getObject(2))).list();
		int unavailable=0,queued=0;
		for(var person:people) {
			if(availability.submitted(person.id(),week))continue;
			var target="availability_target_"+UUID.randomUUID();
			boolean sendable=person.chat()!=null && person.chat()>0;
			jdbc.sql("insert into availability_reminder_targets(id,week_start,recipient_id,chat_id,state) values (:id,:week,:user,:chat,:state)")
					.param("id",target).param("week",week).param("user",person.id()).param("chat",sendable?person.chat():null).param("state",sendable?"queued":"unavailable").update();
			if(!sendable) { unavailable++;continue; }
			var payload=json.writeValueAsString(Map.of("text","🔔 Сегодня воскресенье. Отметь, пожалуйста, свободные слоты на следующую неделю в Mini App. Это займёт меньше минуты.","weekStart",week.toString()));
			var delivery=queue.enqueue(new DeliveryQueue.NewDelivery("sunday_slots:"+week,"sunday_slots:"+week+":"+person.id(),"availability_reminder",person.id(),person.chat(),null,payload,false,due,due,expiry));
			jdbc.sql("update notification_deliveries set availability_reminder_target_id=:target where id=:id").param("target",target).param("id",delivery).update();queued++;
		}
		jdbc.sql("update availability_reminder_occurrences set state=:state,unavailable_count=:unavailable where week_start=:week")
				.param("state",queued==0?"unavailable":"queued").param("unavailable",unavailable).param("week",week).update();
		return inserted;
	}
	private record Person(String id,Long chat) {}
}
