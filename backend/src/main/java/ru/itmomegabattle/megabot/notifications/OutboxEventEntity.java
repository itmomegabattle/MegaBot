package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "outbox_events")
public class OutboxEventEntity {

	@Id
	private String id;

	@Column(name = "aggregate_type", nullable = false)
	private String aggregateType;

	@Column(name = "aggregate_id", nullable = false)
	private String aggregateId;

	@Column(name = "event_type", nullable = false)
	private String eventType;

	@Column(name = "dedupe_key", nullable = false, unique = true)
	private String dedupeKey;

	@JdbcTypeCode(SqlTypes.JSON)
	@Column(nullable = false, columnDefinition = "jsonb")
	private String payload;

	@Column(name = "available_at", nullable = false)
	private Instant availableAt;

	@Column(nullable = false)
	private String status;

	@Column(nullable = false)
	private int attempts;

	@Column(name = "created_at", nullable = false)
	private Instant createdAt;

	@Column(name = "updated_at", nullable = false)
	private Instant updatedAt;

	protected OutboxEventEntity() {
	}

	OutboxEventEntity(
			String id,
			String aggregateType,
			String aggregateId,
			String eventType,
			String dedupeKey,
			String payload,
			Instant availableAt) {
		this.id = id;
		this.aggregateType = aggregateType;
		this.aggregateId = aggregateId;
		this.eventType = eventType;
		this.dedupeKey = dedupeKey;
		this.payload = payload;
		this.availableAt = availableAt;
		this.status = "pending";
		this.attempts = 0;
		this.createdAt = Instant.now();
		this.updatedAt = createdAt;
	}

	public String getId() {
		return id;
	}
}
