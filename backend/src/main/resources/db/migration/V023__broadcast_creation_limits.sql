CREATE TABLE broadcast_creation_limits (
    author_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    request_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    request_count bigint NOT NULL DEFAULT 0 CHECK (request_count>=0),
    volume_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    volume_count bigint NOT NULL DEFAULT 0 CHECK (volume_count>=0)
);
