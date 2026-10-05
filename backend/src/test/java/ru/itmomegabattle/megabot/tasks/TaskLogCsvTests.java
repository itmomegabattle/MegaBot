package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class TaskLogCsvTests {
	@Test void quotesSeparatorsMultilineAndQuotes() {
		assertThat(TaskLogCsv.cell("a;\"b\"\r\nc")).isEqualTo("\"a;\"\"b\"\"\r\nc\"");
	}
	@Test void preventsFormulaInjectionIncludingInvisiblePrefixes() {
		for(var value:List.of("=HYPERLINK(1)","+cmd","-1+1","@SUM(1)"," \t\r=1","\uFEFF=1","\u00A0=1","\u200B=1"))
			assertThat(TaskLogCsv.cell(value)).startsWith("\"'");
		assertThat(TaskLogCsv.cell("Обычный текст")).isEqualTo("\"Обычный текст\"");
	}
	@Test void exportsSnapshotAndRealCompletionActorInMoscowWithoutInventingMissingData() {
		var entry=new LinkedHashMap<String,Object>();
		entry.put("id","h1"); entry.put("taskId","t1"); entry.put("occurredAt",Instant.parse("2026-10-01T21:01:00Z"));
		entry.put("actorId","u1"); entry.put("actorName","Первый"); entry.put("status","completed");
		entry.put("completedByName","Второй");
		entry.put("details",new ObjectMapper().readTree("""
				{"action":"status","title":"Исходное название","completedBy":"u2","version":4,"timeSpentMinutes":30}
				"""));
		var csv=TaskLogCsv.render(List.of(entry));
		assertThat(csv).startsWith("\uFEFF").contains("\"2026-10-02 00:01:00.000\"","\"Выполнена\"",
				"\"Исходное название\"","\"Второй\";\"u2\";\"30\";\"4\"");
		assertThat(csv).doesNotContain("null","undefined");
	}
	@Test void emptyReportStillContainsHeader() {
		assertThat(TaskLogCsv.render(List.of())).contains("ID записи").endsWith("\r\n").doesNotContain("Свободна");
	}
}
