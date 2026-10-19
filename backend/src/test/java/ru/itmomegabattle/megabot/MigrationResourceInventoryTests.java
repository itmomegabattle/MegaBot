package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import org.junit.jupiter.api.Test;

class MigrationResourceInventoryTests {

	private static final String[] MIGRATIONS = {
			"V001__identity_and_settings.sql",
			"V002__availability_and_meetings.sql",
			"V003__tasks.sql",
			"V004__messaging_and_integrations.sql",
			"V005__migration_tracking.sql",
			"V006__b04_catalog_versions.sql",
			"V007__task_reminder_configuration.sql",
			"V008__task_log_cursor_index.sql",
			"V009__task_maintenance_recovery.sql",
			"V010__all_faculty_task_scope.sql",
			"V011__delivery_lease_lifecycle.sql",
			"V012__broadcast_snapshot_metadata.sql",
			"V013__delivery_rate_limits.sql",
			"V014__manual_delivery_retry.sql",
			"V015__task_reminder_occurrences.sql",
			"V016__manual_task_delivery.sql",
			"V017__meeting_notification_targets.sql",
			"V018__task_creation_delivery.sql",
			"V019__task_status_delivery.sql",
			"V020__task_update_delivery.sql",
			"V021__task_assignment_delivery.sql",
			"V022__task_comment_cancel_delivery.sql",
			"V023__broadcast_creation_limits.sql",
			"V024__meeting_reminders.sql",
			"V025__availability_reminder_occurrences.sql",
			"V026__birthday_reminder_occurrences.sql",
			"V027__broadcast_expiry_notices.sql",
			"V028__broadcast_group_allowlist.sql",
			"V029__broadcast_message_parts.sql",
			"V030__telegram_command_replies.sql",
			"V031__telegram_callback_effects.sql",
			"V032__telegram_slot_drafts.sql",
			"V033__setup_duration_hours.sql",
			"V034__telegram_slot_panels.sql",
			"V035__telegram_slot_pending_weeks.sql",
			"V036__telegram_slot_day_baseline.sql",
			"V037__telegram_panel_deletions.sql",
			"V038__telegram_meeting_drafts.sql",
			"V039__telegram_meeting_draft_creation.sql",
            "V040__telegram_meeting_panels.sql",
            "V041__legacy_snapshot_staging.sql",
            "V042__telegram_task_drafts.sql"
	};

	@Test
	void migrationsCoverEveryPlannedDomainAndQueueIndex() throws IOException {
		var allSql = new StringBuilder();
		for (var migration : MIGRATIONS) {
			try (var stream = getClass().getResourceAsStream("/db/migration/" + migration)) {
				assertThat(stream).as(migration).isNotNull();
				allSql.append(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
			}
		}

		assertThat(allSql.toString()).contains(
				"CREATE TABLE users",
				"CREATE TABLE availability_weeks",
				"CREATE TABLE meetings",
				"CREATE TABLE tasks",
				"CREATE TABLE telegram_inbox",
				"CREATE TABLE telegram_callback_effects",
				"CREATE TABLE telegram_slot_drafts",
				"CREATE TABLE telegram_meeting_drafts",
				"CREATE TABLE broadcasts",
				"CREATE TABLE notification_deliveries",
				"CREATE TABLE integration_jobs",
				"CREATE TABLE idempotency_requests",
				"CREATE TABLE outbox_events",
				"CREATE TABLE migration_runs",
				"notification_deliveries_claim_idx",
				"integration_jobs_claim_idx",
				"outbox_events_claim_idx",
				"task_status_history_log_cursor_idx");
	}
}
