package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest @Import(TestcontainersConfiguration.class) @ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class TelegramReplyDeliveryIntegrationTests {
	@Autowired TelegramInbox inbox;@Autowired TelegramCommandWorker commands;@Autowired TelegramReplyPlanner planner;
	@Autowired DeliveryQueue queue;@Autowired DeliveryQuota quota;@Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
	@BeforeEach void clear() {
		jdbc.execute("truncate telegram_inbox,outbox_events,bot_messages,chat_bindings,users,competencies,delivery_rate_limits cascade");
	}
	void member(String role) { jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('member',42,'alice','Участник',?,true)",role); }
	void start() { command("/start"); }
	void command(String text) {
		inbox.accept("123",json.writeValueAsBytes(Map.of("update_id",1,"message",Map.of("message_id",2,"date",Instant.now().getEpochSecond(),
				"chat",Map.of("id",42,"type","private"),"from",Map.of("id",42,"is_bot",false,"first_name","Тест","username","alice"),"text",text))));
		assertThat(commands.processOne("123")).isTrue();
	}
	BroadcastDispatcher sender(TelegramTransport transport,String bot) {
		return new BroadcastDispatcher(queue,quota,transport,json,bot,new DeliveryQuota.Limits(20,1,20),null,null,Clock.systemUTC(),null,null,null,null,planner);
	}
	int count(String table) { return jdbc.queryForObject("select count(*) from "+table,Integer.class); }
	String status() { return jdbc.queryForObject("select status from notification_deliveries",String.class); }
	void due() { jdbc.update("update notification_deliveries set available_at=clock_timestamp()-interval '1 second'");jdbc.execute("truncate delivery_rate_limits"); }
	@Test void helpAliasesPreserveRoleSpecificTextKeyboardAndConfirmedHistory() {
		for(var role:java.util.List.of("admin","organizer","faculty_helper","faculty_responsible"))for(var input:java.util.List.of("Помощь"," /HELP \n")) {
			clear();member(role);command(input);assertThat(count("bot_messages")).isEqualTo(1);
			assertThat(jdbc.queryForObject("select payload->>'command' from outbox_events",String.class)).isEqualTo("help");
			var captured=new AtomicReference<TelegramTransport.Message>();assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(11);},"123").dispatchOne()).isTrue();
			var reply=captured.get();assertThat(status()).isEqualTo("sent");assertThat(count("bot_messages")).isEqualTo(2);assertThat(count("sessions")).isZero();
			if(role.startsWith("faculty_")) {
				assertThat(reply.text()).startsWith("Здесь ты получаешь задачи").doesNotContain("Слоты","/all","МФ");
				assertThat(reply.keyboard().rows()).containsExactly(java.util.List.of("Мои задачи","Помощь"));
			}else {
				assertThat(reply.text()).startsWith("Что умеет бот").contains("Профиль","Слоты","/checkin").doesNotContain("*Профиль*");
				assertThat(reply.text().contains("МФ —")).isEqualTo(role.equals("admin"));
				assertThat(reply.keyboard().rows().get(1).contains("МФ")).isEqualTo(role.equals("admin"));
			}
		}
	}
	@Test void menuRestoresRoleSpecificRootWithoutImplementingDialogBack() {
		for(var role:java.util.List.of("faculty_helper","faculty_responsible")) {
			clear();member(role);command("  МЕНЮ  ");var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(12);},"123").dispatchOne()).isTrue();
			assertThat(jdbc.queryForObject("select payload->>'command' from outbox_events",String.class)).isEqualTo("menu");
			assertThat(captured.get().text()).startsWith(role.startsWith("faculty_")?"Меню задач.":"Привет, Участник!");
			assertThat(captured.get().keyboard().rows().getFirst()).isEqualTo(role.startsWith("faculty_")?java.util.List.of("Мои задачи","Помощь"):java.util.List.of("Профиль","Слоты","Встречи"));
		}
	}
	@Test void unknownOrInactiveHelpAndMenuNeverRevealMemberDataOrRegisterUser() {
		for(var input:java.util.List.of("/help","Помощь","Меню","Профиль"))for(var inactive:java.util.List.of(false,true)) {
			clear();if(inactive) { member("admin");jdbc.execute("update users set active=false,deactivated_at=now(),registered=false"); }
			command(input);var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(13);},"123").dispatchOne()).isTrue();
			assertThat(captured.get().text()).startsWith("Вас нет в списке").doesNotContain("Участник","/all","МФ");
			assertThat(captured.get().keyboard().rows()).containsExactly(java.util.List.of("Помощь"));assertThat(count("chat_bindings")).isZero();assertThat(count("bot_messages")).isZero();
			assertThat(jdbc.queryForObject("select count(*) from users where registered",Integer.class)).isZero();
		}
	}
	@Test void prefixLookalikesMentionsDialogBackAndUnknownCommandsRemainRetryable() {
		for(var text:java.util.List.of("/helpme","/help payload","/help@other_bot","/starter","Назад","/menu","/profile","Профиль чужого")) {
			clear();member("organizer");command(text);assertThat(count("outbox_events")).isZero();assertThat(count("bot_messages")).isZero();
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
			assertThat(jdbc.queryForObject("select last_error from telegram_inbox",String.class)).isEqualTo("unsupported_command");
		}
	}
	@Test void helpRollsBackWithOutboxAndReplayCreatesOneReplyWhileStaleRoleCancelsSend() {
		member("admin");jdbc.execute("alter table outbox_events add constraint fixture_reject_help check(payload->>'command'<>'help')");
		try {
			command("/help");assertThat(count("outbox_events")).isZero();assertThat(count("bot_messages")).isZero();assertThat(count("chat_bindings")).isZero();
			assertThat(jdbc.queryForObject("select last_seen_at from users",java.sql.Timestamp.class)).isNull();
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
		}finally { jdbc.execute("alter table outbox_events drop constraint fixture_reject_help"); }
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second'");assertThat(commands.processOne("123")).isTrue();
		assertThat(inbox.accept("123",jdbc.queryForObject("select payload::text from telegram_inbox",String.class).getBytes(java.nio.charset.StandardCharsets.UTF_8))).isFalse();
		assertThat(commands.processOne("123")).isFalse();assertThat(count("outbox_events")).isEqualTo(1);assertThat(count("bot_messages")).isEqualTo(1);
		planner.materialize(20,"123");jdbc.execute("update users set role='organizer'");
		assertThat(sender(m->{throw new AssertionError("old_admin_help_sent");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");
	}
	@Test void replyCommandMustMatchPersistedInputRatherThanAnotherSupportedCommand() {
		member("faculty_helper");command("Помощь");
		jdbc.execute("update outbox_events set payload=jsonb_set(payload,'{command}','\"menu\"')");
		assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
		assertThat(jdbc.queryForObject("select last_error_code from outbox_events",String.class)).isEqualTo("invalid_command_reply");
	}
	@Test void profileAndCoreMenuShowOnlyOwnRealStatisticsAndRoleKeyboard() {
		for(var role:java.util.List.of("admin","organizer","faculty_helper","faculty_responsible")) {
			clear();member(role);
			jdbc.execute("insert into users(id,username,real_name,role) values ('other','otheruser','Другой','organizer')");
			jdbc.execute("update users set birthday_day=10,birthday_month=5,birthday_year=2000 where id='member'");
			jdbc.execute("insert into competencies(id,name,scope) values ('block','Дизайн','core')");
			jdbc.execute("insert into user_competencies(user_id,competency_id,is_primary) values ('member','block',true)");
			jdbc.execute("insert into tasks(id,title,priority,status,completed_at) values ('active','Личная','normal','assigned',null),('done','Готовая','normal','completed',now()),('foreign','Чужая','normal','assigned',null)");
			jdbc.execute("insert into tasks(id,title,priority,status,cancelled_at) values ('cancel','Отмена','normal','cancelled',now())");
			jdbc.execute("insert into task_assignees(task_id,user_id) values ('active','member'),('done','member'),('cancel','member'),('foreign','other')");
			jdbc.execute("insert into meetings(id,kind,title,starts_at,duration_minutes,zone_id,host_id,audience_mode,status) values ('mine','meeting','Личная встреча',now()+interval '1 day',60,'Europe/Moscow','member','selected','scheduled'),('foreign','meeting','Секретная встреча',now()+interval '1 hour',60,'Europe/Moscow','other','selected','scheduled'),('past','meeting','Старая',now()-interval '2 hours',60,'Europe/Moscow','member','selected','scheduled')");
			jdbc.execute("insert into meeting_invitations(meeting_id,user_id) values ('mine','member'),('past','member'),('foreign','other')");
			jdbc.execute("insert into availability_weeks(id,user_id,week_start) values ('week','member',date_trunc('week',now() at time zone 'Europe/Moscow')::date),('old','member',date_trunc('week',now() at time zone 'Europe/Moscow')::date-7)");
			jdbc.execute("insert into availability_days(id,week_id,week_start,day_date,status) select id,id,week_start,week_start,'available' from availability_weeks");
			jdbc.execute("insert into availability_slots(day_id,start_minute) values ('week',600),('week',660),('old',600)");
			command(role.startsWith("faculty_")?" Профиль ":"Меню");var captured=new AtomicReference<TelegramTransport.Message>();
			assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(90);},"123").dispatchOne()).isTrue();
			assertThat(captured.get().text()).startsWith("Участник\n@alice").contains("Главный блок: Дизайн","Дата рождения: 10.05.2000","активных задач — 1","выполнено задач — 1","ближайших встреч — 1","свободных часов отмечено — 2","Личная встреча").doesNotContain("Секретная","Чужая","Старая","*Участник*");
			assertThat(captured.get().keyboard().rows().getFirst()).contains("Профиль");
			assertThat(captured.get().keyboard().rows().toString().contains("МФ")).isEqualTo(role.equals("admin"));
			assertThat(count("sessions")).isZero();assertThat(count("bot_messages")).isEqualTo(2);
		}
	}
	@Test void emptyOwnProfileHasNoInventedDataAndReplayProducesOneReply() {
		member("organizer");command("ПРОФИЛЬ");
		assertThat(inbox.accept("123",jdbc.queryForObject("select payload::text from telegram_inbox",String.class).getBytes(java.nio.charset.StandardCharsets.UTF_8))).isFalse();
		assertThat(commands.processOne("123")).isFalse();var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(91);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().text()).contains("Главный блок: не выбран","Дата рождения: не указана","активных задач — 0","выполнено задач — 0","ближайших встреч — 0","свободных часов отмечено — 0").doesNotContain("Следующая встреча","До дня рождения");
		assertThat(count("outbox_events")).isEqualTo(1);assertThat(count("notification_deliveries")).isEqualTo(1);
	}
	@Test void profileEditAfterMaterializationOrAtFinalGateCancelsOldPrivateSnapshot() {
		for(var finalGate:java.util.List.of(false,true)) {
			clear();member("organizer");command("Профиль");planner.materialize(20,"123");
			if(finalGate) {
				var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
				jdbc.execute("update users set version=version+1,real_name='Новое имя'");
				assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();
			} else {
				jdbc.execute("update users set version=version+1");
				assertThat(sender(m->{throw new AssertionError("old_profile_sent");},"123").dispatchOne()).isTrue();
			}
			assertThat(status()).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
		}
	}
	@Test void profileBirthdayUsesMoscowDateAndOwnYearOnly() {
		member("organizer");
		jdbc.execute("update users set birthday_day=extract(day from now() at time zone 'Europe/Moscow'),birthday_month=extract(month from now() at time zone 'Europe/Moscow'),birthday_year=2000");
		command("Профиль");var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(92);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().text()).contains("До дня рождения: сегодня",".2000 · ");
	}
	@Test void profileOutboxFailureRollsBackAndMissingVersionCannotSend() {
		member("organizer");jdbc.execute("alter table outbox_events add constraint fixture_reject_profile check(payload->>'command'<>'profile')");
		try {
			command("Профиль");assertThat(count("outbox_events")).isZero();assertThat(count("bot_messages")).isZero();assertThat(count("chat_bindings")).isZero();
			assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("retry");
		}finally { jdbc.execute("alter table outbox_events drop constraint fixture_reject_profile"); }
		jdbc.execute("update telegram_inbox set available_at=clock_timestamp()-interval '1 second'");assertThat(commands.processOne("123")).isTrue();
		jdbc.execute("update outbox_events set payload=payload-'profileVersion'");
		assertThat(sender(m->{throw new AssertionError("unversioned_profile_sent");},"123").dispatchOne()).isTrue();
		assertThat(status()).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test void authenticatedReplyUsesExistingSenderAndConfirmedHistoryOnlyOnce() {
		member("admin");start();assertThat(count("bot_messages")).isEqualTo(1);
		assertThat(planner.materialize(20,"456")).isZero();assertThat(planner.materialize(20,"123")).isEqualTo(1);
		assertThat(planner.materialize(20,"123")).isZero();assertThat(count("notification_deliveries")).isEqualTo(1);
		assertThat(queue.claimSupported(1,Duration.ofSeconds(30),"456")).isEmpty();assertThat(queue.claimSupported(1,Duration.ofSeconds(30))).isEmpty();
		assertThat(queue.claim(1,Duration.ofSeconds(30))).isEmpty();
		var captured=new AtomicReference<TelegramTransport.Message>();var calls=new AtomicInteger();
		var worker=sender(m->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();captured.set(m);calls.incrementAndGet();return TelegramTransport.Outcome.sent(77);},"123");
		assertThat(worker.dispatchOne()).isTrue();assertThat(worker.dispatchOne()).isFalse();assertThat(calls).hasValue(1);
		assertThat(captured.get().keyboard().rows().get(1)).contains("МФ");assertThat(captured.get().chatId()).isEqualTo(42);
		assertThat(status()).isEqualTo("sent");assertThat(count("bot_messages")).isEqualTo(2);
		assertThat(jdbc.queryForObject("select buttons->'keyboard' is not null from bot_messages where sender='bot'",Boolean.class)).isTrue();
		assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries",Long.class)).isEqualTo(77);
	}
	@Test void unknownUserReceivesOnlyHelpAndNoMemberHistory() {
		start();var captured=new AtomicReference<TelegramTransport.Message>();
		assertThat(sender(m->{captured.set(m);return TelegramTransport.Outcome.sent(9);},"123").dispatchOne()).isTrue();
		assertThat(captured.get().keyboard().rows()).containsExactly(java.util.List.of("Помощь"));assertThat(captured.get().text()).contains("Вас нет в списке");
		assertThat(status()).isEqualTo("sent");assertThat(count("bot_messages")).isZero();assertThat(count("users")).isZero();
	}
	@Test void revokedRoleIdentityOrPrivateBindingCancelsWithoutHttp() {
		for(var change:java.util.List.of("update users set role='organizer'","update users set active=false,deactivated_at=now()",
				"update users set telegram_id=43","delete from chat_bindings")) {
			clear();member("admin");start();assertThat(planner.materialize(20,"123")).isEqualTo(1);jdbc.execute(change);
			assertThat(sender(m->{throw new AssertionError("stale_menu_sent");},"123").dispatchOne()).isTrue();
			assertThat(status()).isEqualTo("cancelled");assertThat(count("delivery_attempts")).isZero();assertThat(count("bot_messages")).isEqualTo(1);
		}
	}
	@Test void denialBecomesStaleAfterAdmissionAndCannotBeRedirectedToAnotherChat() {
		start();planner.materialize(20,"123");member("organizer");
		assertThat(sender(m->{throw new AssertionError("old_denial_sent");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");
		clear();member("organizer");start();planner.materialize(20,"123");jdbc.execute("update notification_deliveries set chat_id=43");
		assertThat(sender(m->{throw new AssertionError("redirected_reply");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");
	}
	@Test void replyExpiryUsesOriginalDueAndIncompleteSourceNeverSends() {
		member("organizer");start();jdbc.execute("update outbox_events set available_at=clock_timestamp()-interval '16 minutes'");
		assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select last_error_code from outbox_events",String.class)).isEqualTo("command_reply_expired");
		clear();member("organizer");start();jdbc.execute("update telegram_inbox set status='retry'");
		assertThat(planner.materialize(20,"123")).isZero();jdbc.execute("update telegram_inbox set status='completed'");planner.materialize(20,"123");
		jdbc.execute("update outbox_events set status='pending'");
		assertThat(sender(m->{throw new AssertionError("incomplete_source_sent");},"456").dispatchOne()).isFalse();
		var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isFalse();assertThat(status()).isEqualTo("cancelled");
	}
	@Test void malformedOrLegacyReplyFailsClosedBeforeMaterialization() {
		for(var change:java.util.List.of("update outbox_events set payload=payload-'recipientRole'",
				"update outbox_events set payload=jsonb_set(payload,'{replyMarkup,keyboard,0,0,request_contact}','true')",
				"update outbox_events set payload=jsonb_set(payload,'{chatId}','-100')")) {
			clear();member("organizer");start();jdbc.execute(change);assertThat(planner.materialize(20,"123")).isEqualTo(1);
			assertThat(count("notification_deliveries")).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("failed");
		}
	}
	@Test void safeRetryKeepsKeyboardButAmbiguousResultNeverResendsOrCreatesHistory() {
		member("faculty_helper");start();var calls=new AtomicInteger();var messages=new java.util.ArrayList<TelegramTransport.Message>();
		var worker=sender(m->{messages.add(m);return calls.incrementAndGet()==1?TelegramTransport.Outcome.retry("telegram_429",Duration.ofSeconds(1)):TelegramTransport.Outcome.unknown("response_timeout");},"123");
		assertThat(worker.dispatchOne()).isTrue();assertThat(status()).isEqualTo("retry");assertThat(count("bot_messages")).isEqualTo(1);
		due();assertThat(worker.dispatchOne()).isTrue();assertThat(status()).isEqualTo("unknown");assertThat(worker.dispatchOne()).isFalse();
		assertThat(calls).hasValue(2);assertThat(messages.get(0).keyboard()).isEqualTo(messages.get(1).keyboard());
		assertThat(messages.get(0).keyboard().rows()).containsExactly(java.util.List.of("Мои задачи","Помощь"));assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test void lastPreHttpGateAndStaleTokenCannotCancelNewOwnership() {
		member("admin");start();planner.materialize(20,"123");var old=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();
		jdbc.execute("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second'");queue.recoverExpiredLeases();
		var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(old.id(),old.token())).isFalse();assertThat(status()).isEqualTo("claimed");
		assertThat(queue.start(lease.id(),lease.token())).isTrue();jdbc.execute("update users set role='organizer'");
		assertThat(queue.commandReplyReadyForSending(lease.id(),lease.token(),"123")).isFalse();assertThat(status()).isEqualTo("cancelled");
		assertThat(jdbc.queryForObject("select result_status from delivery_attempts",String.class)).isEqualTo("cancelled");assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test void realDatabaseFailureRollsBackDeliveryAndOutboxTogetherThenRetrySucceeds() {
		member("organizer");start();jdbc.execute("alter table notification_deliveries add constraint fixture_reject_reply check(category<>'telegram_command_reply')");
		try {
			assertThatThrownBy(()->planner.materialize(20,"123")).isInstanceOf(org.springframework.dao.DataAccessException.class);
			assertThat(count("notification_deliveries")).isZero();assertThat(jdbc.queryForObject("select status from outbox_events",String.class)).isEqualTo("pending");
		}finally { jdbc.execute("alter table notification_deliveries drop constraint fixture_reject_reply"); }
		assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isEqualTo(1);
	}
	@Test void removedRecipientAndTamperedSnapshotFailClosedWithoutBlockingOtherOutboxWork() {
		member("organizer");start();jdbc.execute("delete from bot_messages");jdbc.execute("delete from users where id='member'");
		assertThat(planner.materialize(20,"123")).isEqualTo(1);assertThat(count("notification_deliveries")).isZero();
		assertThat(jdbc.queryForObject("select last_error_code from outbox_events",String.class)).isEqualTo("stale_command_reply");
		clear();member("organizer");start();planner.materialize(20,"123");
		jdbc.execute("update notification_deliveries set payload=jsonb_set(payload,'{text}','\"Подмена\"')");
		assertThat(sender(m->{throw new AssertionError("tampered_reply_sent");},"123").dispatchOne()).isTrue();assertThat(status()).isEqualTo("cancelled");
	}
	@Test void failedHistoryCommitAfterProviderAcceptanceRecoversAsUnknownWithoutDuplicateSend() {
		member("organizer");start();var calls=new AtomicInteger();var worker=sender(m->{calls.incrementAndGet();return TelegramTransport.Outcome.sent(99);},"123");
		jdbc.execute("alter table bot_messages add constraint fixture_reject_bot_history check(sender<>'bot')");
		try {
			assertThatThrownBy(worker::dispatchOne).isInstanceOf(org.springframework.dao.DataAccessException.class);
			assertThat(status()).isEqualTo("sending");assertThat(count("bot_messages")).isEqualTo(1);
			assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries",Long.class)).isNull();
		}finally { jdbc.execute("alter table bot_messages drop constraint fixture_reject_bot_history"); }
		jdbc.execute("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second'");assertThat(worker.dispatchOne()).isFalse();
		assertThat(status()).isEqualTo("unknown");assertThat(calls).hasValue(1);assertThat(count("bot_messages")).isEqualTo(1);
	}
	@Test @Timeout(60) void concurrentMaterializersCreateOneDeliveryAndStartedRecoveryStaysUnknown() throws Exception {
		member("organizer");start();
		try(var pool=Executors.newFixedThreadPool(2)) {
			var go=new CountDownLatch(1);var a=pool.submit(()->{go.await();return planner.materialize(20,"123");});var b=pool.submit(()->{go.await();return planner.materialize(20,"123");});go.countDown();
			assertThat(a.get(20,TimeUnit.SECONDS)+b.get(20,TimeUnit.SECONDS)).isEqualTo(1);
		}
		assertThat(count("notification_deliveries")).isEqualTo(1);var lease=queue.claimSupported(1,Duration.ofSeconds(30),"123").getFirst();assertThat(queue.start(lease.id(),lease.token())).isTrue();
		jdbc.execute("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second'");assertThat(queue.recoverExpiredLeases()).isEqualTo(1);assertThat(status()).isEqualTo("unknown");
		assertThat(queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.sent(99))).isFalse();assertThat(queue.claimSupported(1,Duration.ofSeconds(30),"123")).isEmpty();assertThat(count("bot_messages")).isEqualTo(1);
	}
}
