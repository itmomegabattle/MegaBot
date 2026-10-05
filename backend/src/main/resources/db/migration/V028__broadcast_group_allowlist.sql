CREATE TABLE broadcast_group_targets (
    id text PRIMARY KEY,
    label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
    bot_id text NOT NULL CHECK (bot_id ~ '^[0-9]{1,20}$'),
    chat_id bigint NOT NULL CHECK (chat_id < 0),
    message_thread_id bigint CHECK (message_thread_id > 0),
    active boolean NOT NULL,
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    approved_by text NOT NULL REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE NULLS NOT DISTINCT (bot_id, chat_id, message_thread_id)
);
ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_recipient_mode_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_recipient_mode_check CHECK (recipient_mode IN ('all','people','blocks','missing_slots','groups'));
ALTER TABLE broadcast_targets ADD COLUMN group_target_id text REFERENCES broadcast_group_targets(id);
ALTER TABLE broadcast_targets ADD COLUMN approval_version bigint;
ALTER TABLE broadcast_targets ADD COLUMN bot_id text;
ALTER TABLE broadcast_targets ADD CONSTRAINT broadcast_group_snapshot CHECK (
    (group_target_id IS NULL AND approval_version IS NULL AND bot_id IS NULL)
    OR (group_target_id IS NOT NULL AND approval_version IS NOT NULL AND approval_version >= 0 AND bot_id IS NOT NULL
        AND recipient_id IS NULL AND chat_id < 0 AND (message_thread_id IS NULL OR message_thread_id > 0))
);
