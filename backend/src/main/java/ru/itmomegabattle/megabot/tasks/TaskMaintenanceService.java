package ru.itmomegabattle.megabot.tasks;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.HexFormat;
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
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;
import ru.itmomegabattle.megabot.common.SqlTime;
import tools.jackson.databind.ObjectMapper;

@Service
class TaskMaintenanceService {
	private final JdbcClient jdbc;
	private final Clock clock;
	private final ObjectMapper json;
	private final AuditWriter audit;
	private final TaskReminderService reminders;
	TaskMaintenanceService(JdbcClient jdbc,Clock clock,ObjectMapper json,AuditWriter audit,TaskReminderService reminders) {
		this.jdbc=jdbc; this.clock=clock; this.json=json; this.audit=audit; this.reminders=reminders;
	}
	@Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
	public Map<String,Object> preview(String mode) { return previewOf(mode,selection(mode)); }

	@Transactional
	public Map<String,Object> clear(String mode,TaskMaintenanceController.Clear request,AuthenticatedUser actor) {
		if("season-reset".equals(mode) && !"СБРОСИТЬ СЕЗОН".equals(request.confirmation()))
			throw TaskRules.bad("confirmation_required","Введите СБРОСИТЬ СЕЗОН");
		TaskMaintenanceGate.exclusive(jdbc);
		var selected=selection(mode);
		if(!fingerprint(mode,selected).equals(request.fingerprint()))
			throw TaskRules.conflict("stale_preview","Задачи изменились. Обновите предварительный просмотр");
		if(selected.isEmpty()) return Map.of("count",0,"changed",false);
		var ids=selected.stream().map(Selection::id).toList();
		var snapshot=jdbc.sql("""
				select jsonb_build_object('task',to_jsonb(t),
				 'assignees',coalesce((select jsonb_agg(to_jsonb(a)) from task_assignees a where a.task_id=t.id),'[]'::jsonb),
				 'competencies',coalesce((select jsonb_agg(to_jsonb(c)) from task_competencies c where c.task_id=t.id),'[]'::jsonb),
				 'tips',coalesce((select jsonb_agg(to_jsonb(p)) from task_tips p where p.task_id=t.id),'[]'::jsonb),
				 'comments',coalesce((select jsonb_agg(to_jsonb(c)) from task_comments c where c.task_id=t.id),'[]'::jsonb),
				 'reminders',coalesce((select jsonb_agg(to_jsonb(r)) from task_reminders r where r.task_id=t.id),'[]'::jsonb),
				 'history',coalesce((select jsonb_agg(to_jsonb(h)) from task_status_history h where h.task_id=t.id),'[]'::jsonb))::text
				 from tasks t where t.id in (:ids) order by t.id
				""").param("ids",ids).query(String.class).list().stream().map(json::readTree).toList();
		var operation="recovery_"+UUID.randomUUID();
		jdbc.sql("""
				insert into task_recovery_operations(id,mode,actor_id,preview_fingerprint,snapshot,task_count,created_at)
				values (:id,:mode,:actor,:fingerprint,cast(:snapshot as jsonb),:count,:now)
				""").param("id",operation).param("mode",mode).param("actor",actor.id()).param("fingerprint",request.fingerprint())
				.param("snapshot",json.writeValueAsString(snapshot)).param("count",ids.size()).param("now",SqlTime.of(clock.instant())).update();
		jdbc.sql("update tasks set removed_at=:now,removal_operation_id=:operation,version=version+1,updated_at=now() where id in (:ids)")
				.param("now",SqlTime.of(clock.instant())).param("operation",operation).param("ids",ids).update();
		jdbc.sql("update task_reminders set active=false,next_due_at=null,version=version+1 where task_id in (:ids)")
				.param("ids",ids).update();
		// Prevent already queued task notifications from firing after a reset. Never resurrect these on restore.
		jdbc.sql("update outbox_events set status='cancelled',lease_token=null,leased_until=null,updated_at=now() where aggregate_type='task' and aggregate_id in (:ids) and status in ('pending','retry','processing')")
				.param("ids",ids).update();
		audit.write(actor.id(),"task_maintenance",operation,mode,Map.of("count",ids.size(),"taskIds",ids,"fingerprint",request.fingerprint()));
		return Map.of("count",ids.size(),"changed",true,"recoveryId",operation);
	}

