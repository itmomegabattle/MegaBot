package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.availability.AvailabilitySubmissionService;
import ru.itmomegabattle.megabot.common.*;

@Service
class DeliveryJournalService {
	static final String WARNING="Первое сообщение могло быть доставлено. Повтор может создать дубль.";
	private final JdbcClient jdbc;private final BroadcastService broadcasts;private final DeliveryQueue queue;private final AuditWriter audit;private final AvailabilitySubmissionService availability;
	private final BroadcastGroupTargets groups;
	DeliveryJournalService(JdbcClient jdbc,BroadcastService broadcasts,DeliveryQueue queue,AuditWriter audit,AvailabilitySubmissionService availability,BroadcastGroupTargets groups) { this.jdbc=jdbc;this.broadcasts=broadcasts;this.queue=queue;this.audit=audit;this.availability=availability;this.groups=groups; }
	@Transactional(readOnly=true) public void authorize(String id,AuthenticatedUser actor) { broadcasts.accessible(id,actor,false); }
	@Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
	public Map<String,Object> list(String id,AuthenticatedUser actor,int limit,String cursor) {
		var b=broadcasts.accessible(id,actor,false);if(limit<1 || limit>100)throw bad("invalid_limit");
		var after=cursor==null?"":cursor;
		if(!after.isEmpty() && jdbc.sql("select count(*) from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=:id and d.id=:cursor")
				.param("id",id).param("cursor",after).query(Long.class).single()==0)throw bad("invalid_delivery_cursor");
		var rows=jdbc.sql("""
				select d.*,t.recipient_id as target_recipient,t.group_target_id,t.revision from notification_deliveries d
				join broadcast_targets t on t.id=d.broadcast_target_id where t.broadcast_id=:id and d.id>:cursor order by d.id limit :limit
				""").param("id",id).param("cursor",after).param("limit",limit+1).query((r,i)->{
			var row=new LinkedHashMap<String,Object>();row.put("id",r.getString("id"));row.put("recipientId",r.getString("target_recipient"));row.put("contentRevision",r.getLong("revision"));
			if(r.getString("group_target_id")!=null)row.put("groupTargetId",r.getString("group_target_id"));
			row.put("status",r.getString("status"));row.put("retryOf",r.getString("retry_of"));row.put("attemptCount",r.getInt("attempts"));row.put("providerMessageId",r.getObject("telegram_message_id"));
			row.put("partNumber",r.getInt("part_number"));row.put("partCount",r.getInt("part_count"));
			for(String field:List.of("intended_at","available_at","claimed_at","request_started_at","response_at","sent_at","expires_at")) {
				var time=r.getTimestamp(field);row.put(switch(field){case "intended_at"->"intendedAt";case "available_at"->"availableAt";case "claimed_at"->"claimedAt";case "request_started_at"->"requestStartedAt";case "response_at"->"responseAt";case "sent_at"->"sentAt";default->"expiresAt";},time==null?null:time.toInstant());
			}
			row.put("errorCode",safeCode(r.getString("last_error_code")));row.put("action",action(r.getString("status"),r.getString("last_error_code")));return row;
		}).list();
		var more=rows.size()>limit;var selected=more?rows.subList(0,limit):rows;
		for(var row:selected) {
			row.put("replacedBy",jdbc.sql("select id from notification_deliveries where retry_of=:id").param("id",row.get("id")).query(String.class).optional().orElse(null));
			row.put("attempts",jdbc.sql("select attempt_number,started_at,finished_at,result_status,provider_code,provider_message_id from delivery_attempts where delivery_id=:id order by attempt_number limit 8")
					.param("id",row.get("id")).query((r,i)->{
						var attempt=new LinkedHashMap<String,Object>();attempt.put("number",r.getInt("attempt_number"));attempt.put("startedAt",r.getTimestamp("started_at").toInstant());
						var finished=r.getTimestamp("finished_at");attempt.put("finishedAt",finished==null?null:finished.toInstant());attempt.put("status",r.getString("result_status"));
						attempt.put("code",safeCode(r.getString("provider_code")));attempt.put("providerMessageId",r.getObject("provider_message_id"));return attempt;
					}).list());
		}
		var result=new LinkedHashMap<String,Object>();result.put("broadcastId",id);result.put("version",b.get("version"));result.put("items",selected);result.put("nextCursor",more?selected.getLast().get("id"):null);result.put("duplicateRiskWarning",WARNING);return result;
	}
	@Transactional
	public Map<String,Object> retry(String id,String deliveryId,DeliveryJournalController.Retry request,AuthenticatedUser actor) {
		var b=broadcasts.accessible(id,actor,true);
		if(((Number)b.get("version")).longValue()!=request.expectedVersion())throw conflict("stale_version");
		if(!Boolean.TRUE.equals(request.acknowledgeDuplicateRisk()))throw bad("duplicate_risk_not_acknowledged");
		if(!List.of("scheduled","sending").contains(b.get("lifecycleStatus")))throw conflict("broadcast_not_retryable");
		var old=jdbc.sql("""
				select d.*,t.revision from notification_deliveries d join broadcast_targets t on t.id=d.broadcast_target_id
				where d.id=:delivery and t.broadcast_id=:id for update of d
				""").param("delivery",deliveryId).param("id",id).query((r,i)->new Original(r.getString("broadcast_target_id"),r.getString("recipient_id"),r.getLong("chat_id"),(Long)r.getObject("message_thread_id"),r.getString("payload"),r.getBoolean("disable_notification"),r.getString("status"),r.getBoolean("cancel_requested"),r.getLong("revision"),r.getTimestamp("expires_at")==null?null:r.getTimestamp("expires_at").toInstant(),r.getInt("part_number"),r.getInt("part_count"))).optional()
				.orElseThrow(()->new ApiException(HttpStatus.NOT_FOUND,"delivery_not_found","Доставка не найдена"));
		var now=jdbc.sql("select clock_timestamp()").query((r,i)->r.getTimestamp(1).toInstant()).single();
		if(!"unknown".equals(old.status()) || old.cancelled() || old.revision()!=((Number)b.get("contentRevision")).longValue()
				|| old.expiry()!=null && !old.expiry().isAfter(now))throw conflict("delivery_not_retryable");
		if(jdbc.sql("select count(*) from notification_deliveries where retry_of=:id").param("id",deliveryId).query(Long.class).single()>0)throw conflict("delivery_already_retried");
		if("groups".equals(b.get("recipientMode"))?!groups.deliveryAllowed(deliveryId):jdbc.sql("select count(*) from users where id=:id and active and registered and role in ('admin','organizer') and telegram_id=:chat")
				.param("id",old.recipient()).param("chat",old.chat()).query(Long.class).single()==0)throw conflict("recipient_unavailable");
		if(jdbc.sql("select count(*) from users where id=:id and active and registered and role in ('admin','organizer')")
				.param("id",b.get("authorId")).query(Long.class).single()==0)throw conflict("author_unavailable");
		if("missing_slots".equals(b.get("recipientMode")) && availability.submitted(old.recipient(),(java.time.LocalDate)b.get("weekStart")))throw conflict("recipient_already_submitted");
		var child=queue.enqueue(new DeliveryQueue.NewDelivery(id,"manual:"+UUID.randomUUID(),"broadcast",old.recipient(),old.chat(),old.thread(),old.payload(),old.silent(),now,now,old.expiry()));
		jdbc.sql("update notification_deliveries set broadcast_target_id=:target,retry_of=:original,part_number=:number,part_count=:count where id=:child")
				.param("target",old.target()).param("original",deliveryId).param("number",old.partNumber()).param("count",old.partCount()).param("child",child).update();
		jdbc.sql("update broadcasts set version=version+1,updated_at=clock_timestamp() where id=:id").param("id",id).update();
		audit.write(actor.id(),"broadcast",id,"manual_retry_requested",Map.of("deliveryId",child,"retryOf",deliveryId,"duplicateRiskAcknowledged",true));
		return Map.of("id",child,"retryOf",deliveryId,"status","planned","version",((Number)b.get("version")).longValue()+1,"duplicateRiskWarning",WARNING);
	}
	private static String safeCode(String code) {
		if(code==null)return null;
		return code.matches("telegram_(400|401|403|404|429|5[0-9]{2})") || List.of("connection_not_established","interrupted_after_start","response_not_confirmed","response_timeout",
				"invalid_provider_response","invalid_success_response","invalid_retry_after","inconsistent_provider_response","unclassified_provider_response","transport_exception_after_start",
				"invalid_delivery_payload","lease_expired_after_start","migration_uncertain","test_recipient_not_allowed").contains(code)?code:"provider_error";
	}
	private static String action(String status,String code) {
		if("unknown".equals(status))return WARNING;
		if("telegram_403".equals(code))return "Проверьте, что пользователь разблокировал бота и разрешил сообщения.";
		if("telegram_401".equals(code))return "Администратору нужно проверить настройки доступа бота.";
		if("failed".equals(status))return "Проверьте адресата и параметры сообщения; автоматическая отправка остановлена.";
		if("expired".equals(status))return "Срок отправки истёк; создайте новую рассылку с актуальным временем.";
		return "";
	}
	private static ApiException bad(String code) { return new ApiException(HttpStatus.BAD_REQUEST,code,"Проверьте параметры журнала и подтвердите риск дублирования"); }
	private static ApiException conflict(String code) { return new ApiException(HttpStatus.CONFLICT,code,"Доставка изменилась, недоступна или повтор уже создан"); }
	private record Original(String target,String recipient,long chat,Long thread,String payload,boolean silent,String status,boolean cancelled,long revision,Instant expiry,int partNumber,int partCount) {}
}
