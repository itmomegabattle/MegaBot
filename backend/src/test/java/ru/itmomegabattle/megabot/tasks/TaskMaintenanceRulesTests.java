package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import java.util.List;
import org.junit.jupiter.api.Test;

class TaskMaintenanceRulesTests {
	@Test void fingerprintIncludesScopeVersionsStatusAndExactComposition() {
		var selected=List.of(new TaskMaintenanceService.Selection("task_1",1,"completed"));
		var fingerprint=TaskMaintenanceService.fingerprint("archive",selected);
		assertThat(fingerprint).hasSize(64).isEqualTo(TaskMaintenanceService.fingerprint("archive",selected));
		assertThat(fingerprint).isNotEqualTo(TaskMaintenanceService.fingerprint("season-reset",selected));
		assertThat(fingerprint).isNotEqualTo(TaskMaintenanceService.fingerprint("archive",List.of(new TaskMaintenanceService.Selection("task_1",2,"completed"))));
		assertThat(fingerprint).isNotEqualTo(TaskMaintenanceService.fingerprint("archive",List.of(new TaskMaintenanceService.Selection("task_1",1,"cancelled"))));
		assertThat(fingerprint).isNotEqualTo(TaskMaintenanceService.fingerprint("archive",List.of()));
	}
}
