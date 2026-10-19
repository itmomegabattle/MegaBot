CREATE TABLE telegram_task_drafts (
    id text PRIMARY KEY,
    bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,19}$'),
    chat_id bigint NOT NULL CHECK (chat_id > 0),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_version bigint NOT NULL CHECK (profile_version >= 0),
    recipient_role text NOT NULL CHECK (recipient_role IN ('faculty_responsible','faculty_helper')),
    faculty_id text NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
    step text NOT NULL DEFAULT 'pick' CHECK (step IN ('pick','status','confirm')),
    choices jsonb NOT NULL CHECK (jsonb_typeof(choices)='array' AND jsonb_array_length(choices) BETWEEN 1 AND 10),
    selected_index integer CHECK (selected_index BETWEEN 0 AND 9),
    selected_status text CHECK (selected_status IN ('waiting','in_progress','completed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
    CHECK (expires_at > created_at),
    CHECK ((step='pick' AND selected_index IS NULL AND selected_status IS NULL)
        OR (step='status' AND selected_index IS NOT NULL AND selected_status IS NULL)
        OR (step='confirm' AND selected_index IS NOT NULL AND selected_status IS NOT NULL)),
    CHECK (selected_index IS NULL OR selected_index < jsonb_array_length(choices)),
    CHECK (status <> 'completed' OR step='confirm')
);
CREATE UNIQUE INDEX telegram_task_drafts_open_idx ON telegram_task_drafts(bot_id,chat_id) WHERE status='open';
