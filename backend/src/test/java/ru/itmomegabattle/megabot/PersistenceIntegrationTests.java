package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.data.domain.PageRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;

import ru.itmomegabattle.megabot.notifications.OutboxWriter;
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.team.UserEntity;
import ru.itmomegabattle.megabot.team.UserRepository;

@Import(TestcontainersConfiguration.class)
@SpringBootTest
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker = true)
class PersistenceIntegrationTests {

	@Autowired
	private Flyway flyway;

	@Autowired
	private JdbcTemplate jdbc;

	@Autowired
	private UserRepository users;

	@Autowired
	private OutboxWriter outboxWriter;

	@Autowired
	private SessionService sessionService;

	@Autowired
	private PlatformTransactionManager transactionManager;

	private TransactionTemplate transactions;

	@BeforeEach
	void cleanDatabase() {
		transactions = new TransactionTemplate(transactionManager);
		jdbc.execute("TRUNCATE TABLE outbox_events, sessions, users CASCADE");
	}

	@Test
	void migrationsAreRepeatableWithoutPendingChanges() {
		flyway.validate();
		assertThat(flyway.migrate().migrationsExecuted).isZero();
	}

	@Test
	void uniqueTelegramIdIsEnforcedByPostgres() {
		insertUser("u_one", 1001L);

		assertThatThrownBy(() -> insertUser("u_two", 1001L))
				.isInstanceOf(DataIntegrityViolationException.class);
	}

	@Test
	void invalidEventIntervalIsRejectedByPostgres() {
		assertThatThrownBy(() -> transactions.executeWithoutResult(status -> jdbc.update("""
				INSERT INTO work_events (id, name, starts_at, ends_at, status)
				VALUES ('event_invalid', 'Invalid', ?::timestamptz, ?::timestamptz, 'active')
				""", "2030-01-02T12:00:00Z", "2030-01-02T11:00:00Z")))
				.isInstanceOf(DataIntegrityViolationException.class);
	}

	@Test
	void repositoryPaginatesActiveUsers() {
		transactions.executeWithoutResult(status -> {
			users.save(new UserEntity(2001L, "one", "One", "organizer"));
			users.save(new UserEntity(2002L, "two", "Two", "organizer"));
			users.save(new UserEntity(2003L, "three", "Three", "organizer"));
		});

		var page = users.findByActiveTrue(PageRequest.of(0, 2));

		assertThat(page.getTotalElements()).isEqualTo(3);
		assertThat(page.getContent()).hasSize(2);
	}

	@Test
	void staleAggregateVersionIsRejected() {
		var userId = transactions.execute(status ->
				users.saveAndFlush(new UserEntity(3001L, "versioned", "Initial", "organizer")).getId());
		var firstCopy = transactions.execute(status -> users.findById(userId).orElseThrow());
		var staleCopy = transactions.execute(status -> users.findById(userId).orElseThrow());

		firstCopy.rename("First update");
		transactions.executeWithoutResult(status -> users.saveAndFlush(firstCopy));
		staleCopy.rename("Stale update");

		assertThatThrownBy(() -> transactions.executeWithoutResult(status -> users.saveAndFlush(staleCopy)))
				.isInstanceOf(ObjectOptimisticLockingFailureException.class);
	}

	@Test
	void outboxWriteRollsBackWithDomainTransaction() {
		transactions.executeWithoutResult(status -> {
			outboxWriter.write(
					"task",
					"t_synthetic",
					"task.created",
					"task:t_synthetic:created:1",
					"{\"taskId\":\"t_synthetic\"}",
					Instant.parse("2030-01-02T12:00:00Z"));
			status.setRollbackOnly();
		});

		assertThat(jdbc.queryForObject("SELECT count(*) FROM outbox_events", Long.class)).isZero();
	}

	@Test
	void sessionStoresOnlyHashAndCanBeRevoked() {
		var userId = transactions.execute(status ->
				users.saveAndFlush(new UserEntity(4001L, "session-user", "Session User", "organizer")).getId());

		var created = sessionService.rotateFor(userId);

		assertThat(jdbc.queryForObject(
				"SELECT count(*) FROM sessions WHERE token_hash = ?",
				Long.class,
				created.rawToken())).isZero();
		assertThat(jdbc.queryForObject(
				"SELECT count(*) FROM sessions WHERE token_hash = ?",
				Long.class,
				SessionService.hash(created.rawToken()))).isEqualTo(1L);
		assertThat(sessionService.authenticate(created.rawToken())).isPresent();

		sessionService.revoke(created.rawToken());

		assertThat(sessionService.authenticate(created.rawToken())).isEmpty();
	}

	private void insertUser(String id, long telegramId) {
		transactions.executeWithoutResult(status -> jdbc.update("""
				INSERT INTO users (id, telegram_id, username, real_name, role, registered, active)
				VALUES (?, ?, ?, ?, 'organizer', true, true)
				""", id, telegramId, id, id));
	}
}
