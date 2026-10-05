package ru.itmomegabattle.megabot.tasks;

import java.nio.charset.StandardCharsets;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;

@RestController
@PreAuthorize("hasRole('ADMIN')")
class LegacyTaskExportController {
	private final TaskCurrentExportService exports;
	LegacyTaskExportController(TaskCurrentExportService exports) { this.exports=exports; }
	@GetMapping("/api/task/export")
	ResponseEntity<byte[]> export(@RequestParam(defaultValue="100") int limit,@RequestParam(required=false) String cursor,@AuthenticationPrincipal AuthenticatedUser actor) {
		var page=exports.page(limit,cursor,actor);
		var response=ResponseEntity.ok().header("Content-Type","text/csv; charset=UTF-8")
				.header("Content-Disposition","attachment; filename=tasks.csv").header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff");
		if(page.nextCursor()!=null) response.header("X-Next-Cursor",page.nextCursor());
		return response.body(TaskCurrentCsv.render(page.items()).getBytes(StandardCharsets.UTF_8));
	}
}
