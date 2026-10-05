package ru.itmomegabattle.megabot.tasks;

import ru.itmomegabattle.megabot.common.SqlTime;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Component
class TaskReminderService {
	private final JdbcClient jdbc;
	private final Clock clock;

	TaskReminderService(JdbcClient jdbc, Clock clock) { this.jdbc = jdbc; this.clock = clock; }

	@Transactional(propagation = Propagation.MANDATORY)
	void configure(String taskId, Instant deadline, Instant createdAt, List<TaskController.ReminderInput> requested) {
		var existing = rows(taskId);
		if (requested != null && requested.size() > 3) throw TaskRules.bad("too_many_reminders", "Допускается до трёх напоминаний");
		var input = requested == null ? existing.stream().filter(ReminderRow::enabled)
				.map(row -> new TaskController.ReminderInput(row.id(), row.type(), row.value(), row.unit())).toList() : requested;
		var retained = new HashSet<String>();
		var signatures = new HashSet<String>();
		for (var item : input) {
			var interval = TaskReminderRules.interval(item.type(), item.value(), item.unit());
			if (!signatures.add(item.type() + ":" + item.value() + ":" + item.unit()))
				throw TaskRules.bad("duplicate_task_reminder", "Одинаковые напоминания не должны дублироваться");
			ReminderRow previous;
			if (item.id() == null || item.id().isBlank()) {
				previous = existing.stream().filter(row -> row.enabled() && !retained.contains(row.id())
						&& row.type().equals(item.type()) && row.value() == item.value() && row.unit().equals(item.unit())).findFirst().orElse(null);
			} else {
				previous = existing.stream().filter(row -> row.id().equals(item.id()) && row.enabled()).findFirst()
						.orElseThrow(() -> TaskRules.bad("reminder_not_found", "Напоминание не принадлежит этой задаче или удалено"));
			}
			var id = previous == null ? "rem_" + UUID.randomUUID() : previous.id();
			if (!retained.add(id)) throw TaskRules.bad("duplicate_task_reminder", "ID напоминания повторяется");
			var anchor = "before_deadline".equals(item.type()) ? deadline
					: previous != null && "repeat".equals(previous.type()) ? previous.anchorAt()
					: existing.isEmpty() ? createdAt : clock.instant();
			if (anchor == null && "repeat".equals(item.type())) anchor = createdAt;
			var due = TaskReminderRules.firstDue(item.type(), interval, anchor);
			if (previous == null) {
				jdbc.sql("""
						insert into task_reminders(id,task_id,type,value,unit,anchor_at,next_due_at,active,enabled)
						values (:id,:task,:type,:value,:unit,:anchor,:due,true,true)
						""").param("id",id).param("task",taskId).param("type",item.type()).param("value",item.value())
						.param("unit",item.unit()).param("anchor",SqlTime.of(anchor)).param("due",SqlTime.of(due)).update();
			} else if (!previous.type().equals(item.type()) || previous.value() != item.value()
					|| !previous.unit().equals(item.unit()) || !Objects.equals(previous.anchorAt(),anchor)) {
				jdbc.sql("""
						update task_reminders set type=:type,value=:value,unit=:unit,anchor_at=:anchor,next_due_at=:due,
						sent_at=null,last_sent_at=null,active=true,version=version+1 where id=:id
						""").param("id",id).param("type",item.type()).param("value",item.value()).param("unit",item.unit())
						.param("anchor",SqlTime.of(anchor)).param("due",SqlTime.of(due)).update();
			}
		}
		for (var previous : existing) if (previous.enabled() && !retained.contains(previous.id())) {
			jdbc.sql("update task_reminders set enabled=false,active=false,next_due_at=null,version=version+1 where id=:id")
					.param("id",previous.id()).update();
		}
		rearmUnstarted(taskId);
	}

	@Transactional(propagation = Propagation.MANDATORY)
	void lifecycle(String taskId, String status) {
		if (!TaskReminderRules.schedulable(status)) {
			jdbc.sql("update task_reminders set active=false,next_due_at=null,version=version+1 where task_id=:id and active")
					.param("id",taskId).update();
			return;
		}
		for (var row : rows(taskId)) {
			if (!row.enabled() || row.active() || row.anchorAt()==null || ("before_deadline".equals(row.type()) && row.sentAt()!=null)) continue;
			var interval=TaskReminderRules.interval(row.type(),row.value(),row.unit());
			var due="repeat".equals(row.type()) ? TaskReminderRules.nextRepeat(row.anchorAt(),interval,clock.instant())
					: TaskReminderRules.firstDue(row.type(),interval,row.anchorAt());
			jdbc.sql("update task_reminders set active=true,next_due_at=:due,version=version+1 where id=:id")
					.param("id",row.id()).param("due",SqlTime.of(due)).update();
		}
		rearmUnstarted(taskId);
	}
	private void rearmUnstarted(String taskId) {
		// A legitimate task edit can replace a definitely-not-started snapshot, never an ambiguous/sent attempt.
		jdbc.sql("""
				update task_reminders r set next_due_at=o.intended_at,version=r.version+1
				from task_reminder_occurrences o join tasks t on t.id=o.task_id
				where r.task_id=:task and r.id=o.reminder_id and r.version=o.reminder_version and r.active and r.enabled
				and o.task_version<>t.version and o.state in ('queued','unavailable') and o.expires_at>clock_timestamp()
				and (r.type='repeat' or r.sent_at is null) and not exists
				(select 1 from notification_deliveries d where d.task_occurrence_id=o.id and (d.attempts>0 or d.status='unknown'))
				""").param("task",taskId).update();
	}

	List<Map<String,Object>> views(String taskId) {
		var result=new ArrayList<Map<String,Object>>();
		for (var row:rows(taskId)) if(row.enabled()) {
			var view=new LinkedHashMap<String,Object>(); view.put("id",row.id()); view.put("type",row.type());
			view.put("value",row.value()); view.put("unit",row.unit()); view.put("anchorAt",row.anchorAt());
			view.put("nextDueAt",row.nextDueAt()); view.put("active",row.active()); view.put("version",row.version());
			if(row.sentAt()!=null) view.put("sentAt",row.sentAt());
			if(row.lastSentAt()!=null) view.put("lastSentAt",row.lastSentAt());
			result.add(view);
		}
		return result;
	}

	private List<ReminderRow> rows(String taskId) {
		return jdbc.sql("select * from task_reminders where task_id=:id order by id").param("id",taskId)
				.query((row,index)->new ReminderRow(row.getString("id"),row.getString("type"),row.getInt("value"),row.getString("unit"),
						instant(row,"anchor_at"),instant(row,"next_due_at"),instant(row,"sent_at"),instant(row,"last_sent_at"),
						row.getBoolean("active"),row.getBoolean("enabled"),row.getLong("version"))).list();
	}
	private Instant instant(java.sql.ResultSet row,String field) throws java.sql.SQLException {
		var value=row.getTimestamp(field); return value==null?null:value.toInstant();
	}
	private record ReminderRow(String id,String type,int value,String unit,Instant anchorAt,Instant nextDueAt,
			Instant sentAt,Instant lastSentAt,boolean active,boolean enabled,long version) {}
}
