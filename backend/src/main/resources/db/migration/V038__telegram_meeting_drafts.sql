CREATE TABLE telegram_meeting_drafts (
    id text PRIMARY KEY,
    bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,19}$'),
    chat_id bigint NOT NULL CHECK (chat_id > 0),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_version bigint NOT NULL CHECK (profile_version >= 0),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
    step text NOT NULL CHECK (step IN ('choose_type', 'pick_competency', 'confirm_competency', 'topic')),
    payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '15 minutes',
    CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX telegram_meeting_drafts_open_idx ON telegram_meeting_drafts(bot_id, chat_id) WHERE status = 'open';
