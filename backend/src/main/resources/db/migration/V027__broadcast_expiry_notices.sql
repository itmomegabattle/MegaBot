CREATE TABLE broadcast_expiry_notices (
    id text PRIMARY KEY,
    broadcast_id text NOT NULL REFERENCES broadcasts(id),
    revision bigint NOT NULL CHECK (revision > 0),
    author_id text NOT NULL REFERENCES users(id),
    chat_id bigint CHECK (chat_id > 0),
    state text NOT NULL CHECK (state IN ('queued', 'unavailable', 'expired')),
    intended_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > intended_at),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (broadcast_id, revision),
    CHECK (state <> 'queued' OR chat_id IS NOT NULL)
);
ALTER TABLE notification_deliveries ADD COLUMN broadcast_expiry_notice_id text REFERENCES broadcast_expiry_notices(id);
CREATE UNIQUE INDEX broadcast_expiry_notice_delivery_idx ON notification_deliveries(broadcast_expiry_notice_id);
