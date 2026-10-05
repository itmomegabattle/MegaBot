package ru.itmomegabattle.megabot.notifications;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.SqlTime;
import ru.itmomegabattle.megabot.availability.AvailabilitySubmissionService;

/** Persisted delivery lifecycle. HTTP must run outside these short transactions. */
@Service
public class DeliveryQueue {
	private final JdbcClient jdbc;
	private final AvailabilitySubmissionService availability;
	private final ru.itmomegabattle.megabot.tasks.TaskDeliveryGate taskGate;
	private final BroadcastGroupTargets groups;
	public DeliveryQueue(JdbcClient jdbc,AvailabilitySubmissionService availability,ru.itmomegabattle.megabot.tasks.TaskDeliveryGate taskGate,BroadcastGroupTargets groups) { this.jdbc=jdbc;this.availability=availability;this.taskGate=taskGate;this.groups=groups; }

	@Transactional(propagation=Propagation.MANDATORY)
	public String enqueue(NewDelivery r) {
		if(r==null || blank(r.operationId()) || blank(r.dedupeKey()) || blank(r.category()) || r.chatId()==0
				|| blank(r.payload()) || r.intendedAt()==null || r.availableAt()==null
				|| (r.expiresAt()!=null && r.expiresAt().isBefore(r.intendedAt()))) throw bad("invalid_delivery");
		var id="delivery_"+UUID.randomUUID();
		return jdbc.sql("""
				insert into notification_deliveries(id,operation_id,dedupe_key,category,recipient_id,chat_id,message_thread_id,
				payload,disable_notification,intended_at,available_at,initial_available_at,expires_at,status,command_reply_outbox_id)
				values (:id,:operation,:dedupe,:category,:recipient,:chat,:thread,cast(:payload as jsonb),:silent,:intended,:available,:available,:expires,'planned',
				case when :category='telegram_command_reply' then :operation else null end)
				on conflict (dedupe_key) do update set dedupe_key=excluded.dedupe_key
				where notification_deliveries.operation_id=excluded.operation_id and notification_deliveries.category=excluded.category
				and notification_deliveries.recipient_id is not distinct from excluded.recipient_id
				and notification_deliveries.chat_id=excluded.chat_id
				and notification_deliveries.message_thread_id is not distinct from excluded.message_thread_id
				and notification_deliveries.payload=excluded.payload and notification_deliveries.disable_notification=excluded.disable_notification
				and notification_deliveries.intended_at=excluded.intended_at and notification_deliveries.initial_available_at=excluded.initial_available_at
				and notification_deliveries.expires_at is not distinct from excluded.expires_at
				returning id
				""").param("id",id).param("operation",r.operationId()).param("dedupe",r.dedupeKey()).param("category",r.category())
				.param("recipient",r.recipientId()).param("chat",r.chatId()).param("thread",r.threadId()).param("payload",r.payload())
				.param("silent",r.silent()).param("intended",SqlTime.of(r.intendedAt())).param("available",SqlTime.of(r.availableAt()))
				.param("expires",SqlTime.of(r.expiresAt())).query(String.class).optional()
				.orElseThrow(()->new ApiException(HttpStatus.CONFLICT,"delivery_dedupe_conflict","Ключ доставки уже использован с другими данными"));
	}

