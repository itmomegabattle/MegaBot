package ru.itmomegabattle.megabot.tasks;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

/** Reports use persisted history snapshots, never a second mutable task log. */
@Service
class TaskReportService {
	private final JdbcClient jdbc;
	private final ObjectMapper json;
	TaskReportService(JdbcClient jdbc, ObjectMapper json) { this.jdbc=jdbc; this.json=json; }

	@Transactional(readOnly=true, isolation=Isolation.REPEATABLE_READ)
	public Page log(int limit, String cursor) {
		if(limit<1 || limit>100) throw TaskRules.bad("invalid_limit","Лимит должен быть 1–100");
		var after=cursor==null?"":cursor;
		if(!after.isEmpty() && jdbc.sql("select count(*) from task_status_history where id=:id")
				.param("id",after).query(Long.class).single()==0)
			throw TaskRules.bad("invalid_cursor","Запись журнала для продолжения не найдена");
		var entries=jdbc.sql("""
				select h.*, actor.real_name as actor_name, finisher.real_name as completed_name,
				       e.name as event_name, case when h.details->>'facultyId'='all' then 'Все факультеты' else f.name end as faculty_name
				from task_status_history h
				left join users actor on actor.id=h.actor_id
				left join users finisher on finisher.id=h.details->>'completedBy'
				left join work_events e on e.id=h.details->>'eventId'
				left join faculties f on f.id=h.details->>'facultyId'
				where (:cursor='' or (h.occurred_at,h.id) >
				(select occurred_at,id from task_status_history where id=:cursor))
				order by h.occurred_at,h.id limit :limit
				""").param("cursor",after).param("limit",limit+1).query((row,index)->{
			var result=new LinkedHashMap<String,Object>();
			result.put("id",row.getString("id")); result.put("taskId",row.getString("task_id"));
			result.put("actorId",row.getString("actor_id")); result.put("actorName",row.getString("actor_name"));
			result.put("previousStatus",row.getString("previous_status")); result.put("status",row.getString("new_status"));
			result.put("occurredAt",row.getTimestamp("occurred_at").toInstant());
			result.put("completedByName",row.getString("completed_name"));
			result.put("eventName",row.getString("event_name")); result.put("facultyName",row.getString("faculty_name"));
			result.put("details",json.readTree(row.getString("details")));
			return (Map<String,Object>) result;
		}).list();
		var hasMore=entries.size()>limit;
		var items=hasMore?entries.subList(0,limit):entries;
		return new Page(List.copyOf(items),hasMore?(String)items.getLast().get("id"):null);
	}

	record Page(List<Map<String,Object>> items, String nextCursor) {}
}
