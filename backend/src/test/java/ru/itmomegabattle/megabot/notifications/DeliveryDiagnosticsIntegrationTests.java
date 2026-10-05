package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.mockito.Mockito.*;
import javax.sql.DataSource;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.common.ApiException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Import(TestcontainersConfiguration.class) @SpringBootTest @AutoConfigureMockMvc
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
class DeliveryDiagnosticsIntegrationTests {
	@Autowired JdbcTemplate jdbc;@Autowired MockMvc mvc;@Autowired SessionService sessions;@Autowired ObjectMapper json;
	Cookie admin,organizer,faculty;
	@BeforeEach void prepare() {
		jdbc.execute("truncate users,notification_deliveries cascade");
		jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',9901,'admin','Админ','admin',true),('u',9902,'organizer','Участник','organizer',true),('f',9903,'faculty','Факультет','faculty_helper',true)");
		admin=cookie("a");organizer=cookie("u");faculty=cookie("f");
	}
	Cookie cookie(String id) { return new Cookie("megabot_session",sessions.rotateFor(id).rawToken()); }
	JsonNode snapshot() throws Exception {
		return json.readTree(mvc.perform(get("/api/v1/admin/delivery-diagnostics").cookie(admin)).andExpect(status().isOk())
				.andExpect(header().string("Cache-Control","no-store")).andReturn().getResponse().getContentAsString());
	}
	void delivery(String id,String status,int intendedSeconds,int availableSeconds,int expirySeconds,int attempts,boolean cancelled) {
		jdbc.update("""
				insert into notification_deliveries(id,operation_id,dedupe_key,category,recipient_id,chat_id,payload,intended_at,available_at,expires_at,status,attempts,cancel_requested,lease_token,leased_until,request_started_at)
				values (?,?,?,'broadcast','u',9902,'{"text":"SECRET_PAYLOAD","token":"SECRET_TOKEN"}',
				now()+make_interval(secs=>?),now()+make_interval(secs=>?),now()+make_interval(secs=>?),?,?,?,
				case when ? in ('claimed','sending') then 'SECRET_LEASE' end,
				case when ? in ('claimed','sending') then now()-interval '10 seconds' end,
				case when ?='sending' then now()-interval '20 seconds' end)
				""",id,"SECRET_OPERATION",id,intendedSeconds,availableSeconds,expirySeconds,status,attempts,cancelled,status,status,status);
	}
	@Test void emptyQueueReportsAbsentTimingsNotFabricatedZeroAndPoolIsAvailable() throws Exception {
		var s=snapshot();assertThat(s.path("queue").path("total").asLong()).isZero();
		assertThat(s.path("queue").path("oldestDueAgeSeconds").isNull()).isTrue();
		assertThat(s.path("timings").path("firstStartLatenessP95Ms").isNull()).isTrue();
		assertThat(s.path("databaseNow").asText()).endsWith("Z");assertThat(s.path("databasePool").path("max").asInt()).isPositive();
		assertThat(s.path("notMeasured").toString()).contains("ntpClockOffset","devicePushLatency").doesNotContain("workerHeartbeat");
		assertThat(s.path("worker").path("state").asText()).isEqualTo("disabled");
		assertThat(s.path("worker").path("lastCycleCompletedAt").isNull()).isTrue();
		assertThat(s.path("signals").isArray()).isTrue();assertThat(s.path("signals").isEmpty()).isTrue();
	}
	@Test void onlyCurrentAdminCanReadAndRoleIsRecheckedOnEachRequest() throws Exception {
		mvc.perform(get("/api/v1/admin/delivery-diagnostics")).andExpect(status().isUnauthorized());
		mvc.perform(get("/api/v1/admin/delivery-diagnostics").cookie(organizer)).andExpect(status().isForbidden());
		mvc.perform(get("/api/v1/admin/delivery-diagnostics").cookie(faculty)).andExpect(status().isForbidden());
		snapshot();jdbc.update("update users set role='organizer' where id='a'");
		mvc.perform(get("/api/v1/admin/delivery-diagnostics").cookie(admin)).andExpect(status().isForbidden());
	}
	@Test void dueAgeExcludesExpiryCancellationFutureRetryDelayAndExhaustedAttempts() throws Exception {
		delivery("due","planned",-100,-60,100,0,false);delivery("retry","retry",-100,-30,100,1,false);
		delivery("expired","planned",-100,-90,-5,0,false);delivery("cancelled","planned",-100,-90,100,0,true);
		delivery("future","planned",100,-90,200,0,false);delivery("backoff","retry",-100,50,200,1,false);
		delivery("exhausted","retry",-100,-90,100,8,false);delivery("claim","claimed",-100,-90,100,0,false);
		delivery("send","sending",-100,-90,100,1,false);
		var s=snapshot();var q=s.path("queue");assertThat(q.path("total").asLong()).isEqualTo(9);assertThat(q.path("due").asLong()).isEqualTo(2);
		assertThat(q.path("oldestDueAgeSeconds").asDouble()).isBetween(60.0,70.0);assertThat(q.path("staleLeases").asLong()).isEqualTo(2);
		assertThat(s.path("signals").toString()).contains("due_backlog_quota_unverified","stale_leases").doesNotContain("worker_stalled");
	}
	@Test void aggregateContainsNoIdentitiesSecretsMessageTextOrRawErrors() throws Exception {
		for(var status:java.util.List.of("planned","retry","claimed","sending","sent","failed","unknown","cancelled","expired"))delivery(status,status,-100,-60,100,1,false);
		jdbc.update("update notification_deliveries set last_error_code='SECRET_RAW_ERROR'");var s=snapshot();
		for(var status:java.util.List.of("planned","retry","claimed","sending","sent","failed","unknown","cancelled","expired"))assertThat(s.path("queue").path(status).asLong()).isEqualTo(1);
		assertThat(s.toString()).doesNotContain("SECRET_","9902","recipient","chatId","operationId","payload");
	}
	@Test void percentilesUseFirstAttemptsInLast24HoursAndDoNotMixCompletionDuration() throws Exception {
		jdbc.update("""
				insert into notification_deliveries(id,operation_id,dedupe_key,category,chat_id,payload,intended_at,available_at,status,attempts)
				select 'sample_'||n,'op','sample_'||n,'task_manual',123,'{}',now()-interval '1 minute'-make_interval(secs=>n),now()-interval '1 minute','sent',1 from generate_series(1,1000) n
				""");
		jdbc.update("""
				insert into delivery_attempts(id,delivery_id,attempt_number,started_at,finished_at,result_status)
				select 'attempt_'||n,'sample_'||n,1,intended_at+make_interval(secs=>n),intended_at+make_interval(secs=>n+2),'sent'
				from generate_series(1,1000) n join notification_deliveries d on d.id='sample_'||n
				""");
		var t=snapshot().path("timings");assertThat(t.path("firstAttempts").asLong()).isEqualTo(1000);
		assertThat(t.path("firstStartLatenessP50Ms").asDouble()).isCloseTo(500500,within(0.01));
		assertThat(t.path("firstStartLatenessP95Ms").asDouble()).isCloseTo(950050,within(0.01));
		assertThat(t.path("firstStartLatenessP99Ms").asDouble()).isCloseTo(990010,within(0.01));
		assertThat(t.path("firstStartLatenessMaxMs").asDouble()).isEqualTo(1000000);
		assertThat(t.path("attemptDurationP95Ms").asDouble()).isEqualTo(2000);
		jdbc.update("update delivery_attempts set attempt_number=2 where delivery_id='sample_1000'");
		jdbc.update("update delivery_attempts set started_at=now()-interval '25 hours' where delivery_id='sample_999'");
		jdbc.update("update notification_deliveries set intended_at=now()+interval '1 hour' where id='sample_1'");
		var changed=snapshot().path("timings");assertThat(changed.path("attempts").asLong()).isEqualTo(999);
		assertThat(changed.path("firstAttempts").asLong()).isEqualTo(998);assertThat(changed.path("earlyAttempts").asLong()).isEqualTo(1);
		assertThat(changed.path("firstStartLatenessMaxMs").asDouble()).isEqualTo(998000);
	}
	@Test void databaseFailureReturnsSafe503InsteadOfZeroOrExceptionDetails() {
		var jdbcClient=mock(JdbcClient.class);when(jdbcClient.sql(anyString())).thenThrow(new DataAccessResourceFailureException("SECRET_CONNECTION_STRING"));
		var controller=new DeliveryDiagnosticsController(jdbcClient,mock(DataSource.class),mock(org.springframework.beans.factory.ObjectProvider.class));
		assertThatThrownBy(controller::snapshot).isInstanceOfSatisfying(ApiException.class,e->{
			assertThat(e.status()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);assertThat(e.code()).isEqualTo("delivery_diagnostics_unavailable");
			assertThat(e.getMessage()).doesNotContain("SECRET_");assertThat(e.getCause()).isNull();
		});
	}
}
