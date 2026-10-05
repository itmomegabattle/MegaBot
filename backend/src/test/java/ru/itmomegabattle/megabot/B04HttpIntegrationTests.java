package ru.itmomegabattle.megabot;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.TemporalAdjusters;
import java.time.DayOfWeek;
import java.util.List;
import java.util.Map;

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
import org.testcontainers.junit.jupiter.Testcontainers;

import jakarta.servlet.http.Cookie;
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.team.UserEntity;
import ru.itmomegabattle.megabot.team.UserRepository;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker = true)
class B04HttpIntegrationTests {

	@Autowired MockMvc mvc;
	@Autowired JdbcTemplate jdbc;
	@Autowired UserRepository users;
	@Autowired SessionService sessions;
	@Autowired ObjectMapper json;

	private UserEntity admin;
	private UserEntity organizer;
	private UserEntity faculty;
	private UserEntity facultyResponsible;

	@BeforeEach
	void prepare() {
		jdbc.execute("TRUNCATE TABLE users, availability_week_metadata, app_settings CASCADE");
		admin = users.saveAndFlush(new UserEntity(100L, "admin_user", "Admin", "admin"));
		organizer = users.saveAndFlush(new UserEntity(101L, "org_user", "Organizer", "organizer"));
		faculty = users.saveAndFlush(new UserEntity(102L, "faculty_user", "Faculty", "faculty_helper"));
		facultyResponsible = users.saveAndFlush(new UserEntity(103L, "responsible_user", "Responsible", "faculty_responsible"));
	}

	@Test
	void coreTeamIsHiddenFromFaculty() throws Exception {
		mvc.perform(get("/api/v1/team").cookie(cookieFor(organizer))).andExpect(status().isOk());
		mvc.perform(get("/api/v1/team").cookie(cookieFor(faculty))).andExpect(status().isForbidden());
	}

	@Test
	void weekSaveIsSelfScopedAndOptimisticallyVersioned() throws Exception {
		var monday = LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
		var body = json.writeValueAsString(Map.of(
				"outOfWeek", false,
				"expectedVersion", 0,
				"days", List.of(Map.of("date", monday.toString(), "status", "available", "startMinutes", List.of(1020)))));
		var cookie = cookieFor(organizer);

		mvc.perform(put("/api/v1/availability/weeks/{weekStart}", monday)
				.cookie(cookie).header("Origin", "http://localhost")
				.contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.version").value(1));
		mvc.perform(put("/api/v1/availability/weeks/{weekStart}", monday)
				.cookie(cookie).header("Origin", "http://localhost")
				.contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isConflict())
				.andExpect(jsonPath("$.code").value("stale_version"));
		mvc.perform(put("/api/v1/availability/weeks/{weekStart}", monday)
				.queryParam("userId", admin.getId())
				.cookie(cookie).header("Origin", "http://localhost")
				.contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isForbidden());
	}

	@Test
	void onlyAdminMutatesCatalogs() throws Exception {
		var body = json.writeValueAsString(Map.of("name", "Production", "scope", "core"));
		mvc.perform(post("/api/v1/competencies").cookie(cookieFor(organizer))
				.header("Idempotency-Key", "catalog-test-01")
				.header("Origin", "http://localhost").contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isForbidden());
		mvc.perform(post("/api/v1/competencies").cookie(cookieFor(admin))
				.header("Idempotency-Key", "catalog-test-01")
				.header("Origin", "http://localhost").contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isCreated())
				.andExpect(jsonPath("$.scope").value("core"));
		mvc.perform(post("/api/v1/competencies").cookie(cookieFor(admin))
				.header("Idempotency-Key", "catalog-test-01")
				.header("Origin", "http://localhost").contentType(MediaType.APPLICATION_JSON).content(body))
				.andExpect(status().isCreated())
				.andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.header()
						.string("Idempotency-Replayed", "true"));
		mvc.perform(post("/api/v1/competencies").cookie(cookieFor(admin))
				.header("Idempotency-Key", "catalog-test-01")
				.header("Origin", "http://localhost").contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("name", "Design", "scope", "core"))))
				.andExpect(status().isConflict())
				.andExpect(jsonPath("$.code").value("idempotency_conflict"));
	}

	@Test
	void fourRolesReceiveOnlyTheirAllowedB04Surface() throws Exception {
		for (var user : List.of(admin, organizer)) {
			mvc.perform(get("/api/state").cookie(cookieFor(user)))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$.timeZone").value("Europe/Moscow"))
					.andExpect(jsonPath("$.capabilities.durableBroadcasts").value(true))
					.andExpect(jsonPath("$.users[0].telegramConnected").isBoolean())
					.andExpect(jsonPath("$.users[0].telegramId").doesNotExist());
			mvc.perform(get("/api/v1/catalogs").cookie(cookieFor(user))).andExpect(status().isOk());
			mvc.perform(get("/api/v1/profile").cookie(cookieFor(user))).andExpect(status().isOk());
			mvc.perform(get("/api/faculty/me").cookie(cookieFor(user))).andExpect(status().isForbidden());
		}
		for (var user : List.of(faculty, facultyResponsible)) {
			mvc.perform(get("/api/state").cookie(cookieFor(user))).andExpect(status().isForbidden());
			mvc.perform(get("/api/v1/catalogs").cookie(cookieFor(user))).andExpect(status().isForbidden());
			mvc.perform(get("/api/v1/profile").cookie(cookieFor(user))).andExpect(status().isOk());
			mvc.perform(get("/api/faculty/me").cookie(cookieFor(user)))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$.user.id").value(user.getId()));
		}
	}

	private Cookie cookieFor(UserEntity user) {
		return new Cookie("megabot_session", sessions.rotateFor(user.getId()).rawToken());
	}
}
