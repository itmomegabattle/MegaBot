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
class LegacyTaskAdminService {
	private final TaskMaintenanceService maintenance;
	private final JdbcClient jdbc;
	LegacyTaskAdminService(TaskMaintenanceService maintenance,JdbcClient jdbc) { this.maintenance=maintenance; this.jdbc=jdbc; }
	@Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
	public Map<String,Object> preview(String mode) {
		var preview=new LinkedHashMap<String,Object>(maintenance.preview(mode));
		preview.put("success",true); preview.put("taskIds",ids(preview));
		if("archive".equals(mode)) {
			var counts=(Map<?,?>)preview.get("statusCounts");
			preview.put("completedCount",counts.containsKey("completed")?counts.get("completed"):0);
			preview.put("cancelledCount",counts.containsKey("cancelled")?counts.get("cancelled"):0);
		}
		return preview;
	}
	@Transactional
	public Map<String,Object> clear(String mode,LegacyTaskAdminController.Clear request,AuthenticatedUser actor) {
		TaskMaintenanceGate.exclusive(jdbc);
		if(request.taskIds()!=null && !ids(maintenance.preview(mode)).equals(request.taskIds().stream().sorted().toList()))
			throw TaskRules.conflict("stale_preview","Состав задач изменился. Обновите предварительный просмотр");
		var result=maintenance.clear(mode,new TaskMaintenanceController.Clear(request.fingerprint(),request.confirmation()),actor);
		var response=new LinkedHashMap<String,Object>(result); response.put("success",true);
		response.put("removedCount",result.get("count")); response.put("backupId",result.get("recoveryId"));
		response.put("operationId",result.get("recoveryId"));
		response.put("remainingCount",jdbc.sql("select count(*) from tasks where removed_at is null").query(Long.class).single());
		return response;
	}
	@SuppressWarnings("unchecked")
	private List<String> ids(Map<String,Object> preview) {
		return ((List<TaskMaintenanceService.Selection>)preview.get("tasks")).stream().map(TaskMaintenanceService.Selection::id).toList();
	}
}