	@Transactional(readOnly=true)
	public Map<String,Object> recovery(String id) {
		return jdbc.sql("select * from task_recovery_operations where id=:id").param("id",id).query((row,index)->{
			var result=new LinkedHashMap<String,Object>(); result.put("id",id); result.put("mode",row.getString("mode"));
			result.put("count",row.getInt("task_count")); result.put("createdAt",row.getTimestamp("created_at").toInstant());
			result.put("actorId",row.getString("actor_id")); result.put("snapshot",json.readTree(row.getString("snapshot")));
			var restored=row.getTimestamp("restored_at"); result.put("restoredAt",restored==null?null:restored.toInstant());
			result.put("restoredBy",row.getString("restored_by")); return (Map<String,Object>)result;
		}).optional().orElseThrow(()->missing());
	}

	@Transactional
	public Map<String,Object> restore(String id,AuthenticatedUser actor) {
		TaskMaintenanceGate.exclusive(jdbc);
		var operation=jdbc.sql("select snapshot::text,restored_at from task_recovery_operations where id=:id for update")
				.param("id",id).query((row,index)->new Recovery(row.getString("snapshot"),row.getTimestamp("restored_at")!=null))
				.optional().orElseThrow(()->missing());
		if(operation.restored()) return Map.of("recoveryId",id,"restored",true,"changed",false);
		var snapshot=json.readTree(operation.snapshot());
		for(var entry:snapshot) {
			var original=entry.path("task"); var taskId=original.path("id").asText();
			var count=jdbc.sql("select count(*) from tasks where id=:id and removal_operation_id=:operation and version=:version")
					.param("id",taskId).param("operation",id).param("version",original.path("version").asLong()+1).query(Long.class).single();
			if(count!=1) throw TaskRules.conflict("recovery_conflict","Задача изменилась вне операции восстановления");
		}
		var tasks=jdbc.sql("select id,status from tasks where removal_operation_id=:operation order by id")
				.param("operation",id).query((row,index)->Map.of("id",row.getString("id"),"status",row.getString("status"))).list();
		if(tasks.size()!=snapshot.size()) throw TaskRules.conflict("recovery_conflict","Состав восстанавливаемых задач изменился");
		jdbc.sql("update tasks set removed_at=null,removal_operation_id=null,version=version+1,updated_at=now() where removal_operation_id=:operation")
				.param("operation",id).update();
		for(var task:tasks) reminders.lifecycle(task.get("id"),task.get("status"));
		jdbc.sql("update task_recovery_operations set restored_at=:now,restored_by=:actor where id=:id")
				.param("now",SqlTime.of(clock.instant())).param("actor",actor.id()).param("id",id).update();
		audit.write(actor.id(),"task_maintenance",id,"restored",Map.of("count",tasks.size()));
		return Map.of("recoveryId",id,"restored",true,"changed",true,"count",tasks.size());
	}

	private List<Selection> selection(String mode) {
		if(!List.of("archive","season-reset").contains(mode)) throw TaskRules.bad("invalid_maintenance_mode","Неизвестная операция");
		return jdbc.sql("select id,version,status from tasks where removed_at is null and (:all or status in ('completed','cancelled')) order by id")
				.param("all","season-reset".equals(mode)).query((row,index)->new Selection(row.getString("id"),row.getLong("version"),row.getString("status"))).list();
	}
	private Map<String,Object> previewOf(String mode,List<Selection> selected) {
		var counts=new LinkedHashMap<String,Long>();
		for(var s:selected) counts.merge(s.status(),1L,Long::sum);
		return Map.of("mode",mode,"count",selected.size(),"tasks",selected,"statusCounts",counts,"fingerprint",fingerprint(mode,selected));
	}
	static String fingerprint(String mode,List<Selection> selected) {
		try {
			var digest=MessageDigest.getInstance("SHA-256"); digest.update(mode.getBytes(StandardCharsets.UTF_8));
			for(var task:selected) digest.update(("\n"+task.id().length()+":"+task.id()+":"+task.version()+":"+task.status()).getBytes(StandardCharsets.UTF_8));
			return HexFormat.of().formatHex(digest.digest());
		} catch(java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
	}
	private ApiException missing() { return new ApiException(HttpStatus.NOT_FOUND,"recovery_not_found","Восстановимая копия не найдена"); }
	record Selection(String id,long version,String status) {}
	private record Recovery(String snapshot,boolean restored) {}
}
