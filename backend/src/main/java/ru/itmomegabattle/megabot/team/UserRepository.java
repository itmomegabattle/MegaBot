package ru.itmomegabattle.megabot.team;

import java.util.List;
import java.util.Optional;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;

import jakarta.persistence.LockModeType;

public interface UserRepository extends JpaRepository<UserEntity, String> {

	Page<UserEntity> findByActiveTrue(Pageable pageable);

	Optional<UserEntity> findByTelegramId(Long telegramId);

	List<UserEntity> findByUsernameIgnoreCaseAndTelegramIdIsNullAndActiveTrue(String username);

	long countByRoleAndActiveTrue(String role);

	boolean existsByTelegramId(Long telegramId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	List<UserEntity> findByRoleAndActiveTrue(String role);
}
