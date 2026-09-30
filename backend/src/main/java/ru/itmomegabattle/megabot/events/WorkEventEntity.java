package ru.itmomegabattle.megabot.events;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

@Entity
@Table(name = "work_events")
class WorkEventEntity {

	@Id
	private String id;

	@Column(nullable = false)
	private String name;

	private String description;

	@Column(name = "starts_at")
	private Instant startsAt;

	@Column(name = "ends_at")
	private Instant endsAt;

	@Column(nullable = false)
	private String status = "active";

	@Column(name = "created_by")
	private String createdBy;

	@Version
	@Column(nullable = false)
	private long version;

	@Column(name = "created_at", nullable = false, updatable = false)
	private Instant createdAt;

	@Column(name = "updated_at", nullable = false)
	private Instant updatedAt;

	protected WorkEventEntity() {
	}

	WorkEventEntity(String name, String description, Instant startsAt, Instant endsAt, String createdBy) {
		this.name = name;
		this.description = description;
		this.startsAt = startsAt;
		this.endsAt = endsAt;
		this.createdBy = createdBy;
	}

	@PrePersist
	void initialize() {
		if (id == null) {
			id = "evt_" + UUID.randomUUID();
		}
		var now = Instant.now();
		createdAt = now;
		updatedAt = now;
	}

	@PreUpdate
	void touch() {
		updatedAt = Instant.now();
	}

	void update(String name, String description, Instant startsAt, Instant endsAt) {
		this.name = name;
		this.description = description;
		this.startsAt = startsAt;
		this.endsAt = endsAt;
	}

	void archive() {
		this.status = "archived";
	}

	String id() { return id; }
	String name() { return name; }
	String description() { return description; }
	Instant startsAt() { return startsAt; }
	Instant endsAt() { return endsAt; }
	String status() { return status; }
	String createdBy() { return createdBy; }
	long version() { return version; }
}
