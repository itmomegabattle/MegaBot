package ru.itmomegabattle.megabot.migration;

import static org.assertj.core.api.Assertions.*;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Executable projection fixture, not the full B-09 snapshot importer. */
@Import(TestcontainersConfiguration.class)
@SpringBootTest
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker = true)
class LegacyMeetingRsvpsIntegrationTests {
	@Autowired JdbcTemplate jdbc;
	@Autowired ObjectMapper json;
	@Autowired PlatformTransactionManager manager;
	JsonNode fixture;
	List<LegacyMeetingRsvps.Invitation> plan;

	@BeforeEach void prepare() throws Exception {
		jdbc.execute("truncate users,notification_deliveries,outbox_events,integration_jobs,audit_events cascade");
		try (var input = getClass().getResourceAsStream("/parity/legacy-meeting-rsvp.json")) {
			fixture = json.readTree(input);
		}
		var ids = new HashSet<String>();
		fixture.path("sourceUserIds").forEach(id -> ids.add(id.asText()));
		var audience = new ArrayList<String>();
		fixture.path("audienceUserIds").forEach(id -> audience.add(id.asText()));
		plan = LegacyMeetingRsvps.plan(fixture.path("meeting"), audience, ids);
		for (var id : ids) jdbc.update("insert into users(id,username,real_name,role,registered) values (?,?,?,'organizer',true)", id, id, "Synthetic");
		jdbc.update("insert into meetings(id,kind,title,starts_at,duration_minutes,zone_id,host_id,audience_mode,status) values ('legacy_meeting','meeting','Историческая встреча','2025-01-01T12:00:00Z',60,'Europe/Moscow','legacy_host','all','completed')");
	}

	private void applyFixture() {
		// Test-only staging write; no domain command, current time or notification producer.
		for (var row : plan) jdbc.update("insert into meeting_invitations(meeting_id,user_id,rsvp,responded_at,legacy_source) values ('legacy_meeting',?,?,null,?) on conflict (meeting_id,user_id) do nothing",
				row.userId(), row.response(), row.legacySource());
	}

	@Test void historicalFixtureKeepsLegacyAttributionUnknownResponseTimeAndNoOutgoingWork() {
		var transaction = new TransactionTemplate(manager);
		transaction.executeWithoutResult(status -> applyFixture());
		var first = jdbc.queryForList("select user_id,rsvp,responded_at,legacy_source from meeting_invitations order by user_id");
		transaction.executeWithoutResult(status -> applyFixture());
		assertThat(jdbc.queryForList("select user_id,rsvp,responded_at,legacy_source from meeting_invitations order by user_id")).isEqualTo(first);
		assertThat(first).hasSize(4).allSatisfy(row -> {
			assertThat(row.get("legacy_source")).isEqualTo(true);
			assertThat(row.get("responded_at")).isNull();
		});
		assertThat(jdbc.queryForObject("select rsvp from meeting_invitations where user_id='legacy_yes'", String.class)).isEqualTo("yes");
		assertThat(jdbc.queryForObject("select rsvp from meeting_invitations where user_id='legacy_no'", String.class)).isEqualTo("no");
		assertThat(jdbc.queryForObject("select count(*) from meeting_invitations where rsvp='unanswered'", Integer.class)).isEqualTo(2);
		assertThat(jdbc.queryForObject("select status from meetings", String.class)).isEqualTo("completed");
		for (var table : List.of("notification_deliveries", "outbox_events", "integration_jobs", "audit_events"))
			assertThat(jdbc.queryForObject("select count(*) from " + table, Integer.class)).as(table).isZero();
	}

	@Test void failedStagingTransactionLeavesNoPartialInvitationsAndCanBeRetried() {
		var transaction = new TransactionTemplate(manager);
		assertThatThrownBy(() -> transaction.executeWithoutResult(status -> {
			applyFixture();
			jdbc.update("insert into meeting_invitations(meeting_id,user_id) values ('legacy_meeting','missing_user')");
		})).isInstanceOf(org.springframework.dao.DataAccessException.class);
		assertThat(jdbc.queryForObject("select count(*) from meeting_invitations", Integer.class)).isZero();
		transaction.executeWithoutResult(status -> applyFixture());
		assertThat(jdbc.queryForObject("select count(*) from meeting_invitations", Integer.class)).isEqualTo(4);
	}
}
