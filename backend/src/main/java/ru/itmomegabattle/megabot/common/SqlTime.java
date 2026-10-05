package ru.itmomegabattle.megabot.common;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;

/** PostgreSQL JDBC accepts OffsetDateTime for timestamptz, not an untyped Instant. */
public final class SqlTime {
	private SqlTime() {}
	public static OffsetDateTime of(Instant value) {
		return value==null?null:value.atOffset(ZoneOffset.UTC);
	}
}
