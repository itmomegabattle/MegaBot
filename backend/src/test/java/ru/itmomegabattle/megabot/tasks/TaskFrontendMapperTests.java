package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TaskFrontendMapperTests {
	@Test void usesMoscowDeadlineAndNullForOpenAssignment() {
		var task=base(); task.put("dueAt",Instant.parse("2026-10-05T20:59:59.999Z"));
		var result=TaskFrontendMapper.map(task,List.of("Техника"));
		assertThat(result.get("deadline")).isEqualTo("2026-10-05");
		assertThat(result.get("assignedTo")).isNull();
		assertThat(result.get("competency")).isEqualTo("Техника");
		assertThat(result.get("tips")).isEqualTo(List.of("Проверить кабель"));
	}
	@Test void keepsUnknownLegacyDeadlineInsteadOfInventingADate() {
		var task=base(); task.put("legacyDeadline","legacy date awaiting migration");
		assertThat(TaskFrontendMapper.map(task,List.of()).get("deadline")).isEqualTo("legacy date awaiting migration");
	}
	@Test void separatesCurrentCompletionFromOldResultsAndDiscussion() {
		var task=base(); task.put("status","completed"); task.put("completedBy","executor"); task.put("version",7L);
		var discussion=comment("discussion",null,"Обсуждение");
		var old=comment("completion",3L,"Старый результат");
		var current=comment("completion",7L,"Текущий результат");
		task.put("comments",List.of(discussion,old,current));
		var result=TaskFrontendMapper.map(task,List.of());
		assertThat(result.get("completionComments")).isEqualTo(Map.of("executor","Текущий результат"));
		assertThat(result.get("comments")).isEqualTo(List.of(discussion,old,current));
		@SuppressWarnings("unchecked")
		var notes=(Map<String,Map<String,Object>>)result.get("assigneeNotes");
		assertThat(notes.get("executor").get("executor")).isEqualTo("Обсуждение");
		assertThat((List<?>)notes.get("executor").get("history")).hasSize(1);
		task.put("status","in_progress");
		assertThat(TaskFrontendMapper.map(task,List.of()).get("completionComments")).isEqualTo(Map.of());
	}
	@Test void preservesAppendOnlyDiscussionAndMissingLegacyAuthor() {
		var task=base(); var a=comment("discussion",null,"Первый"); a.put("authorId",null);
		var b=comment("discussion",null,"Второй"); task.put("comments",List.of(a,b));
		@SuppressWarnings("unchecked")
		var notes=(Map<String,Map<String,Object>>)TaskFrontendMapper.map(task,List.of()).get("assigneeNotes");
		@SuppressWarnings("unchecked")
		var history=(List<Map<String,Object>>)notes.get("executor").get("history");
		assertThat(history).hasSize(2); assertThat(history.getFirst().get("authorId")).isEqualTo("");
		assertThat(notes.get("executor").get("executor")).isEqualTo("Второй");
	}
	private Map<String,Object> base() {
		var task=new LinkedHashMap<String,Object>(); task.put("id","task_1"); task.put("status","open");
		task.put("assigneeIds",List.of()); task.put("tips",List.of("Проверить кабель")); return task;
	}
	private Map<String,Object> comment(String kind,Long version,String text) {
		var comment=new LinkedHashMap<String,Object>(); comment.put("id",text); comment.put("kind",kind);
		comment.put("taskVersion",version); comment.put("authorId","executor"); comment.put("targetAssigneeId","executor");
		comment.put("side","executor"); comment.put("text",text); comment.put("createdAt",Instant.parse("2026-10-01T10:00:00Z"));
		return comment;
	}
}
