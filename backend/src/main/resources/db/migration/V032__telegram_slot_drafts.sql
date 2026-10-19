CREATE TABLE telegram_slot_drafts (
    id text PRIMARY KEY,
    bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,19}$'),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id bigint NOT NULL CHECK (chat_id > 0),
    profile_version bigint NOT NULL CHECK (profile_version >= 0),
    week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
    base_version bigint NOT NULL CHECK (base_version >= 0),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'saved', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '15 minutes',
    CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX telegram_slot_drafts_open_idx ON telegram_slot_drafts(bot_id, chat_id) WHERE status = 'open';
