package ru.itmomegabattle.megabot.migration;

import static org.assertj.core.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;

@Import(TestcontainersConfiguration.class)
@SpringBootTest(properties = "megabot.legacy-staging.enabled=true")
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker = true)
class LegacySnapshotStagingIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired LegacySnapshotStaging staging;
    @Autowired PlatformTransactionManager transactions;
    // Deliberately external/unverified Node state hash: archive integrity must not imply approval.
    static final String STATE_HASH = "a".repeat(64);
    static final String SOURCE = """
            {"users":[{"id":"synthetic","realName":"Ёжик 🐈"}],"meetings":[],"tasks":[],
             "settings":{"databaseRevision":7,"notificationDeliveries":[{"status":"unknown","text":"PRIVATE_SOURCE"}]},
             "availabilities":{"synthetic":{"weekStart":"2020-12-28","slots":{"0":[17]}}},
             "extension":{"must":"survive"}}
            """;

    @BeforeEach void clear() {
        jdbc.execute("truncate migration_runs,users,notification_deliveries,outbox_events,integration_jobs,audit_events cascade");
    }
    static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    static String sha(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    LegacySnapshotStaging.Archive stage(byte[] source) { return staging.stage(source, sha(source), STATE_HASH, 7); }
    int count(String table) { return jdbc.queryForObject("select count(*) from " + table, Integer.class); }
    void emptyArchive() {
        for (var table : List.of("migration_runs", "legacy_snapshot_sources", "legacy_staging_records")) assertThat(count(table)).as(table).isZero();
    }

    @Test void archivalServiceRequiresExplicitOptIn() {
        var runner = new ApplicationContextRunner().withUserConfiguration(LegacySnapshotStaging.class)
                .withBean(JdbcTemplate.class, () -> jdbc);
        runner.run(context -> assertThat(context).doesNotHaveBean(LegacySnapshotStaging.class));
        runner.withPropertyValues("megabot.legacy-staging.enabled=false").run(context -> assertThat(context).doesNotHaveBean(LegacySnapshotStaging.class));
        runner.withPropertyValues("megabot.legacy-staging.enabled=true").run(context -> assertThat(context).hasSingleBean(LegacySnapshotStaging.class));
    }

    @Test void reconciliationComparesOriginalWithoutApprovingOrProducingWork() {
        var archive = stage(bytes(SOURCE));
        assertThat(staging.reconcile(archive.runId())).isEqualTo(new LegacySnapshotStaging.Reconciliation(4, 4, 0));
        assertThat(staging.reconcile(archive.runId()).differences()).isZero();
        assertThat(jdbc.queryForObject("select status from migration_runs", String.class)).isEqualTo("started");
        for (var table : List.of("migration_rejects", "users", "notification_deliveries", "outbox_events", "integration_jobs")) assertThat(count(table)).isZero();
        clear();
        var recovery = "{\"format\":1,\"revision\":7,\"checksum\":\"" + STATE_HASH + "\",\"state\":" + SOURCE + "}";
        assertThat(staging.reconcile(stage(bytes(recovery)).runId()).differences()).isZero();
    }

    @Test void extraRecordIsDurablyRejectedWithoutExposingSourceAndCannotBeReapproved() {
        var archive = stage(bytes(SOURCE));
        jdbc.update("insert into legacy_staging_records values (?,'state_field','injected','{}')", archive.runId());
        assertThat(staging.reconcile(archive.runId())).isEqualTo(new LegacySnapshotStaging.Reconciliation(4, 5, 1));
        assertThat(jdbc.queryForObject("select status from migration_runs", String.class)).isEqualTo("rejected");
        assertThat(jdbc.queryForObject("select source_fragment from migration_rejects", String.class)).isNull();
        assertThatThrownBy(() -> staging.reconcile(archive.runId())).hasMessage("legacy_run_not_started");
        assertThat(count("migration_rejects")).isEqualTo(1);
    }

    @Test void reconciliationRollbackIsAtomicAndTerminalRunsAreProtected() {
        var archive = stage(bytes(SOURCE));
        jdbc.update("insert into legacy_staging_records values (?,'state_field','injected','{}')", archive.runId());
        assertThatThrownBy(() -> new TransactionTemplate(transactions).executeWithoutResult(status -> {
            staging.reconcile(archive.runId()); jdbc.execute("select 1/0");
        })).isInstanceOf(DataAccessException.class);
        assertThat(count("migration_rejects")).isZero();
        assertThat(jdbc.queryForObject("select status from migration_runs", String.class)).isEqualTo("started");
        jdbc.update("update migration_runs set status='validated'");
        assertThatThrownBy(() -> staging.reconcile(archive.runId())).hasMessage("legacy_run_not_started");
        assertThatThrownBy(() -> staging.reconcile("missing")).hasMessage("legacy_run_not_found");
    }

    @Test void missingAndChangedFragmentsAreDetectedIndependentlyOfStoredCounts() {
        for (var corruption : List.of("delete from legacy_staging_records where source_type='users'",
                "update legacy_staging_records set source_fragment='{}' where source_type='users'")) {
            clear(); var archive = stage(bytes(SOURCE));
            // Synthetic fixture only: simulate privileged corruption of otherwise immutable rows.
            jdbc.execute("alter table legacy_staging_records disable trigger user");
            try { jdbc.execute(corruption); }
            finally { jdbc.execute("alter table legacy_staging_records enable trigger user"); }
            assertThat(staging.reconcile(archive.runId()).differences()).isEqualTo(1);
            assertThat(count("migration_rejects")).isEqualTo(1);
        }
    }

    @Test void originalNumericPrecisionSurvivesStagingAndIndependentReconciliation() {
        var source = SOURCE.replace("\"must\":\"survive\"", "\"number\":0.12345678901234567890123456789");
        var archive = stage(bytes(source));
        assertThat(staging.reconcile(archive.runId()).differences()).isZero();
        assertThat(jdbc.queryForObject("select status from migration_runs", String.class)).isEqualTo("started");
    }

    @Test void reconciliationLocksChildInsertsOnlyUntilCallerCommit() throws Exception {
        var archive = stage(bytes(SOURCE));
        try (var worker = Executors.newSingleThreadExecutor()) {
            new TransactionTemplate(transactions).executeWithoutResult(status -> {
                assertThat(staging.reconcile(archive.runId()).differences()).isZero();
                var blocked = worker.submit(() -> {
                    try {
                        new TransactionTemplate(transactions).executeWithoutResult(other -> {
                            jdbc.execute("set local lock_timeout='500ms'");
                            jdbc.update("insert into legacy_staging_records values (?,'state_field','concurrent','{}')", archive.runId());
                        });
                        return "unexpected_insert";
                    } catch (DataAccessException failure) {
                        assertThat(failure.getMostSpecificCause()).isInstanceOf(java.sql.SQLException.class);
                        return ((java.sql.SQLException) failure.getMostSpecificCause()).getSQLState();
                    }
                });
                try { assertThat(blocked.get(30, TimeUnit.SECONDS)).isEqualTo("55P03"); }
                catch (Exception failure) { throw new AssertionError(failure); }
                assertThat(count("legacy_staging_records")).isEqualTo(4);
                assertThat(count("migration_rejects")).isZero();
            });
            // The lock is intentionally not a permanent seal; later additions must be rechecked.
            jdbc.update("insert into legacy_staging_records values (?,'state_field','concurrent','{}')", archive.runId());
            assertThat(staging.reconcile(archive.runId()).differences()).isEqualTo(1);
        }
        assertThat(count("migration_rejects")).isEqualTo(1);
    }

    @Test void concurrentMismatchAssessmentsCommitExactlyOneReject() throws Exception {
        var archive = stage(bytes(SOURCE));
        jdbc.update("insert into legacy_staging_records values (?,'state_field','extra','{}')", archive.runId());
        var ready = new CountDownLatch(2); var start = new CountDownLatch(1);
        java.util.concurrent.Callable<String> assess = () -> {
            ready.countDown();
            if (!start.await(30, TimeUnit.SECONDS)) throw new AssertionError("assessment_start_timeout");
            try { assertThat(staging.reconcile(archive.runId()).differences()).isEqualTo(1); return "rejected"; }
            catch (IllegalArgumentException terminal) { return terminal.getMessage(); }
        };
        try (var workers = Executors.newFixedThreadPool(2)) {
            var first = workers.submit(assess); var second = workers.submit(assess);
            try {
                assertThat(ready.await(30, TimeUnit.SECONDS)).isTrue(); start.countDown();
                assertThat(List.of(first.get(30, TimeUnit.SECONDS), second.get(30, TimeUnit.SECONDS)))
                        .containsExactlyInAnyOrder("rejected", "legacy_run_not_started");
            } finally { start.countDown(); }
        }
        assertThat(count("migration_rejects")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select status from migration_runs", String.class)).isEqualTo("rejected");
    }

    @Test void preservesOriginalBytesOpaqueFieldsAndDoesNotApproveOrProduceWork() {
        var source = bytes(SOURCE); var copy = source.clone();
        var result = stage(source);
        assertThat(result.reused()).isFalse(); assertThat(result.stagedRecords()).isEqualTo(4);
        assertThat(source).isEqualTo(copy);
        assertThat(jdbc.queryForObject("select original_bytes from legacy_snapshot_sources", byte[].class)).isEqualTo(copy);
        assertThat(jdbc.queryForObject("select file_checksum from legacy_snapshot_sources", String.class)).isEqualTo(sha(copy));
        assertThat(jdbc.queryForObject("select status from migration_runs", String.class)).isEqualTo("started");
        assertThat(jdbc.queryForObject("select statistics->>'nodeStateChecksumVerified' from migration_runs", String.class)).isEqualTo("false");
        assertThat(jdbc.queryForObject("select source_fragment->>'must' from legacy_staging_records where source_key='extension'", String.class)).isEqualTo("survive");
        for (var table : List.of("users", "meetings", "tasks", "notification_deliveries", "outbox_events", "integration_jobs", "audit_events", "migration_rejects"))
            assertThat(count(table)).as(table).isZero();
    }

    @Test void duplicateArchiveIsIdempotentAndOriginalIsImmutableInPostgres() {
        var first = stage(bytes(SOURCE)); var repeat = stage(bytes(SOURCE));
        assertThat(repeat.runId()).isEqualTo(first.runId()); assertThat(repeat.reused()).isTrue();
        assertThat(count("migration_runs")).isEqualTo(1); assertThat(count("legacy_staging_records")).isEqualTo(4);
        assertThatThrownBy(() -> jdbc.update("update legacy_snapshot_sources set original_bytes=original_bytes")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("delete from legacy_staging_records")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("delete from migration_runs")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update migration_runs set source_revision='8'")).isInstanceOf(DataAccessException.class);
        jdbc.update("update migration_runs set status='validated'");
        assertThat(stage(bytes(SOURCE)).reused()).isTrue();
        assertThat(jdbc.queryForObject("select status from migration_runs", String.class)).isEqualTo("validated");
        assertThat(jdbc.queryForObject("select original_bytes from legacy_snapshot_sources", byte[].class)).isEqualTo(bytes(SOURCE));
    }

    @Test void sameLedgerIdentityCannotReplaceFileOrReuseUnrelatedLedgerRun() {
        var original = stage(bytes(SOURCE));
        assertThatThrownBy(() -> stage(bytes(SOURCE + " "))).isInstanceOf(IllegalArgumentException.class).hasMessage("legacy_source_identity_conflict");
        assertThat(stage(bytes(SOURCE)).runId()).isEqualTo(original.runId());
        clear();
        jdbc.update("insert into migration_runs(id,source_revision,source_checksum,status) values ('existing','7',?,'validated')", STATE_HASH);
        assertThatThrownBy(() -> stage(bytes(SOURCE))).isInstanceOf(IllegalArgumentException.class).hasMessage("legacy_run_without_archive");
        assertThat(count("migration_runs")).isEqualTo(1); assertThat(count("legacy_snapshot_sources")).isZero();
        assertThat(jdbc.queryForObject("select status from migration_runs", String.class)).isEqualTo("validated");
    }

    @Test void malformedBytesMetadataDuplicateJsonAndEntityIdsFailBeforeWrites() {
        for (var source : List.of(bytes("{"), bytes(SOURCE + "{}"), bytes("\uFEFF" + SOURCE),
                bytes(SOURCE.replace("\"databaseRevision\":7", "\"databaseRevision\":7,\"databaseRevision\":7")),
                bytes(SOURCE.replace("\"users\":[{\"id\":\"synthetic\",\"realName\":\"Ёжик 🐈\"}]", "\"users\":[{\"id\":\"same\"},{\"id\":\"same\"}]")),
                new byte[] {123,34,(byte)255,34,58,49,125})) {
            assertThatThrownBy(() -> stage(source)).isInstanceOf(IllegalArgumentException.class);
            emptyArchive();
        }
        assertThatThrownBy(() -> staging.stage(bytes(SOURCE), "0".repeat(64), STATE_HASH, 7)).hasMessage("legacy_file_checksum_mismatch");
        assertThatThrownBy(() -> staging.stage(bytes(SOURCE), sha(bytes(SOURCE)), STATE_HASH, 8)).hasMessage("legacy_source_revision_mismatch");
        assertThatThrownBy(() -> staging.stage(bytes(SOURCE), sha(bytes(SOURCE)), "bad", 7)).hasMessage("invalid_legacy_source_metadata");
        emptyArchive();
    }

    @Test void recoveryEnvelopeMustMatchExternalRevisionAndChecksum() {
        var recovery = "{\"format\":1,\"revision\":7,\"checksum\":\"" + STATE_HASH + "\",\"state\":" + SOURCE + "}";
        assertThat(stage(bytes(recovery)).stagedRecords()).isEqualTo(4);
        assertThat(jdbc.queryForObject("select source_kind from legacy_snapshot_sources", String.class)).isEqualTo("recovery-record-v1");
        for (var invalid : List.of(recovery.replace("\"format\":1", "\"format\":2"), recovery.replace("\"revision\":7", "\"revision\":8"), recovery.replace(STATE_HASH, "b".repeat(64)))) {
            clear(); assertThatThrownBy(() -> stage(bytes(invalid))).hasMessage("invalid_legacy_recovery_envelope"); emptyArchive();
        }
    }

    @Test void failedBatchAndCallerTransactionRollbackLeaveNoPartialArchiveAndPermitRetry() {
        jdbc.execute("alter table legacy_staging_records add constraint reject_fixture_users check(source_type<>'users')");
        try { assertThatThrownBy(() -> stage(bytes(SOURCE))).isInstanceOf(DataAccessException.class); }
        finally { jdbc.execute("alter table legacy_staging_records drop constraint reject_fixture_users"); }
        emptyArchive();
        assertThatThrownBy(() -> new TransactionTemplate(transactions).executeWithoutResult(status -> {
            stage(bytes(SOURCE)); jdbc.execute("select 1/0");
        })).isInstanceOf(DataAccessException.class);
        emptyArchive(); assertThat(stage(bytes(SOURCE)).reused()).isFalse();
    }

    @Test void concurrentSameSourceCreatesOneArchiveAndReturnsSameRun() throws Exception {
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var one = workers.submit(() -> { start.await(); return stage(bytes(SOURCE)); });
            var two = workers.submit(() -> { start.await(); return stage(bytes(SOURCE)); });
            start.countDown();
            var first = one.get(30, TimeUnit.SECONDS); var second = two.get(30, TimeUnit.SECONDS);
            assertThat(first.runId()).isEqualTo(second.runId()); assertThat(first.reused()).isNotEqualTo(second.reused());
        }
        assertThat(count("migration_runs")).isEqualTo(1); assertThat(count("legacy_snapshot_sources")).isEqualTo(1);
        assertThat(count("legacy_staging_records")).isEqualTo(4);
    }

    @Test void databaseRejectsIncorrectByteChecksumIndependentlyOfJava() {
        jdbc.update("insert into migration_runs(id,source_revision,source_checksum,status) values ('direct','7',?,'started')", STATE_HASH);
        assertThatThrownBy(() -> jdbc.update("insert into legacy_snapshot_sources(migration_run_id,file_checksum,source_kind,original_bytes) values ('direct',?,'sheets-backup-state',?)", "0".repeat(64), bytes(SOURCE)))
                .isInstanceOf(DataAccessException.class);
        assertThat(count("legacy_snapshot_sources")).isZero();
    }

    @Test void postgresJsonbTextAdmissionRejectsNulAndUnpairedSurrogatesButPreservesValidUnicode() {
        for (var invalid : List.of("\"\\u0000\"", "\"\\ud800\"", "\"\\udc00\"", "{\"\\u0000\":1}"))
            assertThatThrownBy(() -> jdbc.queryForObject("select cast(? as jsonb)::text", String.class, invalid))
                    .isInstanceOf(DataAccessException.class);
        for (var valid : List.of("\"Ёжик 🐈 é\"", "\"\\\\u0000\"", "\"\\ud7ff\\ue000\""))
            assertThat(jdbc.queryForObject("select cast(? as jsonb)::text", String.class, valid)).isNotBlank();
        emptyArchive();
    }
}
