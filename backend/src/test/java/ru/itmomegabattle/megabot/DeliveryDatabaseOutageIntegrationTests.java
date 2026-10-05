package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;

/** Real network outage, confined to this context's disposable PostgreSQL container. */
@Import(TestcontainersConfiguration.class)
@SpringBootTest(properties={"spring.datasource.hikari.data-source-properties.socketTimeout=1",
		"spring.datasource.hikari.data-source-properties.connectTimeout=1",
		"spring.datasource.hikari.connection-timeout=1000", "spring.datasource.hikari.validation-timeout=500",
		"spring.datasource.hikari.maximum-pool-size=2", "spring.datasource.hikari.minimum-idle=0"})
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class DeliveryDatabaseOutageIntegrationTests {
	@Autowired PostgreSQLContainer postgres;
	@Autowired JdbcTemplate jdbc; @Autowired DeliveryQueue queue; @Autowired DeliveryQuota quota;
	@Autowired ObjectMapper json; @Autowired PlatformTransactionManager manager;
	AtomicInteger accepted; String id;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,broadcasts,notification_deliveries,delivery_rate_limits cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',4100,'author','Автор','organizer',true),('r',4101,'recipient','Адресат','organizer',true)");
		accepted=new AtomicInteger();id=delivery();
	}
	String delivery() {
		return new TransactionTemplate(manager).execute(s->{
			var b="outage_"+UUID.randomUUID(); var t="target_"+UUID.randomUUID();
			var due=jdbc.queryForObject("select clock_timestamp() - interval '1 second'",java.sql.Timestamp.class).toInstant();
			jdbc.update("insert into broadcasts(id,author_id,content,scheduled_at,misfire_policy,expires_at,status) values (?,'a','Текст',?,'send_within_grace',?,'scheduled')",b,java.sql.Timestamp.from(due),java.sql.Timestamp.from(due.plusSeconds(900)));
			jdbc.update("insert into broadcast_targets(id,broadcast_id,revision,target_key,recipient_id,chat_id) values (?,?,1,'user:r','r',4101)",t,b);
			var result=queue.enqueue(new DeliveryQueue.NewDelivery(b,b,"broadcast","r",4101,null,"{\"text\":\"Проверка outage\"}",true,due,due,due.plusSeconds(900)));
			jdbc.update("update notification_deliveries set broadcast_target_id=? where id=?",t,result);return result;
		});
	}
	BroadcastDispatcher worker(TelegramTransport transport) {
		return new BroadcastDispatcher(queue,quota,transport,json,"12345",DeliveryQuota.Limits.defaults());
	}
	TelegramTransport.Outcome accept(TelegramTransport.Message message) {
		assertThat(message.chatId()).isEqualTo(4101);accepted.incrementAndGet();return TelegramTransport.Outcome.sent(81);
	}
	void pause() {
		postgres.getDockerClient().pauseContainerCmd(postgres.getContainerId()).exec();
		assertThat(postgres.getDockerClient().inspectContainerCmd(postgres.getContainerId()).exec().getState().getPaused()).isTrue();
	}
	@AfterEach void restoreDatabase() {
		if(Boolean.TRUE.equals(postgres.getDockerClient().inspectContainerCmd(postgres.getContainerId()).exec().getState().getPaused()))
			postgres.getDockerClient().unpauseContainerCmd(postgres.getContainerId()).exec();
	}
	void failsBoundedly(Runnable command) {
		var start=Instant.now();
		assertThatThrownBy(command::run).isInstanceOf(org.springframework.dao.DataAccessException.class);
		assertThat(Duration.between(start,Instant.now())).isLessThan(Duration.ofSeconds(10));
	}
	String status() { return jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,id); }
	void expireLease() {
		// Advance only this test row's lease deadline; the outage itself is real, not a fake SQL exception.
		jdbc.update("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second' where id=?",id);
	}
	@Test void outageBeforeClaimPreservesIntentAndNextCycleRecoversWithoutDuplicate() {
		var worker=worker(this::accept);pause();
		try { failsBoundedly(()->worker.dispatchOne());assertThat(accepted).hasValue(0);
			assertThat(worker.workerStatus().lastOutcome()).isEqualTo("error");
			assertThat(worker.workerStatus().consecutiveFailures()).isEqualTo(1);
		}finally { restoreDatabase(); }
		assertThat(status()).isEqualTo("planned");
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		assertThat(worker.dispatchOne()).isTrue();assertThat(status()).isEqualTo("sent");
		assertThat(worker.workerStatus().lastOutcome()).isEqualTo("processed");
		assertThat(worker.workerStatus().consecutiveFailures()).isZero();
		assertThat(worker.dispatchOne()).isFalse();assertThat(accepted).hasValue(1);
	}
	@Test void outageAfterClaimBeforeStartRecoversOnlyUnstartedLeaseAndRejectsOldToken() {
		var lease=queue.claimBroadcasts(1,Duration.ofSeconds(30)).getFirst();pause();
		try { failsBoundedly(()->queue.start(id,lease.token())); }finally { restoreDatabase(); }
		assertThat(status()).isEqualTo("claimed");
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
		expireLease();assertThat(queue.recoverExpiredLeases()).isEqualTo(1);
		assertThat(queue.start(id,lease.token())).isFalse();assertThat(status()).isEqualTo("planned");
		var worker=worker(this::accept);assertThat(worker.dispatchOne()).isTrue();
		assertThat(worker.dispatchOne()).isFalse();assertThat(status()).isEqualTo("sent");assertThat(accepted).hasValue(1);
		assertThat(jdbc.queryForObject("select attempts from notification_deliveries where id=?",Integer.class,id)).isEqualTo(1);
	}
	@Test void expiredIntentAfterOutageIsNotReplayedOnDatabaseRecovery() {
		var worker=worker(this::accept);pause();
		try { failsBoundedly(()->worker.dispatchOne()); }finally { restoreDatabase(); }
		// Model a grace window elapsed during the outage without a 15-minute wall-clock wait.
		jdbc.update("update notification_deliveries set intended_at=clock_timestamp()-interval '16 minutes',available_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=?",id);
		assertThat(worker.dispatchOne()).isFalse();assertThat(status()).isEqualTo("expired");
		assertThat(worker.dispatchOne()).isFalse();assertThat(accepted).hasValue(0);
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
	}
	@Test void outageAfterProviderAcceptanceLeavesUnknownAndNeverResendsSuccessfulOtherTarget() {
		var successful=id;assertThat(worker(this::accept).dispatchOne()).isTrue();
		assertThat(status()).isEqualTo("sent");id=delivery();jdbc.execute("truncate delivery_rate_limits");
		var worker=worker(message->{var result=accept(message);pause();return result;});
		try { failsBoundedly(()->worker.dispatchOne()); }finally { restoreDatabase(); }
		assertThat(accepted).hasValue(2);assertThat(status()).isEqualTo("sending");
		assertThat(jdbc.queryForObject("select result_status from delivery_attempts where delivery_id=?",String.class,id)).isEqualTo("sending");
		expireLease();assertThat(queue.recoverExpiredLeases()).isEqualTo(1);assertThat(status()).isEqualTo("unknown");
		assertThat(jdbc.queryForObject("select last_error_code from notification_deliveries where id=?",String.class,id)).isEqualTo("lease_expired_after_start");
		assertThat(jdbc.queryForObject("select result_status from delivery_attempts where delivery_id=?",String.class,id)).isEqualTo("unknown");
		assertThat(worker(this::accept).dispatchOne()).isFalse();assertThat(accepted).hasValue(2);
		assertThat(jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,successful)).isEqualTo("sent");
		assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries where id=?",Long.class,successful)).isEqualTo(81);
	}
}
