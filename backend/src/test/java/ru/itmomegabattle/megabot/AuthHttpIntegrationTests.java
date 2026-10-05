package ru.itmomegabattle.megabot;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.junit.jupiter.Testcontainers;

import jakarta.servlet.http.Cookie;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class)
@SpringBootTest(properties = {
		"megabot.auth.telegram.bot-token=123456:test-token",
		"megabot.security.allowed-origins=https://mini.example"
})
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker = true)
class AuthHttpIntegrationTests {

	private static final String TOKEN = "123456:test-token";
	@Test
	void webhookIsDisabledByDefaultAndDoesNotAcceptUpdates() throws Exception {
		mvc.perform(post("/api/v1/telegram/webhook").contentType(MediaType.APPLICATION_JSON).content("{\"update_id\":1}"))
				.andExpect(status().isServiceUnavailable()).andExpect(jsonPath("code").value("telegram_webhook_disabled"));
	}

	@Autowired
	private MockMvc mvc;

	@Autowired
	private JdbcTemplate jdbc;

	@Autowired
	private ObjectMapper objectMapper;

	@BeforeEach
	void prepareUser() {
		jdbc.execute("TRUNCATE TABLE sessions, users CASCADE");
		jdbc.update("""
				INSERT INTO users (id, telegram_id, username, real_name, role, registered, active)
				VALUES ('u_member', 42, 'alice', 'Alice', 'organizer', true, true)
				""");
	}

	@Test
	void loginUsesOnlySignedTelegramIdentityAndSetsSecureOpaqueCookie() throws Exception {
		var result = mvc.perform(post("/api/v1/auth/telegram")
				.contentType(MediaType.APPLICATION_JSON)
				.content(objectMapper.writeValueAsString(Map.of(
						"initData", signedUser(42),
						"telegramId", 999,
						"role", "admin"))))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.user.id").value("u_member"))
				.andExpect(jsonPath("$.user.role").value("organizer"))
				.andExpect(header().string("Set-Cookie", org.hamcrest.Matchers.allOf(
						org.hamcrest.Matchers.containsString("megabot_session="),
						org.hamcrest.Matchers.containsString("HttpOnly"),
						org.hamcrest.Matchers.containsString("Secure"),
						org.hamcrest.Matchers.containsString("SameSite=Lax"))))
				.andReturn();

		var session = sessionCookie(result);
		mvc.perform(post("/api/v1/auth/logout").cookie(session))
				.andExpect(status().isForbidden());
		mvc.perform(post("/api/v1/auth/logout")
						.cookie(session)
						.header("Origin", "http://localhost"))
				.andExpect(status().isNoContent());
	}

	@Test
	void unknownOrTamperedIdentityIsRejected() throws Exception {
		mvc.perform(post("/api/v1/auth/telegram")
						.contentType(MediaType.APPLICATION_JSON)
						.content(objectMapper.writeValueAsString(Map.of("initData", signedUser(43)))))
				.andExpect(status().isForbidden());

		mvc.perform(post("/api/v1/auth/telegram")
						.contentType(MediaType.APPLICATION_JSON)
						.content(objectMapper.writeValueAsString(Map.of(
								"initData", signedUser(42).replace("alice", "mallory")))))
				.andExpect(status().isForbidden());
	}

	private Cookie sessionCookie(MvcResult result) {
		var responseCookie = result.getResponse().getCookie("megabot_session");
		if (responseCookie == null) {
			throw new AssertionError("Session cookie is absent");
		}
		return new Cookie(responseCookie.getName(), responseCookie.getValue());
	}

	private String signedUser(long telegramId) {
		try {
			var parameters = new LinkedHashMap<String, String>();
			parameters.put("auth_date", String.valueOf(Instant.now().getEpochSecond()));
			parameters.put("query_id", "synthetic");
			parameters.put("user", "{\"id\":" + telegramId + ",\"username\":\"alice\",\"first_name\":\"Alice\"}");
			var dataCheckString = parameters.entrySet().stream()
					.sorted(Map.Entry.comparingByKey())
					.map(entry -> entry.getKey() + "=" + entry.getValue())
					.collect(Collectors.joining("\n"));
			var secretMac = Mac.getInstance("HmacSHA256");
			secretMac.init(new SecretKeySpec("WebAppData".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
			var secret = secretMac.doFinal(TOKEN.getBytes(StandardCharsets.UTF_8));
			var dataMac = Mac.getInstance("HmacSHA256");
			dataMac.init(new SecretKeySpec(secret, "HmacSHA256"));
			parameters.put("hash", HexFormat.of().formatHex(dataMac.doFinal(dataCheckString.getBytes(StandardCharsets.UTF_8))));
			return parameters.entrySet().stream()
					.map(entry -> URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8) + "="
							+ URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8))
					.collect(Collectors.joining("&"));
		} catch (Exception exception) {
			throw new IllegalStateException(exception);
		}
	}
}
