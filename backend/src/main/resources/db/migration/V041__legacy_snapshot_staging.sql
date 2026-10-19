-- Quarantined source only: no domain rows, jobs or automatic import approval.
CREATE TABLE legacy_snapshot_sources (
    migration_run_id text PRIMARY KEY REFERENCES migration_runs(id),
    file_checksum text NOT NULL CHECK (file_checksum ~ '^[a-f0-9]{64}$'),
    source_kind text NOT NULL CHECK (source_kind IN ('sheets-backup-state', 'recovery-record-v1')),
    original_bytes bytea NOT NULL CHECK (octet_length(original_bytes) BETWEEN 2 AND 67108864),
    CHECK (encode(sha256(original_bytes), 'hex') = file_checksum)
);

CREATE TABLE legacy_staging_records (
    migration_run_id text NOT NULL REFERENCES legacy_snapshot_sources(migration_run_id),
    source_type text NOT NULL CHECK (length(source_type) > 0),
    source_key text NOT NULL CHECK (length(source_key) > 0),
    source_fragment jsonb NOT NULL,
    PRIMARY KEY (migration_run_id, source_type, source_key)
);

CREATE FUNCTION preserve_legacy_snapshot_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable_legacy_snapshot_source';
END;
$$;

CREATE TRIGGER legacy_snapshot_sources_immutable BEFORE UPDATE OR DELETE ON legacy_snapshot_sources
    FOR EACH ROW EXECUTE FUNCTION preserve_legacy_snapshot_source();
CREATE TRIGGER legacy_staging_records_immutable BEFORE UPDATE OR DELETE ON legacy_staging_records
    FOR EACH ROW EXECUTE FUNCTION preserve_legacy_snapshot_source();

CREATE FUNCTION preserve_archived_legacy_run_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.source_revision, NEW.source_checksum) IS DISTINCT FROM (OLD.source_revision, OLD.source_checksum)
       AND EXISTS (SELECT 1 FROM legacy_snapshot_sources WHERE migration_run_id = OLD.id) THEN
        RAISE EXCEPTION 'immutable_legacy_run_identity';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER migration_runs_archive_identity BEFORE UPDATE OF source_revision, source_checksum ON migration_runs
    FOR EACH ROW EXECUTE FUNCTION preserve_archived_legacy_run_identity();
