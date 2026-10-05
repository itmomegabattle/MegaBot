package ru.itmomegabattle.megabot.tasks;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Lock order: maintenance shared -> task -> reminder -> delivery. */
@Service
public class TaskDeliveryGate {
	private final JdbcClient jdbc;
	public TaskDeliveryGate(JdbcClient jdbc) { this.jdbc=jdbc; }
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean eligible(String delivery,String token) {
		var target=jdbc.sql("""
				select o.task_id,o.reminder_id,o.task_version,o.reminder_version from notification_deliveries d
				join task_reminder_occurrences o on o.id=d.task_occurrence_id where d.id=:id and d.lease_token=:token
				and d.status='claimed' and d.leased_until>clock_timestamp()
				""").param("id",delivery).param("token",token).query((r,i)->new Target(r.getString(1),r.getString(2),r.getLong(3),r.getLong(4))).optional();
		if(target.isEmpty())return manualEligible(delivery,token);var t=target.get();lock(t.task(),t.reminder());
		return jdbc.sql("""
				select count(*) from tasks t join task_reminders r on r.task_id=t.id join notification_deliveries d on d.id=:delivery
				join users u on u.id=d.recipient_id join task_assignees a on a.task_id=t.id and a.user_id=u.id
				where t.id=:task and r.id=:reminder and t.version=:taskVersion and r.version=:reminderVersion
				and t.removed_at is null and t.status not in ('completed','cancelled') and r.active and r.enabled
				and u.active and u.registered and d.chat_id>0 and u.telegram_id=d.chat_id and
				((t.faculty_id is null and not t.faculty_all and u.role in ('admin','organizer')) or
				((t.faculty_id is not null or t.faculty_all) and u.role in ('faculty_responsible','faculty_helper') and exists
				(select 1 from faculty_memberships m join faculties f on f.id=m.faculty_id and f.active
				 where m.user_id=u.id and (t.faculty_all or m.faculty_id=t.faculty_id))))
				""").param("delivery",delivery).param("task",t.task()).param("reminder",t.reminder()).param("taskVersion",t.taskVersion()).param("reminderVersion",t.reminderVersion()).query(Long.class).single()>0;
	}
	private boolean manualEligible(String delivery,String token) {
		var target=jdbc.sql("select m.task_id,m.task_version,m.actor_id,d.recipient_id,d.chat_id,(m.state='queued' and e.status='completed' and m.expires_at>clock_timestamp() and e.event_type='task.'||m.action and (d.category=case m.action when 'created' then 'task_created' when 'updated' then 'task_updated' when 'status' then 'task_status' when 'comment' then 'task_comment' when 'cancel' then 'task_cancel' when 'claim' then 'task_assignment' when 'release' then 'task_assignment' else 'task_manual' end or (m.action='updated' and d.category='task_unassigned' and jsonb_exists(e.payload->'removedAssigneeIds',d.recipient_id)))) as valid,m.action,m.task_status,d.category='task_unassigned',(select p->>'kind' from jsonb_array_elements(e.payload->'recipientSnapshot') p where p->>'userId'=d.recipient_id limit 1) from notification_deliveries d join task_manual_intents m on m.id=d.task_manual_id join outbox_events e on e.id=m.id where d.id=:id and d.lease_token=:token and d.status='claimed' and d.leased_until>clock_timestamp()")
				.param("id",delivery).param("token",token).query((r,i)->new Manual(r.getString(1),r.getLong(2),r.getString(3),r.getString(4),r.getLong(5),r.getBoolean(6),r.getString(7),r.getString(8),r.getBoolean(9),r.getString(10))).optional();
		if(target.isEmpty())return true;var t=target.get();TaskMaintenanceGate.shared(jdbc);
		jdbc.sql("select id from tasks where id=:id for update").param("id",t.task()).query(String.class).single();
		if("status".equals(t.action()))return t.valid() && !t.actor().equals(t.recipient()) && statusTaskValid(t.task(),t.version(),t.actor(),t.status()) && statusRecipientValid(t.task(),t.recipient(),t.chat());
		if(java.util.List.of("comment","cancel").contains(t.action()))return t.valid() && !t.actor().equals(t.recipient()) && mutationTaskValid(t.task(),t.version(),t.actor(),t.status(),t.action()) && mutationRecipientValid(t.task(),t.version(),t.actor(),t.recipient(),t.chat(),t.action());
		if(java.util.List.of("claim","release").contains(t.action()))return t.valid() && !t.actor().equals(t.recipient()) && assignmentTaskValid(t.task(),t.version(),t.actor(),t.status(),t.action()) && assignmentRecipientValid(t.task(),t.recipient(),t.chat(),t.action(),t.kind());
		if(t.removed())return t.valid() && !t.actor().equals(t.recipient()) && manualTaskValid(t.task(),t.version(),t.actor()) && creationTaskActive(t.task()) && removedRecipientValid(t.task(),t.recipient(),t.chat());
		return t.valid() && manualTaskValid(t.task(),t.version(),t.actor()) && (java.util.List.of("created","updated").contains(t.action())
				? creationTaskActive(t.task()) && !t.actor().equals(t.recipient()) && creationRecipientValid(t.task(),t.recipient(),t.chat())
				: recipientValid(t.task(),t.recipient(),t.chat()));
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean mutationTaskValid(String task,long version,String actor,String status,String action) {
		if("cancel".equals(action))return jdbc.sql("select count(*) from tasks t join users u on u.id=:actor where t.id=:task and t.version=:version and t.removed_at is null and t.status='cancelled' and t.cancelled_by=u.id and u.active and u.registered and (u.role='admin' or (u.role='organizer' and t.creator_id=u.id))")
				.param("task",task).param("version",version).param("actor",actor).query(Long.class).single()>0 && "cancelled".equals(status);
		if(!"comment".equals(action) || !creationTaskActive(task))return false;
		var side=jdbc.sql("select c.side from task_comments c join tasks t on t.id=c.task_id where c.task_id=:task and c.task_version=:version and c.author_id=:actor and c.kind='discussion' and t.status=:status").param("task",task).param("version",version).param("actor",actor).param("status",status).query(String.class).optional();
		return side.map(s->"coordinator".equals(s)?manualTaskValid(task,version,actor):"executor".equals(s) && statusTaskValid(task,version,actor,status)).orElse(false);
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean mutationRecipientValid(String task,long version,String actor,String recipient,long chat,String action) {
		if("cancel".equals(action))return recipientValid(task,recipient,chat) || statusRecipientValid(task,recipient,chat);
		if(!"comment".equals(action))return false;
		return jdbc.sql("select side,target_assignee_id from task_comments where task_id=:task and task_version=:version and author_id=:actor and kind='discussion'").param("task",task).param("version",version).param("actor",actor)
				.query((r,i)->"executor".equals(r.getString(1))?statusRecipientValid(task,recipient,chat):"coordinator".equals(r.getString(1)) && (r.getString(2)==null || recipient.equals(r.getString(2))) && recipientValid(task,recipient,chat)).optional().orElse(false);
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean assignmentRecipientValid(String task,String recipient,long chat,String action,String kind) {
		if("coordinator".equals(kind))return statusRecipientValid(task,recipient,chat);
		if("release".equals(action) && "open".equals(kind))return creationRecipientValid(task,recipient,chat);
		return "claim".equals(action) && "admin".equals(kind) && jdbc.sql("select count(*) from users where id=:id and active and registered and role='admin' and :chat>0 and telegram_id=:chat")
				.param("id",recipient).param("chat",chat).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean assignmentTaskValid(String task,long version,String actor,String status,String action) {
		if(!java.util.List.of("claim","release").contains(action))return false;
		return jdbc.sql("""
				select count(*) from tasks t join users u on u.id=:actor where t.id=:task and t.version=:version and t.status=:status
				and t.status in ('open','assigned','waiting','in_progress') and t.removed_at is null and u.active and u.registered
				and (t.status<>'open' or not exists(select 1 from task_assignees a where a.task_id=t.id))
				and exists(select 1 from task_assignees a where a.task_id=t.id and a.user_id=u.id)=(:action='claim')
				and ((t.faculty_id is null and not t.faculty_all and u.role in ('admin','organizer')) or
				(:action='release' and (t.faculty_id is not null or t.faculty_all) and u.role in ('faculty_responsible','faculty_helper') and exists
				(select 1 from faculty_memberships m join faculties f on f.id=m.faculty_id and f.active where m.user_id=u.id and (t.faculty_all or m.faculty_id=t.faculty_id))))
				and (:action='release' or (t.status='assigned' and (not exists(select 1 from task_competencies c where c.task_id=t.id) or exists
				(select 1 from task_competencies c join user_competencies uc on uc.competency_id=c.competency_id where c.task_id=t.id and uc.user_id=u.id))))
				""").param("task",task).param("version",version).param("actor",actor).param("status",status).param("action",action).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean removedRecipientValid(String task,String recipient,long chat) {
		return jdbc.sql("select count(*) from users u where u.id=:recipient and u.active and u.registered and :chat>0 and u.telegram_id=:chat and not exists(select 1 from task_assignees a where a.task_id=:task and a.user_id=u.id)")
				.param("task",task).param("recipient",recipient).param("chat",chat).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean statusTaskValid(String task,long version,String actor,String status) {
		return jdbc.sql("""
				select count(*) from tasks t join users u on u.id=:actor
				where t.id=:task and t.version=:version and t.status=:status and t.status<>'cancelled' and t.removed_at is null
				and (:status<>'completed' or t.completed_by=u.id)
				and u.active and u.registered and (u.role='admin' or (exists(select 1 from task_assignees a where a.task_id=t.id and a.user_id=u.id)
				and ((t.faculty_id is null and not t.faculty_all and u.role='organizer') or
				((t.faculty_id is not null or t.faculty_all) and u.role in ('faculty_responsible','faculty_helper') and exists
				(select 1 from faculty_memberships m join faculties f on f.id=m.faculty_id and f.active where m.user_id=u.id and (t.faculty_all or m.faculty_id=t.faculty_id))))))
				""").param("task",task).param("version",version).param("actor",actor).param("status",status).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean statusRecipientValid(String task,String recipient,long chat) {
		return jdbc.sql("select count(*) from tasks t join users u on u.id=t.creator_id where t.id=:task and u.id=:recipient and u.active and u.registered and u.role in ('admin','organizer') and :chat>0 and u.telegram_id=:chat")
				.param("task",task).param("recipient",recipient).param("chat",chat).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean creationTaskActive(String task) {
		return jdbc.sql("select count(*) from tasks where id=:task and removed_at is null and status in ('open','assigned','waiting','in_progress')")
				.param("task",task).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean creationRecipientValid(String task,String recipient,long chat) {
		if(recipientValid(task,recipient,chat))return true;
		return jdbc.sql("""
				select count(*) from tasks t join users u on u.id=:recipient
				where t.id=:task and t.status='open' and t.faculty_id is null and not t.faculty_all
				and not exists(select 1 from task_assignees a where a.task_id=t.id)
				and u.active and u.registered and u.role in ('admin','organizer') and :chat>0 and u.telegram_id=:chat
				and (not exists(select 1 from task_competencies c where c.task_id=t.id) or exists
				(select 1 from task_competencies c join user_competencies uc on uc.competency_id=c.competency_id where c.task_id=t.id and uc.user_id=u.id))
				""").param("task",task).param("recipient",recipient).param("chat",chat).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean manualTaskValid(String task,long version,String actor) {
		return jdbc.sql("select count(*) from tasks t join users u on u.id=:actor where t.id=:task and t.version=:version and t.removed_at is null and t.status<>'cancelled' and u.active and u.registered and (u.role='admin' or (u.role='organizer' and t.creator_id=u.id))")
				.param("task",task).param("version",version).param("actor",actor).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public boolean recipientValid(String task,String recipient,long chat) {
		return jdbc.sql("""
				select count(*) from tasks t join task_assignees a on a.task_id=t.id join users u on u.id=a.user_id
				where t.id=:task and u.id=:recipient and u.active and u.registered and :chat>0 and u.telegram_id=:chat and
				((t.faculty_id is null and not t.faculty_all and u.role in ('admin','organizer')) or
				((t.faculty_id is not null or t.faculty_all) and u.role in ('faculty_responsible','faculty_helper') and exists
				(select 1 from faculty_memberships m join faculties f on f.id=m.faculty_id and f.active where m.user_id=u.id and (t.faculty_all or m.faculty_id=t.faculty_id))))
				""").param("task",task).param("recipient",recipient).param("chat",chat).query(Long.class).single()>0;
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public void lockForResult(String delivery) {
		jdbc.sql("select o.task_id,o.reminder_id from notification_deliveries d join task_reminder_occurrences o on o.id=d.task_occurrence_id where d.id=:id")
				.param("id",delivery).query((r,i)->new Target(r.getString(1),r.getString(2),0,0)).optional().ifPresent(t->lock(t.task(),t.reminder()));
	}
	@Transactional(propagation=Propagation.MANDATORY)
	public void confirmed(String delivery) {
		jdbc.sql("""
				update task_reminders r set last_sent_at=clock_timestamp(),sent_at=case when r.type='before_deadline' then coalesce(r.sent_at,clock_timestamp()) else r.sent_at end
				from notification_deliveries d join task_reminder_occurrences o on o.id=d.task_occurrence_id
				where d.id=:id and d.status='sent' and r.id=o.reminder_id and r.version=o.reminder_version
				""").param("id",delivery).update();
	}
	private void lock(String task,String reminder) {
		TaskMaintenanceGate.shared(jdbc);jdbc.sql("select id from tasks where id=:id for update").param("id",task).query(String.class).single();
		jdbc.sql("select id from task_reminders where id=:id for update").param("id",reminder).query(String.class).single();
	}
	private record Target(String task,String reminder,long taskVersion,long reminderVersion) {}
	private record Manual(String task,long version,String actor,String recipient,long chat,boolean valid,String action,String status,boolean removed,String kind) {}
}
