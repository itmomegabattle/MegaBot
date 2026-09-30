package ru.itmomegabattle.megabot.auth;

import java.time.Instant;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface SessionRepository extends JpaRepository<SessionEntity, String> {

	Optional<SessionEntity> findByTokenHashAndRevokedAtIsNullAndExpiresAtAfter(String tokenHash, Instant now);

	@Modifying
	@Query("update SessionEntity session set session.revokedAt = :now where session.userId = :userId and session.revokedAt is null")
	int revokeActiveByUserId(@Param("userId") String userId, @Param("now") Instant now);

	@Modifying
	@Query("update SessionEntity session set session.revokedAt = :now where session.tokenHash = :tokenHash and session.revokedAt is null")
	int revokeByTokenHash(@Param("tokenHash") String tokenHash, @Param("now") Instant now);
}
