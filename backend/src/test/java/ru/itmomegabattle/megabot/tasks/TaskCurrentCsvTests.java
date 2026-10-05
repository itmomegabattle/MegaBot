package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TaskCurrentCsvTests {
	@Test void currentSnapshotEscapesFormulasQuotesAndFormatsMoscowTime() {
		var csv=TaskCurrentCsv.render(List.of(Map.of("id","task","title","\u200B=1+1","description","<script>\";\nтекст",
				"createdAt",Instant.parse("2026-10-01T09:00:00Z"),"tips",List.of("Первое","Второе"),"completedByName","Исполнитель")));
		assertThat(csv).startsWith("\uFEFF").contains("\"'\u200B=1+1\"","<script>\"\";\nтекст","2026-10-01 12:00:00.000","Первое\nВторое","Исполнитель");
	}
	@Test void emptySnapshotHasHeaderOnly() {
		assertThat(TaskCurrentCsv.render(List.of())).contains("ID задачи").doesNotContain("ID записи");
		assertThat(TaskCurrentCsv.render(List.of()).split("\r\n")).hasSize(1);
	}
}
