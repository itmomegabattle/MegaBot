package ru.itmomegabattle.megabot.tasks;

import java.nio.charset.StandardCharsets;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/tasks")
@PreAuthorize("hasAnyRole('ADMIN','ORGANIZER')")
class TaskReportController {
	private final TaskReportService reports;
	TaskReportController(TaskReportService reports) { this.reports=reports; }
	@GetMapping("/log")
	TaskReportService.Page log(@RequestParam(defaultValue="50") int limit,@RequestParam(required=false) String cursor) {
		return reports.log(limit,cursor);
	}
	@GetMapping("/export")
	@PreAuthorize("hasRole('ADMIN')")
	ResponseEntity<byte[]> export(@RequestParam(defaultValue="100") int limit,@RequestParam(required=false) String cursor) {
		var page=reports.log(limit,cursor);
		var response=ResponseEntity.ok().header("Content-Type","text/csv; charset=UTF-8")
				.header("Content-Disposition","attachment; filename=task-log.csv")
				.header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff");
		if(page.nextCursor()!=null) response.header("X-Next-Cursor",page.nextCursor());
		return response.body(TaskLogCsv.render(page.items()).getBytes(StandardCharsets.UTF_8));
	}
}
