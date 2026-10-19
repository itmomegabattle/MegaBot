package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties="megabot.auth.telegram.admin-telegram-ids=900003")
@Import(TestcontainersConfiguration.class) @ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TelegramStartIntegrationTests {
	@Autowired TelegramInbox inbox;@Autowired TelegramCommandWorker worker;
	@Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
	@BeforeEach void clear() { jdbc.execute("truncate telegram_inbox,outbox_events,bot_messages,chat_bindings,users cascade"); }
	void member(String id,Long telegram,String username,String role) {
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values (?,?,?,'Участник',?,?)",id,telegram,username,role,telegram!=null);
	}
	byte[] message(long update,long user,String username,String text) {
		return json.writeValueAsBytes(Map.of("update_id",update,"message",Map.of("message_id",update+1,"date",Instant.now().getEpochSecond(),
				"chat",Map.of("id",user,"type","private"),"from",Map.of("id",user,"is_bot",false,"first_name","Тест","username",username),"text",text)));
	}
	void start(long update,long user,String username) { inbox.accept("123",message(update,user,username,"/start"));assertThat(worker.processOne("123")).isTrue(); }
	int count(String table) { return jdbc.queryForObject("select count(*) from "+table,Integer.class); }
	String payload() { return jdbc.queryForObject("select payload::text from outbox_events",String.class); }
	@Test void invitedUserBindsOnlyOnceAndReplyIsDurableWithoutSessionOrProviderSend() {
		member("invited",null,"@Alice","organizer");start(1,42,"alice");
		assertThat(jdbc.queryForObject("select telegram_id from users where id='invited'",Long.class)).isEqualTo(42);
		assertThat(jdbc.queryForObject("select registered and joined_at is not null and last_seen_at is not null from users",Boolean.class)).isTrue();
		assertThat(count("sessions")).isZero();assertThat(count("chat_bindings")).isEqualTo(1);assertThat(count("bot_messages")).isEqualTo(1);
		assertThat(count("outbox_events")).isEqualTo(1);assertThat(payload()).contains("Профиль","Слоты","Встречи").doesNotContain("МФ");
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");
		assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("completed");
		assertThat(inbox.accept("123",message(1,42,"alice","/start"))).isFalse();assertThat(worker.processOne("123")).isFalse();
		assertThat(count("outbox_events")).isEqualTo(1);
	}
	@Test void unknownInactiveAndAmbiguousProfilesAreDeniedWithoutBindingsOrRegistration() {
		start(1,42,"unknown");assertThat(count("users")).isZero();assertThat(count("chat_bindings")).isZero();assertThat(payload()).contains("Вас нет в списке");
		clear();member("disabled",42L,"alice","organizer");jdbc.update("update users set active=false,deactivated_at=now() where id='disabled'");
		start(1,42,"alice");assertThat(count("chat_bindings")).isZero();assertThat(payload()).doesNotContain("Слоты");
		clear();member("first",null,"alice","organizer");member("second",null,"@alice","organizer");start(1,42,"alice");
		assertThat(jdbc.queryForObject("select count(*) from users where telegram_id is not null",Integer.class)).isZero();assertThat(count("chat_bindings")).isZero();
	}
	@Test void numericIdentityTakesPriorityOverUsernameAndOnlyConfiguredIdCanBootstrapAdmin() {
		member("bound",42L,"previous_name","organizer");member("invite",null,"newname","admin");start(1,42,"newname");
		assertThat(jdbc.queryForObject("select role from users where telegram_id=42",String.class)).isEqualTo("organizer");
		assertThat(jdbc.queryForObject("select telegram_id from users where id='invite'",Long.class)).isNull();assertThat(payload()).doesNotContain("МФ");
		clear();start(1,900003,"owner");assertThat(jdbc.queryForObject("select role from users",String.class)).isEqualTo("admin");
		assertThat(payload()).contains("МФ");assertThat(count("sessions")).isZero();
	}
	@Test void FacultyWelcomeDoesNotLeakCoreMenuAndBotsRemainScoped() {
		member("faculty",42L,"alice","faculty_helper");start(1,42,"alice");
		assertThat(payload()).contains("Мои задачи","Помощь").doesNotContain("Слоты","Встречи","МФ");
		inbox.accept("456",message(1,42,"alice","/start"));assertThat(worker.processOne("456")).isTrue();
		assertThat(count("chat_bindings")).isEqualTo(2);assertThat(count("outbox_events")).isEqualTo(2);
	}
	@Test void unsupportedCommandsAndCallbacksStayRetryableRatherThanBeingDiscarded() {
		inbox.accept("123",message(1,42,"alice","/not_implemented"));assertThat(worker.processOne("123")).isTrue();
		assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
		assertThat(jdbc.queryForObject("select last_error from telegram_inbox",String.class)).isEqualTo("unsupported_command");
		assertThat(count("outbox_events")).isZero();assertThat(worker.processOne("123")).isFalse();
	}
	@Test void malformedPrivateIdentityOrForwardedStartCannotBindOrReply() {
		member("invited",null,"alice","organizer");
		for(var field:Map.of("chat",Map.of("id",43,"type","private"),"from",Map.of("id",42,"is_bot",true,"first_name","Тест","username","alice"),
				"forward_origin",Map.of("type","user"),"message_id","1").entrySet()) {
			jdbc.execute("truncate telegram_inbox");var root=json.readTree(message(1,42,"alice","/start"));
			((tools.jackson.databind.node.ObjectNode)root.path("message")).set(field.getKey(),json.valueToTree(field.getValue()));
			inbox.accept("123",json.writeValueAsBytes(root));assertThat(worker.processOne("123")).isTrue();
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("failed");
		}
		assertThat(count("outbox_events")).isZero();assertThat(count("chat_bindings")).isZero();
		assertThat(jdbc.queryForObject("select telegram_id from users",Long.class)).isNull();
	}
	@Test void failingOutboxCommitRollsBackBindingRegistrationHistoryAndCompletion() {
		member("invited",null,"alice","organizer");
		jdbc.execute("alter table outbox_events add constraint fixture_reject_start_reply check (event_type<>'telegram_command_reply')");
		try {
			start(1,42,"alice");assertThat(count("outbox_events")).isZero();assertThat(count("bot_messages")).isZero();assertThat(count("chat_bindings")).isZero();
			assertThat(jdbc.queryForObject("select telegram_id from users",Long.class)).isNull();
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
			assertThat(jdbc.queryForObject("select last_error from telegram_inbox",String.class)).isEqualTo("command_processing_failed");
		} finally { jdbc.execute("alter table outbox_events drop constraint fixture_reject_start_reply"); }
		jdbc.update("update telegram_inbox set available_at=now()-interval '1 second'");assertThat(worker.processOne("123")).isTrue();
		assertThat(count("outbox_events")).isEqualTo(1);assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("completed");
	}
	@Test @Timeout(60) void competingUsersCannotBindTheSameInvitation() throws Exception {
		member("invited",null,"alice","organizer");inbox.accept("123",message(1,42,"alice","/start"));inbox.accept("456",message(1,43,"alice","/start"));
		try(var pool=Executors.newFixedThreadPool(2)) {
			var go=new CountDownLatch(1);var a=pool.submit(()->{go.await();return worker.processOne("123");});
			var b=pool.submit(()->{go.await();return worker.processOne("456");});go.countDown();
			assertThat(a.get(20,TimeUnit.SECONDS)).isTrue();assertThat(b.get(20,TimeUnit.SECONDS)).isTrue();
		}
		jdbc.update("update telegram_inbox set available_at=now()-interval '1 second' where status='retry'");worker.processOne("123");worker.processOne("456");
		assertThat(jdbc.queryForObject("select telegram_id from users",Long.class)).isIn(42L,43L);
		assertThat(count("chat_bindings")).isEqualTo(1);assertThat(count("outbox_events")).isEqualTo(2);
		assertThat(jdbc.queryForObject("select count(*) from telegram_inbox where status='completed'",Integer.class)).isEqualTo(2);
	}
}
