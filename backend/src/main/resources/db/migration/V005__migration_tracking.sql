CREATE TABLE migration_runs (
    id text PRIMARY KEY,
    source_revision text NOT NULL,
    source_checksum text NOT NULL,
    status text NOT NULL CHECK (status IN ('started', 'validated', 'imported', 'rejected', 'failed')),
    statistics jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (source_revision, source_checksum),
    CHECK ((status IN ('imported', 'rejected', 'failed')) = (finished_at IS NOT NULL))
);

CREATE TABLE migration_rejects (
    id text PRIMARY KEY,
    migration_run_id text NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
    source_type text NOT NULL,
    source_key text,
    reason_code text NOT NULL,
    reason_summary text NOT NULL,
    source_fragment jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX migration_rejects_run_idx ON migration_rejects (migration_run_id, source_type);