	@Transactional
	public List<Lease> claim(int limit,Duration leaseDuration) {
		return claimRows(limit,leaseDuration,false);
	}
	/** Until other outbox/domain gates exist, the sender must leave non-broadcast rows untouched. */
	@Transactional
	public List<Lease> claimBroadcasts(int limit,Duration leaseDuration) {
		return claimRows(limit,leaseDuration,true);
	}
	@Transactional
	public List<Lease> claimBroadcasts(int limit,Duration leaseDuration,String bot) {
		if(bot==null || !bot.matches("[0-9]{1,20}"))throw bad("invalid_delivery_bot");
		return claimRows(limit,leaseDuration,true,false,bot);
	}
	private List<Lease> claimRows(int limit,Duration leaseDuration,boolean broadcastsOnly) {
		return claimRows(limit,leaseDuration,broadcastsOnly,false);
	}
	@Transactional
	public List<Lease> claimSupported(int limit,Duration leaseDuration) { return claimRows(limit,leaseDuration,true,true); }
	@Transactional
	public List<Lease> claimSupported(int limit,Duration leaseDuration,String bot) {
		if(bot==null || !bot.matches("[0-9]{1,20}"))throw bad("invalid_delivery_bot");
		return claimRows(limit,leaseDuration,true,true,bot);
	}
	private List<Lease> claimRows(int limit,Duration leaseDuration,boolean broadcastsOnly,boolean reminders) {
		return claimRows(limit,leaseDuration,broadcastsOnly,reminders,null);
	}
	private List<Lease> claimRows(int limit,Duration leaseDuration,boolean broadcastsOnly,boolean reminders,String bot) {
		if(limit<1 || limit>100) throw bad("invalid_delivery_batch");
		var seconds=leaseSeconds(leaseDuration);
		return jdbc.sql("""
				with picked as (
				 select id from notification_deliveries where status in ('planned','retry') and not cancel_requested and attempts<8
				 and (not :broadcastsOnly or (category='broadcast' and broadcast_target_id is not null)
				 or (category='broadcast_expired' and broadcast_expiry_notice_id is not null)
				 or (:reminders and ((category='task_reminder' and task_occurrence_id is not null) or (category in ('task_manual','task_created','task_status','task_updated','task_unassigned','task_assignment','task_comment','task_cancel') and task_manual_id is not null) or (category='meeting_event' and meeting_target_id is not null) or (category='availability_reminder' and availability_reminder_target_id is not null) or (category='birthday_reminder' and birthday_reminder_target_id is not null) or (category='telegram_command_reply' and command_reply_outbox_id is not null))))
				 and (category<>'telegram_command_reply' or exists(select 1 from outbox_events o join telegram_inbox i on i.id=o.aggregate_id where o.id=command_reply_outbox_id and i.bot_id=:bot))
				 and (category<>'meeting_event' or cast(:bot as text) is null or exists(select 1 from meeting_notification_targets mt where mt.id=meeting_target_id and (mt.bot_id is null or mt.bot_id=:bot)))
				 and (category<>'broadcast' or not exists(select 1 from broadcast_targets t where t.id=broadcast_target_id and t.bot_id is not null and (cast(:bot as text) is null or t.bot_id<>:bot)))
				 and intended_at<=clock_timestamp() and available_at<=clock_timestamp()
				 and (part_number=1 or broadcast_part_ready(broadcast_target_id,part_number))
				 and (expires_at is null or expires_at>clock_timestamp())
				 order by intended_at,case when category='meeting_event' and message_thread_id is not null then 0 else 1 end,available_at,id for update skip locked limit :limit
				)
				update notification_deliveries d set status='claimed',lease_token=:token||d.id,
				leased_until=clock_timestamp()+make_interval(secs=>:seconds),claimed_at=clock_timestamp(),
				request_started_at=null,response_at=null,version=version+1,updated_at=clock_timestamp()
				from picked where d.id=picked.id returning d.*
				""").param("limit",limit).param("broadcastsOnly",broadcastsOnly).param("reminders",reminders).param("bot",bot).param("token",UUID.randomUUID()+":").param("seconds",seconds).query((row,index)->
				new Lease(row.getString("id"),row.getString("lease_token"),row.getLong("chat_id"),(Long)row.getObject("message_thread_id"),
						row.getString("recipient_id"),row.getString("payload"),row.getBoolean("disable_notification"),
						row.getTimestamp("intended_at").toInstant(),row.getTimestamp("leased_until").toInstant(),row.getString("birthday_reminder_target_id"),row.getString("command_reply_outbox_id"))).list();
	}
	@Transactional
	public boolean deferBeforeStart(String id,String token,Instant availableAt) {
		if(availableAt==null)throw bad("invalid_delivery_delay");
		return jdbc.sql("""
				update notification_deliveries set status=case when expires_at<=greatest(:available,intended_at,clock_timestamp()) then 'expired' else 'planned' end,
				available_at=greatest(:available,intended_at,clock_timestamp()),lease_token=null,leased_until=null,version=version+1,updated_at=clock_timestamp()
				where id=:id and lease_token=:token and status='claimed' and leased_until>clock_timestamp() and not cancel_requested
				""").param("id",id).param("token",token).param("available",SqlTime.of(availableAt)).update()==1;
	}
	@Transactional(readOnly=true)
	public int attemptNumber(String id,String token) {
		return jdbc.sql("select attempts from notification_deliveries where id=:id and lease_token=:token and status='sending' and leased_until>clock_timestamp()")
				.param("id",id).param("token",token).query(Integer.class).optional().orElse(0);
	}

