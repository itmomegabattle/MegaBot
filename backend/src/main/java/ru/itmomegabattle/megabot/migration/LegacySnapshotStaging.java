package ru.itmomegabattle.megabot.migration;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Disabled by default; archives untrusted source, never validates or applies a migration. */
@Service
@ConditionalOnProperty(name = "megabot.legacy-staging.enabled", havingValue = "true")
public class LegacySnapshotStaging {
    private final JdbcTemplate jdbc;
    private final JsonMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS, DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).build();

    LegacySnapshotStaging(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public record Archive(String runId, boolean reused, int stagedRecords) {}
    public record Reconciliation(int expectedRecords, int actualRecords, int differences) {}
    private record Row(String type, String key, String fragment) {}

    /** Archive fidelity only: successful reconciliation never approves a migration. */
    @Transactional
    public Reconciliation reconcile(String runId) {
        var statuses = jdbc.queryForList("select status from migration_runs where id=? for update", String.class, runId);
        if (statuses.isEmpty()) throw reject("legacy_run_not_found");
        if (!statuses.getFirst().equals("started")) throw reject("legacy_run_not_started");
        // Parent lock also blocks new child FK inserts until this transaction completes.
        var sources = jdbc.queryForList("select migration_run_id from legacy_snapshot_sources where migration_run_id=? for update", String.class, runId);
        if (sources.isEmpty()) throw reject("legacy_run_without_archive");
        var result = jdbc.queryForObject("""
                with source as (
                    select convert_from(original_bytes,'UTF8')::jsonb as root, source_kind
                    from legacy_snapshot_sources where migration_run_id=?
                ), fields as (
                    select field.* from source cross join lateral jsonb_each(
                        case when source_kind='recovery-record-v1' then root->'state' else root end
                    ) field
                ), expected as (
                    select key as source_type, entity->>'id' as source_key, entity as fragment
                    from fields cross join lateral jsonb_array_elements(
                        case when key in ('users','meetings','tasks','events','faculties') then value else '[]'::jsonb end
                    ) entity
                    union all
                    select 'state_field',key,value from fields
                    where key not in ('users','meetings','tasks','events','faculties')
                ), actual as (
                    select source_type,source_key,source_fragment as fragment
                    from legacy_staging_records where migration_run_id=?
                )
                select (select count(*) from expected), (select count(*) from actual),
                    count(*) filter(where expected.fragment is distinct from actual.fragment)
                from expected full join actual using(source_type,source_key)
                """, (row, index) -> new Reconciliation(row.getInt(1), row.getInt(2), row.getInt(3)), runId, runId);
        if (result.differences() > 0) {
            jdbc.update("insert into migration_rejects(id,migration_run_id,source_type,reason_code,reason_summary) values (?,?,'archive','legacy_archive_mismatch','Staged records differ from original source')",
                    "legacy_reject_" + UUID.randomUUID(), runId);
        }
        jdbc.update("""
                update migration_runs set statistics=statistics || cast(? as jsonb),
                    status=case when ? then 'rejected' else status end,
                    finished_at=case when ? then now() else finished_at end where id=?
                """, json.writeValueAsString(Map.of("archiveReconciliation", result)), result.differences() > 0, result.differences() > 0, runId);
        return result;
    }

    /** State checksum is externally supplied Node evidence, NOT a Java reserialization hash. */
    @Transactional
    public Archive stage(byte[] original, String fileChecksum, String stateChecksum, long revision) {
        if (original == null || original.length < 2 || original.length > 64 * 1024 * 1024
                || !hash(fileChecksum) || !hash(stateChecksum) || revision < 0 || revision > 9007199254740991L)
            throw reject("invalid_legacy_source_metadata");
        var bytes = original.clone();
        if (!checksum(bytes).equals(fileChecksum)) throw reject("legacy_file_checksum_mismatch");
        JsonNode root;
        try {
            var raw = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            if (raw.startsWith("\uFEFF")) throw reject("legacy_bom_not_supported");
            root = json.readTree(raw);
        } catch (CharacterCodingException | RuntimeException invalid) {
            throw reject("invalid_legacy_source_json"); // No provider/raw payload in errors.
        }
        if (root == null || !root.isObject()) throw reject("invalid_legacy_source_root");
        boolean recovery = root.has("format");
        var state = recovery ? root.path("state") : root;
        if (!state.isObject() || !state.path("settings").isObject()
                || !integerEquals(state.path("settings").path("databaseRevision"), revision))
            throw reject("legacy_source_revision_mismatch");
        if (recovery && (!integerEquals(root.path("format"), 1) || !integerEquals(root.path("revision"), revision)
                || !root.path("checksum").isString() || !root.path("checksum").asText().equals(stateChecksum)))
            throw reject("invalid_legacy_recovery_envelope");
        var rows = rows(state);
        String kind = recovery ? "recovery-record-v1" : "sheets-backup-state";
        String candidate = "legacy_run_" + UUID.randomUUID();
        int inserted = jdbc.update("insert into migration_runs(id,source_revision,source_checksum,status) values (?,?,?,'started') on conflict(source_revision,source_checksum) do nothing",
                candidate, Long.toString(revision), stateChecksum);
        String runId = jdbc.queryForObject("select id from migration_runs where source_revision=? and source_checksum=? for update", String.class, Long.toString(revision), stateChecksum);
        var sources = jdbc.queryForList("select file_checksum,source_kind from legacy_snapshot_sources where migration_run_id=?", runId);
        if (!sources.isEmpty()) {
            var source = sources.getFirst();
            if (!fileChecksum.equals(source.get("file_checksum")) || !kind.equals(source.get("source_kind")))
                throw reject("legacy_source_identity_conflict");
            return new Archive(runId, true, jdbc.queryForObject("select count(*) from legacy_staging_records where migration_run_id=?", Integer.class, runId));
        }
        if (inserted != 1) throw reject("legacy_run_without_archive");
        jdbc.update("insert into legacy_snapshot_sources(migration_run_id,file_checksum,source_kind,original_bytes) values (?,?,?,?)", runId, fileChecksum, kind, bytes);
        jdbc.batchUpdate("insert into legacy_staging_records(migration_run_id,source_type,source_key,source_fragment) values (?,?,?,cast(? as jsonb))", rows, 200,
                (statement, row) -> { statement.setString(1, runId); statement.setString(2, row.type()); statement.setString(3, row.key()); statement.setString(4, row.fragment()); });
        jdbc.update("update migration_runs set statistics=cast(? as jsonb) where id=?",
                json.writeValueAsString(Map.of("archiveOnly", true, "stagedRecords", rows.size(), "nodeStateChecksumVerified", false)), runId);
        return new Archive(runId, false, rows.size());
    }

    private List<Row> rows(JsonNode state) {
        var rows = new ArrayList<Row>();
        var entities = Set.of("users", "meetings", "tasks", "events", "faculties");
        for (var required : List.of("users", "meetings", "tasks"))
            if (!state.path(required).isArray()) throw reject("invalid_legacy_entity_collection");
        for (var entry : state.properties()) {
            String type = entry.getKey(); var value = entry.getValue();
            if (type.isBlank()) throw reject("invalid_legacy_source_key");
            if (entities.contains(type)) {
                if (!value.isArray()) throw reject("invalid_legacy_entity_collection");
                var ids = new HashSet<String>();
                for (var row : value) {
                    var id = row.path("id");
                    if (!row.isObject() || !id.isString() || id.asText().isBlank() || !ids.add(id.asText())) throw reject("invalid_legacy_entity_id");
                    rows.add(new Row(type, id.asText(), row.toString()));
                }
            } else {
                // Preserve unknown fields, dictionaries, ordering and runtime queues as opaque source.
                rows.add(new Row("state_field", type, value.toString()));
            }
        }
        return List.copyOf(rows);
    }

    private static boolean integerEquals(JsonNode value, long expected) { return value.isIntegralNumber() && value.canConvertToLong() && value.longValue() == expected; }
    private static boolean hash(String value) { return value != null && value.matches("[a-f0-9]{64}"); }
    private static IllegalArgumentException reject(String code) { return new IllegalArgumentException(code); }
    private static String checksum(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("sha256_unavailable"); }
    }
}
