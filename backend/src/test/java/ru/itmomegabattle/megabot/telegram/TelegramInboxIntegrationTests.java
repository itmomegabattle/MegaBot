package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.common.ApiException;

@SpringBootTest @Import(TestcontainersConfiguration.class) @ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
class TelegramInboxIntegrationTests {
	@Autowired TelegramInbox inbox;@Autowired JdbcTemplate jdbc;@Autowired PlatformTransactionManager transactions;
	@BeforeEach void clear() { jdbc.execute("truncate telegram_inbox"); }
	byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
	byte[] message(long id) { return bytes("{\"update_id\":"+id+",\"message\":{\"chat\":{\"id\":5101},\"text\":\"/start\"}}"); }
	long count() { return jdbc.queryForObject("select count(*) from telegram_inbox",Long.class); }
	@Test void receiptIsCommittedBeforeReturnAndSurvivesCallerRollback() {
		new TransactionTemplate(transactions).executeWithoutResult(tx->{
			assertThat(inbox.accept("123",message(1))).isTrue();tx.setRollbackOnly();
		});
		assertThat(count()).isEqualTo(1);
		assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("received");
		assertThat(jdbc.queryForObject("select attempts from telegram_inbox",Integer.class)).isZero();
	}
	@Test void duplicateDoesNotOverwritePayloadOrCompletedStateAndBotScopeIsSeparate() {
		assertThat(inbox.accept("123",message(1))).isTrue();
		jdbc.update("update telegram_inbox set status='completed',processed_at=now(),attempts=1");
		assertThat(inbox.accept("123",bytes("{\"update_id\":1,\"message\":{\"text\":\"CHANGED\"}}"))).isFalse();
		assertThat(jdbc.queryForObject("select payload->'message'->>'text' from telegram_inbox",String.class)).isEqualTo("/start");
		assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("completed");
		assertThat(inbox.accept("456",message(1))).isTrue();assertThat(count()).isEqualTo(2);
	}
	@Test @Timeout(60) void concurrentRetriesHaveExactlyOneDurableReceipt() throws Exception {
		try(var pool=Executors.newFixedThreadPool(4)) {
			var ready=new CountDownLatch(4);var go=new CountDownLatch(1);
			var results=new java.util.ArrayList<Future<Boolean>>();
			for(int i=0;i<4;i++) results.add(pool.submit(()->{ready.countDown();assertThat(go.await(10,TimeUnit.SECONDS)).isTrue();return inbox.accept("123",message(1));}));
			try { assertThat(ready.await(10,TimeUnit.SECONDS)).isTrue(); } finally { go.countDown(); }
			int inserted=0;for(var result:results) if(result.get(20,TimeUnit.SECONDS)) inserted++;
			assertThat(inserted).isEqualTo(1);assertThat(count()).isEqualTo(1);
		}
	}
	@Test void groupCallbackKeepsTopicAndLargeNegativeChatWithoutMixingBotIdentity() {
		var payload=bytes("{\"update_id\":2,\"callback_query\":{\"id\":\"cb\",\"from\":{\"id\":5101},\"message\":{\"chat\":{\"id\":-1001234567890},\"message_thread_id\":77},\"data\":\"task_claim:fixture\"}}");
		inbox.accept("123",payload);
		assertThat(jdbc.queryForObject("select chat_key from telegram_inbox",String.class)).isEqualTo("123:chat:-1001234567890");
		assertThat(jdbc.queryForObject("select (payload->'callback_query'->'message'->>'message_thread_id')::int from telegram_inbox",Integer.class)).isEqualTo(77);
		assertThat(jdbc.queryForObject("select payload->'callback_query'->>'id' from telegram_inbox",String.class)).isEqualTo("cb");
	}
	@Test void inlineCallbackAndUnknownUpdatesArePreservedWithoutInventedChat() {
		inbox.accept("123",bytes("{\"update_id\":3,\"callback_query\":{\"id\":\"cb\",\"from\":{\"id\":5101},\"inline_message_id\":\"inline\"}}"));
		inbox.accept("123",bytes("{\"update_id\":4,\"future_update\":{\"unknown\":true}}"));
		assertThat(jdbc.queryForList("select chat_key from telegram_inbox order by update_id",String.class)).containsExactly("123:user:5101","123:unscoped");
		assertThat(jdbc.queryForObject("select payload->'future_update'->>'unknown' from telegram_inbox where update_id=4",String.class)).isEqualTo("true");
	}
	@Test void invalidEnvelopesNeverPersistAndErrorsDoNotEchoInput() {
		for(var body:java.util.List.of("null","[]","{}","{\"update_id\":-1}","{\"update_id\":1.5}","{\"update_id\":\"1\"}","{\"update_id\":9223372036854775808}","{\"update_id\":1} {}","SECRET_BROKEN_PAYLOAD")) {
			assertThatThrownBy(()->inbox.accept("123",bytes(body))).isInstanceOfSatisfying(ApiException.class,e->{
				assertThat(e.code()).isEqualTo("invalid_telegram_update");assertThat(e.getMessage()).doesNotContain("SECRET_");assertThat(e.getCause()).isNull();
			});
		}
		assertThat(count()).isZero();
	}
	@Test void oversizeAndInvalidConfiguredBotAreRejectedWithoutWrites() {
		assertThatThrownBy(()->inbox.accept("123",new byte[TelegramInbox.MAX_UPDATE_BYTES+1])).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.status()).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE));
		assertThatThrownBy(()->inbox.accept("SECRET_TOKEN:abc",message(1))).isInstanceOf(IllegalArgumentException.class).hasMessage("Invalid configured bot ID");
		assertThat(count()).isZero();
	}
	@Test void databaseRejectsWriteWithoutReceiptAndRetryWorksAfterConstraintIsRemoved() {
		jdbc.execute("alter table telegram_inbox add constraint fixture_reject_inbox check (bot_id<>'123')");
		try {
			assertThatThrownBy(()->inbox.accept("123",message(1))).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
			assertThat(count()).isZero();
		} finally { jdbc.execute("alter table telegram_inbox drop constraint fixture_reject_inbox"); }
		assertThat(inbox.accept("123",message(1))).isTrue();assertThat(count()).isEqualTo(1);
	}
}