	/** Caller must verify domain version, audience and quota before this final ownership gate. */
	@Transactional
	public boolean start(String id,String token) {
		if(!commandReplyEligible(id,token,null)) {
			jdbc.sql("""
					update notification_deliveries set status='cancelled',cancel_requested=true,lease_token=null,leased_until=null,
					last_error_code='stale_command_reply',version=version+1,updated_at=clock_timestamp()
					where id=:id and lease_token=:token and status='claimed' and category='telegram_command_reply' and leased_until>clock_timestamp()
					""").param("id",id).param("token",token).update();
			return false;
		}
		if(!broadcastEligible(id,token))return false;
		if(!broadcastExpiryEligible(id,token)) { cancel(id);return false; }
		if(!taskGate.eligible(id,token)) { cancel(id);return false; }
		if(!meetingEligible(id,token)) { cancel(id);return false; }
		if(!availabilityEligible(id,token)) { cancel(id);return false; }
		if(!birthdayEligible(id,token)) { cancel(id);return false; }
		var attempt=jdbc.sql("""
				update notification_deliveries set status='sending',attempts=attempts+1,request_started_at=clock_timestamp(),
				updated_at=clock_timestamp(),version=version+1 where id=:id and lease_token=:token and status='claimed'
				and leased_until>clock_timestamp() and not cancel_requested and attempts<8
				and intended_at<=clock_timestamp() and available_at<=clock_timestamp()
				and (part_number=1 or broadcast_part_ready(broadcast_target_id,part_number))
				and (expires_at is null or expires_at>clock_timestamp()) returning attempts,request_started_at
				""").param("id",id).param("token",token).query((row,index)->
				new Started(row.getInt("attempts"),row.getTimestamp("request_started_at").toInstant())).optional();
		if(attempt.isEmpty()) return false;
		jdbc.sql("insert into delivery_attempts(id,delivery_id,attempt_number,started_at,result_status) values (:id,:delivery,:number,:started,'sending')")
				.param("id","attempt_"+UUID.randomUUID()).param("delivery",id).param("number",attempt.get().number())
				.param("started",SqlTime.of(attempt.get().at())).update();
		return true;
	}

	@Transactional
	public boolean heartbeat(String id,String token,Duration leaseDuration) {
		return jdbc.sql("""
				update notification_deliveries set leased_until=clock_timestamp()+make_interval(secs=>:seconds),updated_at=clock_timestamp()
				where id=:id and lease_token=:token and status in ('claimed','sending') and leased_until>clock_timestamp()
				""").param("id",id).param("token",token).param("seconds",leaseSeconds(leaseDuration)).update()==1;
	}

