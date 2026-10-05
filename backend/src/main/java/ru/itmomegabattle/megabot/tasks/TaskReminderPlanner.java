package ru.itmomegabattle.megabot.tasks;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.SqlTime;
import ru.itmomegabattle.megabot.notifications.DeliveryQueue;
import tools.jackson.databind.ObjectMapper;

@Service
public class TaskReminderPlanner {
	private final JdbcClient jdbc;private final DeliveryQueue queue;private final ObjectMapper json;
	public TaskReminderPlanner(JdbcClient jdbc,DeliveryQueue queue,ObjectMapper json) { this.jdbc=jdbc;this.queue=queue;this.json=json; }
	@Transactional
	public int materialize(int limit) {
		if(limit<1 || limit>100)throw new IllegalArgumentException("invalid_reminder_batch");
		TaskMaintenanceGate.shared(jdbc);
		var tasks=jdbc.sql("""
				select t.id from tasks t where t.removed_at is null and t.status not in ('completed','cancelled') and exists
				(select 1 from task_reminders r where r.task_id=t.id and r.active and r.enabled and r.next_due_at<=clock_timestamp())
				order by t.id for update skip locked limit :limit
				""").param("limit",limit).query(String.class).list();int count=0;
		for(var task:tasks) {
			var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
			var rows=jdbc.sql("select r.*,t.version as task_version,t.title,t.due_at from task_reminders r join tasks t on t.id=r.task_id where r.task_id=:task and r.active and r.enabled and r.next_due_at<=:now order by r.id for update of r")
					.param("task",task).param("now",SqlTime.of(now)).query((r,i)->new Reminder(r.getString("id"),r.getString("type"),r.getInt("value"),r.getString("unit"),r.getLong("version"),r.getLong("task_version"),r.getString("title"),r.getTimestamp("anchor_at").toInstant(),r.getTimestamp("next_due_at").toInstant(),r.getTimestamp("due_at")==null?null:r.getTimestamp("due_at").toInstant())).list();
			for(var reminder:rows) {
				var interval=TaskReminderRules.interval(reminder.type(),reminder.value(),reminder.unit());
				var next="repeat".equals(reminder.type())?TaskReminderRules.nextRepeat(reminder.anchor(),interval,now):null;
				var due=next==null?reminder.due():next.minus(interval);var expiry=due.plus(Duration.ofMinutes(15));
				if("before_deadline".equals(reminder.type()) && reminder.deadline()!=null && expiry.isAfter(reminder.deadline()))expiry=reminder.deadline();
				if(expiry.isBefore(due))expiry=due;
				var occurrence="occ_"+UUID.randomUUID();var state=expiry.isAfter(now)?"queued":"expired";
				var inserted=jdbc.sql("insert into task_reminder_occurrences(id,reminder_id,reminder_version,task_id,task_version,intended_at,expires_at,state) values (:id,:reminder,:rv,:task,:tv,:due,:expiry,:state) on conflict (reminder_id,reminder_version,intended_at) do nothing")
						.param("id",occurrence).param("reminder",reminder.id()).param("rv",reminder.version()).param("task",task).param("tv",reminder.taskVersion()).param("due",SqlTime.of(due)).param("expiry",SqlTime.of(expiry)).param("state",state).update();
				if(inserted>0) {
					count++;cancelOlder(reminder.id());
					if("queued".equals(state)) {
						var recipients=jdbc.sql("select u.id,u.telegram_id from task_assignees a join users u on u.id=a.user_id where a.task_id=:task and u.active and u.registered order by u.id")
								.param("task",task).query((r,i)->new Recipient(r.getString(1),(Long)r.getObject(2))).list();int unavailable=0,queued=0;
						for(var person:recipients) {
							if(person.chat()==null || person.chat()<=0) { unavailable++;continue; }
							var payload=json.writeValueAsString(Map.of("text","Напоминание о задаче\n\n"+reminder.title(),"taskId",task,"occurrenceId",occurrence));
							var delivery=queue.enqueue(new DeliveryQueue.NewDelivery(occurrence,"occurrence:"+occurrence+":"+person.id(),"task_reminder",person.id(),person.chat(),null,payload,true,due,due,expiry));
							jdbc.sql("update notification_deliveries set task_occurrence_id=:occurrence where id=:id").param("id",delivery).param("occurrence",occurrence).update();queued++;
						}
						jdbc.sql("update task_reminder_occurrences set unavailable_count=:unavailable,state=:state where id=:id").param("id",occurrence).param("unavailable",unavailable).param("state",queued==0?"unavailable":"queued").update();
					}
				}
				jdbc.sql("update task_reminders set next_due_at=:next where id=:id").param("id",reminder.id()).param("next",SqlTime.of(next)).update();
			}
		}return count;
	}
	private void cancelOlder(String reminder) {
		for(var id:jdbc.sql("select d.id from notification_deliveries d join task_reminder_occurrences o on o.id=d.task_occurrence_id where o.reminder_id=:id and d.status in ('planned','retry','claimed','sending') order by d.id")
				.param("id",reminder).query(String.class).list())queue.cancel(id);
	}
	private record Reminder(String id,String type,int value,String unit,long version,long taskVersion,String title,Instant anchor,Instant due,Instant deadline) {}
	private record Recipient(String id,Long chat) {}
}
