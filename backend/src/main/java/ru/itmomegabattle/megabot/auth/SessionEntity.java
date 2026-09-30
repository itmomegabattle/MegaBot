package ru.itmomegabattle.megabot.auth;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "sessions")
class SessionEntity {

	@Id
	@Column(name = "token_hash")
	private String tokenHash;

	@Column(name = "user_id", nullable = false)
	private String userId;

	@Column(name = "expires_at", nullable = false)
	private Instant expiresAt;

	@Column(name = "revoked_at")
	private Instant revokedAt;

	@Column(name = "created_at", nullable = false)
	private Instant createdAt;

	protected SessionEntity() {
	}

	SessionEntity(String tokenHash, String userId, Instant expiresAt, Instant createdAt) {
		this.tokenHash = tokenHash;
		this.userId = userId;
		this.expiresAt = expiresAt;
		this.createdAt = createdAt;
	}

	String userId() {
		return userId;
	}
}