	@Transactional
	public boolean finish(String id,String token,Result result) {
		taskGate.lockForResult(id);
		if(result==null || ("sent".equals(result.status()) && (result.messageId()==null || result.messageId()<1))
				|| result.status()==null || !List.of("sent","retry","failed","unknown").contains(result.status())
				|| (!"sent".equals(result.status()) && result.messageId()!=null)
				|| (result.code()!=null && !result.code().matches("[A-Za-z0-9_.:-]{1,128}"))
				|| ("retry".equals(result.status()) && (result.retryDelay()==null || result.retryDelay().isNegative()
						|| result.retryDelay().compareTo(Duration.ofDays(365))>0))) throw bad("invalid_delivery_result");
		var seconds="retry".equals(result.status())?Math.max(1,result.retryDelay().toSeconds()+(result.retryDelay().getNano()>0?1:0)):0;
		var changed=jdbc.sql("""
				update notification_deliveries set
				status=case when :status='retry' and cancel_requested then 'cancelled'
				 when :status='retry' and attempts>=8 then 'failed'
				 when :status='retry' and expires_at<=clock_timestamp()+make_interval(secs=>:seconds) then 'expired'
				 else :status end,
				available_at=case when :status='retry' then greatest(intended_at,clock_timestamp()+make_interval(secs=>:seconds)) else available_at end,
				telegram_message_id=:message,sent_at=case when :status='sent' then statement_timestamp() else null end,
				response_at=statement_timestamp(),last_error_code=:code,lease_token=null,leased_until=null,version=version+1,updated_at=clock_timestamp()
				where id=:id and lease_token=:token and status='sending' and leased_until>clock_timestamp()
				returning status,attempts
				""").param("id",id).param("token",token).param("status",result.status()).param("seconds",seconds)
				.param("message",result.messageId()).param("code",result.code()).query((row,index)->new Finished(row.getString("status"),row.getInt("attempts"))).optional();
		if(changed.isEmpty()) return false;
		jdbc.sql("update delivery_attempts set finished_at=clock_timestamp(),result_status=:status,provider_code=:code,provider_message_id=:message where delivery_id=:id and attempt_number=:number and finished_at is null")
				.param("id",id).param("number",changed.get().attempt()).param("status",changed.get().status())
				.param("code",result.code()).param("message",result.messageId()).update();
		if("sent".equals(changed.get().status())) {
			taskGate.confirmed(id);
			jdbc.sql("""
					insert into bot_messages(id,user_id,sender,text,buttons,occurred_at)
					select 'reply:'||d.id,d.recipient_id,'bot',d.payload->>'text',d.payload->'replyMarkup',d.sent_at
					from notification_deliveries d where d.id=:id and d.category='telegram_command_reply' and d.recipient_id is not null
					on conflict(id) do nothing
					""").param("id",id).update();
		}
		return true;
	}

	@Transactional
	public boolean cancel(String id) {
		return jdbc.sql("""
				update notification_deliveries set cancel_requested=true,
				status=case when status='sending' then status else 'cancelled' end,
				lease_token=case when status='sending' then lease_token else null end,
				leased_until=case when status='sending' then leased_until else null end,version=version+1,updated_at=clock_timestamp()
				where id=:id and status in ('planned','retry','claimed','sending') and not cancel_requested
				""").param("id",id).update()==1;
	}

	@Transactional
	public int recoverExpiredLeases() {
		var recovered=jdbc.sql("""
				update notification_deliveries set status=case when status='sending' then 'unknown'
				 when cancel_requested then 'cancelled' when expires_at<=clock_timestamp() then 'expired' else 'planned' end,
				last_error_code=case when status='sending' then 'lease_expired_after_start' else last_error_code end,
				lease_token=null,leased_until=null,version=version+1,updated_at=clock_timestamp()
				where status in ('claimed','sending') and leased_until<=clock_timestamp() returning id,status
				""").query((row,index)->new Recovered(row.getString("id"),row.getString("status"))).list();
		for(var r:recovered) if("unknown".equals(r.status())) jdbc.sql("update delivery_attempts set result_status='unknown',provider_code='lease_expired_after_start',finished_at=clock_timestamp() where delivery_id=:id and finished_at is null")
				.param("id",r.id()).update();
		return recovered.size();
	}

