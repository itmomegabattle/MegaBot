package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;

@SpringBootTest(properties={"megabot.telegram.incoming-mode=webhook","megabot.telegram.bot-id=123","megabot.telegram.webhook-secret=fixture_secret_01234567890123456789"})
@AutoConfigureMockMvc @Import(TestcontainersConfiguration.class) @ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
class TelegramWebhookIntegrationTests {
	static final String PATH="/api/v1/telegram/webhook",SECRET="fixture_secret_01234567890123456789";
	@Autowired MockMvc mvc;@Autowired JdbcTemplate jdbc;
	@BeforeEach void clear() { jdbc.execute("truncate telegram_inbox"); }
	long count() { return jdbc.queryForObject("select count(*) from telegram_inbox",Long.class); }
	@Test void noSessionAckFollowsCommittedReceiptAndDuplicateDoesNotOverwrite() throws Exception {
		for(int i=0;i<2;i++) mvc.perform(post(PATH).contentType("application/json").header(TelegramWebhookController.SECRET_HEADER,SECRET)
				.cookie(new jakarta.servlet.http.Cookie("megabot_session","irrelevant_cookie")).header("Origin","https://untrusted.example")
				.content("{\"update_id\":1,\"bot_id\":999,\"message\":{\"text\":\"/start\",\"chat\":{\"id\":5101}}}"))
				.andExpect(status().isOk()).andExpect(header().string("Cache-Control","no-store")).andExpect(content().string(""));
		assertThat(count()).isEqualTo(1);assertThat(jdbc.queryForObject("select bot_id from telegram_inbox",String.class)).isEqualTo("123");
		assertThat(jdbc.queryForObject("select status from telegram_inbox",String.class)).isEqualTo("received");
	}
	@Test void missingWrongOrMultipleSecretsCannotPersistEvenMalformedPayload() throws Exception {
		mvc.perform(post(PATH).contentType("application/json").content("SECRET_INPUT")).andExpect(status().isUnauthorized());
		mvc.perform(post(PATH).contentType("application/json").header(TelegramWebhookController.SECRET_HEADER,"wrong").content("{}"))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("code").value("invalid_webhook_secret"));
		mvc.perform(post(PATH).contentType("application/json").header(TelegramWebhookController.SECRET_HEADER,SECRET,SECRET).content("{}"))
				.andExpect(status().isUnauthorized());assertThat(count()).isZero();
	}
	@Test void malformedAndOversizeBodiesAreNonAckAndOtherRoutesRemainProtected() throws Exception {
		mvc.perform(post(PATH).contentType("application/json").header(TelegramWebhookController.SECRET_HEADER,SECRET).content("{\"update_id\":1} {}"))
				.andExpect(status().isBadRequest());
		mvc.perform(post(PATH).contentType("application/json").header(TelegramWebhookController.SECRET_HEADER,SECRET).content(new byte[TelegramInbox.MAX_UPDATE_BYTES+1]))
				.andExpect(status().isPayloadTooLarge());
		mvc.perform(get(PATH)).andExpect(status().isForbidden());
		mvc.perform(post(PATH+"/other").contentType("application/json").content("{}")).andExpect(status().isUnauthorized());
		mvc.perform(post("/api/v1/tasks").contentType("application/json").content("{}")).andExpect(status().isUnauthorized());
		assertThat(count()).isZero();
	}
	@Test void realDatabaseRejectionReturnsSafe503AndReplaySucceedsAfterRecovery() throws Exception {
		jdbc.execute("alter table telegram_inbox add constraint fixture_webhook_reject check (bot_id<>'123')");
		try {
			var body=mvc.perform(post(PATH).contentType("application/json").header(TelegramWebhookController.SECRET_HEADER,SECRET).content("{\"update_id\":1}"))
					.andExpect(status().isServiceUnavailable()).andExpect(jsonPath("code").value("telegram_webhook_unavailable")).andReturn().getResponse().getContentAsString();
			assertThat(body).doesNotContain(SECRET,"fixture_webhook_reject","insert into","jdbc:");assertThat(count()).isZero();
		} finally { jdbc.execute("alter table telegram_inbox drop constraint fixture_webhook_reject"); }
		mvc.perform(post(PATH).contentType("application/json").header(TelegramWebhookController.SECRET_HEADER,SECRET).content("{\"update_id\":1}"))
				.andExpect(status().isOk());assertThat(count()).isEqualTo(1);
	}
}
