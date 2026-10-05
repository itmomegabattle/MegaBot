package ru.itmomegabattle.megabot.tasks;

import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

final class TaskFrontendMapper {
	private static final ZoneId PROJECT_ZONE=ZoneId.of("Europe/Moscow");
	private TaskFrontendMapper() {}

	static Map<String,Object> map(Map<String,Object> task,List<String> competencyNames) {
		var result=new LinkedHashMap<String,Object>();
		for(var key:List.of("id","version","title","description","sow","status","priority","assignmentMode","createdAt",
				"creatorId","completedAt","completedBy","cancelledAt","cancelledBy","timeSpentMinutes","eventId","facultyId")) {
			if(task.get(key)!=null) result.put(key,task.get(key));
		}
		var due=(Instant)task.get("dueAt");
		result.put("deadline",due==null ? Objects.toString(task.get("legacyDeadline"),"") : due.atZone(PROJECT_ZONE).toLocalDate().toString());
		var assigned=(List<?>)task.getOrDefault("assigneeIds",List.of());
		result.put("assignedTo",assigned.isEmpty()?null:assigned);
		result.put("competencies",competencyNames);
		if(!competencyNames.isEmpty()) result.put("competency",competencyNames.getFirst());
		result.put("tips",task.getOrDefault("tips",List.of()));
		result.put("reminders",task.getOrDefault("reminders",List.of()));
		var notes=new LinkedHashMap<String,Map<String,Object>>();
		var completion=new LinkedHashMap<String,String>();
		var comments=commentList(task.get("comments"));
		for(var comment:comments) {
			var author=Objects.toString(comment.get("authorId"),"");
			if("completion".equals(comment.get("kind"))) {
				if("completed".equals(task.get("status")) && author.equals(task.get("completedBy"))
						&& sameVersion(comment.get("taskVersion"),task.getOrDefault("completionVersion",task.get("version"))))
					completion.put(author,Objects.toString(comment.get("text"),""));
				continue;
			}
			var target=Objects.toString(comment.get("targetAssigneeId"),"");
			if(target.isEmpty()) continue;
			var note=notes.computeIfAbsent(target,key->new LinkedHashMap<>());
			note.put(Objects.toString(comment.get("side"),"executor"),comment.get("text"));
			note.put("updatedAt",comment.get("createdAt"));
			@SuppressWarnings("unchecked")
			var history=(List<Map<String,Object>>)note.computeIfAbsent("history",key->new ArrayList<Map<String,Object>>());
			var entry=new LinkedHashMap<String,Object>();
			for(var key:List.of("id","side","text","createdAt")) entry.put(key,comment.get(key));
			entry.put("authorId",author); history.add(entry);
		}
		result.put("assigneeNotes",notes); result.put("completionComments",completion);
		// Keep untargeted discussions and older completion text in the full history.
		result.put("comments",comments);
		return result;
	}
	private static boolean sameVersion(Object left,Object right) {
		return left instanceof Number l && right instanceof Number r && l.longValue()==r.longValue();
	}
	@SuppressWarnings("unchecked")
	private static List<Map<String,Object>> commentList(Object value) {
		return value instanceof List<?> ? (List<Map<String,Object>>)value : List.of();
	}
}
