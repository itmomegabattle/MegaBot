package ru.itmomegabattle.megabot.tasks;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;

@Service
class TaskCurrentExportService {
	private final JdbcClient jdbc;
	private final TaskService tasks;
	TaskCurrentExportService(JdbcClient jdbc,TaskService tasks) { this.jdbc=jdbc; this.tasks=tasks; }
	@Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
	public Page page(int limit,String cursor,AuthenticatedUser actor) {
		if(limit<1 || limit>100) throw TaskRules.bad("invalid_limit","Лимит должен быть 1–100");
		var after=cursor==null?"":cursor;
		if(!after.isEmpty() && jdbc.sql("select count(*) from tasks where id=:id").param("id",after).query(Long.class).single()==0)
			throw TaskRules.bad("invalid_cursor","Задача для продолжения не найдена");
		var rows=jdbc.sql("""
				select t.id,e.name as event_name,creator.real_name as creator_name,finisher.real_name as completed_name,
				case when t.faculty_all then 'Все факультеты' else f.name end as faculty_name
				from tasks t left join work_events e on e.id=t.event_id left join faculties f on f.id=t.faculty_id
				left join users creator on creator.id=t.creator_id left join users finisher on finisher.id=t.completed_by
				where t.removed_at is null and t.id>:cursor order by t.id limit :limit
				""").param("cursor",after).param("limit",limit+1).query((row,index)->{
			var r=new LinkedHashMap<String,Object>(); r.put("id",row.getString("id")); r.put("eventName",row.getString("event_name"));
			r.put("creatorName",row.getString("creator_name")); r.put("completedByName",row.getString("completed_name"));
			r.put("facultyName",row.getString("faculty_name")); return r;
		}).list();
		var more=rows.size()>limit; var selected=more?rows.subList(0,limit):rows;
		var items=selected.stream().map(row->{
			var id=(String)row.get("id"); var task=new LinkedHashMap<String,Object>(tasks.get(id,actor)); task.putAll(row);
			task.put("executorNames",jdbc.sql("select u.real_name from task_assignees a join users u on u.id=a.user_id where a.task_id=:id order by u.id").param("id",id).query(String.class).list());
			task.put("competencyNames",jdbc.sql("select c.name from task_competencies tc join competencies c on c.id=tc.competency_id where tc.task_id=:id order by c.id").param("id",id).query(String.class).list());
			return (Map<String,Object>)task;
		}).toList();
		return new Page(items,more?(String)items.getLast().get("id"):null);
	}
	record Page(List<Map<String,Object>> items,String nextCursor) {}
}
