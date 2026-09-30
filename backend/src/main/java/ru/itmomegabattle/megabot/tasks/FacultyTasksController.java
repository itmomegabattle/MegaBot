package ru.itmomegabattle.megabot.tasks;

import java.util.List;
import java.util.Map;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;

@RestController
class FacultyTasksController {
	private final TaskService tasks;
	FacultyTasksController(TaskService tasks) { this.tasks=tasks; }
	@GetMapping("/api/v1/faculty/my-tasks")
	@PreAuthorize("hasAnyRole('FACULTY_RESPONSIBLE','FACULTY_HELPER')")
	List<Map<String,Object>> list(@AuthenticationPrincipal AuthenticatedUser actor,
			@RequestParam(defaultValue="50") int limit,@RequestParam(required=false) String cursor) {
		return tasks.list(actor,limit,cursor);
	}
}