	@Transactional
	public int expirePending() {
		return jdbc.sql("""
				update notification_deliveries set status=case when attempts>=8 then 'failed' else 'expired' end,
				lease_token=null,leased_until=null,version=version+1,updated_at=clock_timestamp()
				where status in ('planned','retry','claimed') and (expires_at<=clock_timestamp() or attempts>=8)
				""").update();
	}
	private static boolean blank(String s) { return s==null || s.isBlank(); }
	private boolean commandReplyEligible(String id,String token,String bot) {
		return jdbc.sql("""
				select d.category<>'telegram_command_reply' or exists(
				 select 1 from outbox_events o join telegram_inbox i on i.id=o.aggregate_id
				 where o.id=d.command_reply_outbox_id and o.aggregate_type='telegram_inbox' and o.event_type='telegram_command_reply'
				 and o.status='completed' and i.status='completed' and (cast(:bot as text) is null or i.bot_id=:bot)
				 and d.operation_id=o.id and d.payload=o.payload and not d.disable_notification
				 and d.chat_id>0 and d.message_thread_id is null and d.payload->>'command' in ('start','help','menu','profile')
				 and d.payload->>'botId'=i.bot_id and d.payload->>'chatId'=d.chat_id::text
				 and d.intended_at=o.available_at and d.expires_at=o.available_at+interval '15 minutes'
				 and d.expires_at>clock_timestamp() and d.intended_at<=clock_timestamp()
				 and i.chat_key=i.bot_id||':chat:'||d.chat_id::text
				 and i.payload->'message'->'chat'->>'type'='private'
				 and i.payload->'message'->'chat'->>'id'=d.chat_id::text
				 and i.payload->'message'->'from'->>'id'=d.chat_id::text
				 and i.payload->'message'->'from'->'is_bot'='false'::jsonb
				 and i.payload->'message'->>'message_id'=d.payload->>'sourceMessageId'
				 and not jsonb_exists_any(i.payload->'message',array['sender_chat','forward_origin','via_bot','business_connection_id'])
				 and ((d.recipient_id is not null and d.payload->>'recipientId'=d.recipient_id and exists(
				  select 1 from users u join chat_bindings b on b.bot_id=i.bot_id and b.chat_id=d.chat_id and b.type='private'
				  where u.id=d.recipient_id and u.active and u.registered and u.telegram_id=d.chat_id and u.role=d.payload->>'recipientRole'
				  and (not (d.payload->>'command'='profile' or (d.payload->>'command'='menu' and u.role in ('admin','organizer')))
				       or u.version::text=d.payload->>'profileVersion')))
				 or (d.recipient_id is null and not jsonb_exists_any(d.payload,array['recipientId','recipientRole'])
				  and d.payload->>'text'='Вас нет в списке участников. Попросите админа добавить ваш Telegram в раздел «Команда», а потом нажмите /start ещё раз.'
				  and d.payload->'replyMarkup'='{"keyboard":[[{"text":"Помощь"}]],"resize_keyboard":true,"is_persistent":false,"one_time_keyboard":false}'::jsonb
				  and not exists(select 1 from users u where u.telegram_id=d.chat_id and u.active and u.registered))))
				from notification_deliveries d where d.id=:id and d.lease_token=:token
				and d.status in ('claimed','sending') and d.leased_until>clock_timestamp() and not d.cancel_requested
				""").param("id",id).param("token",token).param("bot",bot).query((r,i)->r.getBoolean(1)).optional().orElse(false);
	}
	/** Final command eligibility check, before HTTP only; never cancels an already attempted provider request. */
	@Transactional
	public boolean commandReplyReadyForSending(String id,String token,String bot) {
		if(bot==null || !bot.matches("[0-9]{1,20}"))throw bad("invalid_delivery_bot");
		if(commandReplyEligible(id,token,bot))return true;
		int changed=jdbc.sql("""
				update notification_deliveries set status='cancelled',cancel_requested=true,last_error_code='stale_command_reply',
				lease_token=null,leased_until=null,response_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
				where id=:id and lease_token=:token and status='sending' and category='telegram_command_reply' and leased_until>clock_timestamp()
				""").param("id",id).param("token",token).update();
		if(changed==1)jdbc.sql("update delivery_attempts set result_status='cancelled',provider_code='stale_command_reply',finished_at=clock_timestamp() where delivery_id=:id and finished_at is null")
				.param("id",id).update();
		return false;
	}
	private boolean broadcastExpiryEligible(String id,String token) {
		var source=jdbc.sql("""
				select n.broadcast_id from notification_deliveries d join broadcast_expiry_notices n on n.id=d.broadcast_expiry_notice_id
				where d.id=:id and d.lease_token=:token and d.status='claimed' and d.leased_until>clock_timestamp()
				""").param("id",id).param("token",token).query(String.class).optional();
		if(source.isEmpty())return true;
		jdbc.sql("select id from broadcasts where id=:id for update").param("id",source.get()).query(String.class).single();
		return jdbc.sql("""
				select n.state='queued' and n.expires_at>clock_timestamp() and b.status<>'cancelled'
				and b.content_revision=n.revision and b.author_id=n.author_id and b.expires_at=n.intended_at
				and u.active and u.registered and u.role in ('admin','organizer') and u.telegram_id=n.chat_id
				and d.category='broadcast_expired' and d.recipient_id=n.author_id and d.chat_id=n.chat_id
				and d.message_thread_id is null and d.intended_at=n.intended_at and d.expires_at=n.expires_at
				from notification_deliveries d join broadcast_expiry_notices n on n.id=d.broadcast_expiry_notice_id
				join broadcasts b on b.id=n.broadcast_id join users u on u.id=n.author_id where d.id=:id
				""").param("id",id).query((r,i)->r.getBoolean(1)).single();
	}
	private boolean birthdayEligible(String id,String token) {
		return jdbc.sql("""
				select o.state='queued' and t.state='queued' and o.expires_at>clock_timestamp() and d.intended_at=o.intended_at
				and b.active and b.registered and b.role in ('admin','organizer')
				and b.birthday_day=extract(day from o.birthday_date) and b.birthday_month=extract(month from o.birthday_date)
				and u.active and u.registered and u.role in ('admin','organizer') and u.id<>b.id and u.telegram_id=t.chat_id
				and d.recipient_id=t.recipient_id and d.chat_id=t.chat_id and d.message_thread_id is null
				and jsonb_typeof(d.payload->'closedText')='string'
				from notification_deliveries d join birthday_reminder_targets t on t.id=d.birthday_reminder_target_id
				join birthday_reminder_occurrences o on o.id=t.occurrence_id join users b on b.id=o.birthday_user_id join users u on u.id=t.recipient_id
				where d.id=:id and d.lease_token=:token and d.status='claimed' and d.leased_until>clock_timestamp()
				""").param("id",id).param("token",token).query((r,i)->r.getBoolean(1)).optional().orElse(true);
	}
	/** Resolve the collection cutoff at the last pre-HTTP step, also on retries of an old open snapshot. */
	@Transactional(readOnly=true)
	public java.util.Optional<String> birthdayTextForSending(String id,String token) {
		return jdbc.sql("""
				select case when clock_timestamp()>=o.collection_closes_at then d.payload->>'closedText' else d.payload->>'text' end
				from notification_deliveries d join birthday_reminder_targets t on t.id=d.birthday_reminder_target_id
				join birthday_reminder_occurrences o on o.id=t.occurrence_id
				where d.id=:id and d.lease_token=:token and d.status='sending' and d.leased_until>clock_timestamp()
				""").param("id",id).param("token",token).query(String.class).optional();
	}
	private boolean availabilityEligible(String id,String token) {
		var target=jdbc.sql("""
				select t.week_start,t.recipient_id,
				(o.state='queued' and t.state='queued' and d.intended_at=o.intended_at and o.expires_at>clock_timestamp()
				and u.active and u.registered and u.role in ('admin','organizer') and u.telegram_id=t.chat_id
				and d.recipient_id=t.recipient_id and d.chat_id=t.chat_id and d.message_thread_id is null) as valid
				from notification_deliveries d join availability_reminder_targets t on t.id=d.availability_reminder_target_id
				join availability_reminder_occurrences o on o.week_start=t.week_start join users u on u.id=t.recipient_id
				where d.id=:id and d.lease_token=:token and d.status='claimed' and d.leased_until>clock_timestamp()
				""").param("id",id).param("token",token).query((r,i)->new AvailabilityGuard(r.getObject(1,java.time.LocalDate.class),r.getString(2),r.getBoolean(3))).optional();
		return target.isEmpty() || target.get().valid() && !availability.submitted(target.get().user(),target.get().week());
	}
	private boolean meetingEligible(String id,String token) {
		var meeting=jdbc.sql("""
				select e.meeting_id from notification_deliveries d join meeting_notification_targets t on t.id=d.meeting_target_id
				join meeting_notification_events e on e.id=t.event_id where d.id=:id and d.lease_token=:token
				and d.status='claimed' and d.leased_until>clock_timestamp()
				""").param("id",id).param("token",token).query(String.class).optional();
		if(meeting.isEmpty())return true;
		jdbc.sql("select id from meetings where id=:id for update").param("id",meeting.get()).query(String.class).single();
		return jdbc.sql("""
				select count(*) from notification_deliveries d join meeting_notification_targets t on t.id=d.meeting_target_id
				join meeting_notification_events e on e.id=t.event_id join outbox_events o on o.id=e.id
				join meetings m on m.id=e.meeting_id join users a on a.id=e.actor_id
				where d.id=:id and e.state='queued' and o.status='completed' and e.expires_at>clock_timestamp()
				and m.version=e.meeting_version and ((e.action='cancelled' and m.status='cancelled') or (e.action<>'cancelled' and m.status='scheduled' and m.starts_at+make_interval(mins=>m.duration_minutes)>clock_timestamp()))
				and (e.action<>'reminder' or m.starts_at>clock_timestamp())
				and a.active and a.registered and (a.role='admin' or (a.role='organizer' and m.host_id=a.id))
				and d.chat_id=t.chat_id and d.recipient_id is not distinct from t.recipient_id and d.message_thread_id is not distinct from t.message_thread_id
				and ((t.kind='group' and exists(select 1 from chat_bindings b where b.bot_id=t.bot_id and b.chat_id=t.chat_id and b.type='important' and b.important_thread_id=t.message_thread_id))
				or (t.kind<>'group' and exists(select 1 from users u where u.id=t.recipient_id and u.active and u.registered and u.role in ('admin','organizer') and u.telegram_id=t.chat_id)
				and ((t.kind='invited' and exists(select 1 from meeting_invitations i where i.meeting_id=m.id and i.user_id=t.recipient_id))
				or (t.kind='removed' and e.action='updated' and not exists(select 1 from meeting_invitations i where i.meeting_id=m.id and i.user_id=t.recipient_id)))))
				""").param("id",id).query(Long.class).single()>0;
	}
	private boolean broadcastEligible(String id,String token) {
		var broadcast=jdbc.sql("""
				select t.broadcast_id from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id
				where d.id=:id and d.lease_token=:token and d.status='claimed' and d.leased_until>clock_timestamp()
				""").param("id",id).param("token",token).query(String.class).optional();
		if(broadcast.isEmpty())return true;
		// Parent-before-delivery lock order also used by patch/cancel: a claimed lease is not permission to send an old revision.
		var b=jdbc.sql("select status,content_revision,recipient_mode,week_start,author_id from broadcasts where id=:id for update")
				.param("id",broadcast.get()).query((row,i)->new BroadcastGuard(row.getString("status"),row.getLong("content_revision"),row.getString("recipient_mode"),
						row.getDate("week_start")==null?null:row.getDate("week_start").toLocalDate(),row.getString("author_id"))).single();
		var target=jdbc.sql("""
				select t.recipient_id,t.group_target_id from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id
				where d.id=:id and t.revision=:revision and d.recipient_id is not distinct from t.recipient_id
				and d.chat_id=t.chat_id and d.message_thread_id is not distinct from t.message_thread_id
				and d.part_count=t.part_count
				""").param("id",id).param("revision",b.revision()).query((r,i)->new AudienceTarget(r.getString(1),r.getString(2))).optional();
		boolean valid=target.isPresent() && ("groups".equals(b.mode())?target.get().group()!=null && groups.deliveryAllowed(id):
				target.get().group()==null && jdbc.sql("select count(*) from users where id=:id and active and registered and role in ('admin','organizer') and telegram_id=(select chat_id from notification_deliveries where id=:delivery)")
						.param("id",target.get().recipient()).param("delivery",id).query(Long.class).single()>0);
		var authorActive=jdbc.sql("select count(*) from users where id=:id and active and registered and role in ('admin','organizer')")
				.param("id",b.authorId()).query(Long.class).single()>0;
		if(!List.of("scheduled","sending").contains(b.status()) || !authorActive || !valid
				|| ("missing_slots".equals(b.mode()) && availability.submitted(target.get().recipient(),b.week()))) {
			cancel(id);return false;
		}
		return true;
	}
	private static int leaseSeconds(Duration d) {
		if(d==null || d.compareTo(Duration.ofSeconds(1))<0 || d.compareTo(Duration.ofSeconds(120))>0 || d.getNano()!=0) throw bad("invalid_delivery_lease");
		return (int)d.toSeconds();
	}
	private static ApiException bad(String code) { return new ApiException(HttpStatus.BAD_REQUEST,code,"Некорректные параметры доставки"); }
	public record NewDelivery(String operationId,String dedupeKey,String category,String recipientId,long chatId,Long threadId,
			String payload,boolean silent,Instant intendedAt,Instant availableAt,Instant expiresAt) {}
	public record Lease(String id,String token,long chatId,Long threadId,String recipientId,String payload,boolean silent,Instant intendedAt,Instant leasedUntil,String birthdayTargetId,String commandReplyOutboxId) {
		public Lease(String id,String token,long chatId,Long threadId,String recipientId,String payload,boolean silent,Instant intendedAt,Instant leasedUntil,String birthdayTargetId) {
			this(id,token,chatId,threadId,recipientId,payload,silent,intendedAt,leasedUntil,birthdayTargetId,null);
		}
		public Lease(String id,String token,long chatId,Long threadId,String recipientId,String payload,boolean silent,Instant intendedAt,Instant leasedUntil) {
			this(id,token,chatId,threadId,recipientId,payload,silent,intendedAt,leasedUntil,null);
		}
	}
	public record Result(String status,String code,Long messageId,Duration retryDelay) {
		public static Result sent(long messageId) { return new Result("sent",null,messageId,null); }
		public static Result retry(String code,Duration delay) { return new Result("retry",code,null,delay); }
		public static Result failed(String code) { return new Result("failed",code,null,null); }
		public static Result unknown(String code) { return new Result("unknown",code,null,null); }
	}
	private record Started(int number,Instant at) {}
	private record Finished(String status,int attempt) {}
	private record Recovered(String id,String status) {}
	private record BroadcastGuard(String status,long revision,String mode,java.time.LocalDate week,String authorId) {}
	private record AudienceTarget(String recipient,String group) {}
	private record AvailabilityGuard(java.time.LocalDate week,String user,boolean valid) {}
}
