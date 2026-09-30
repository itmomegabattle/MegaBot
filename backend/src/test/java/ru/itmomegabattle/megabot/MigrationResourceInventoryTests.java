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
			"V006__b04_catalog_versions.sql"
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
				"CREATE TABLE broadcasts",
				"CREATE TABLE notification_deliveries",
				"CREATE TABLE integration_jobs",
				"CREATE TABLE idempotency_requests",
				"CREATE TABLE outbox_events",
				"CREATE TABLE migration_runs",
				"notification_deliveries_claim_idx",
				"integration_jobs_claim_idx",
				"outbox_events_claim_idx");
	}
}
