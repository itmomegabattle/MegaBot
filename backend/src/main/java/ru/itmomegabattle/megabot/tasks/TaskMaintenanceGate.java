package ru.itmomegabattle.megabot.tasks;

import org.springframework.jdbc.core.simple.JdbcClient;

/** Shared lock for commands, exclusive lock for bulk maintenance; acquire before any task row lock. */
final class TaskMaintenanceGate {
	private TaskMaintenanceGate() {}
	static void shared(JdbcClient jdbc) {
		jdbc.sql("select pg_advisory_xact_lock_shared(1296385863)").query().singleValue();
	}
	static void exclusive(JdbcClient jdbc) {
		jdbc.sql("select pg_advisory_xact_lock(1296385863)").query().singleValue();
	}
}
