CREATE TABLE birthday_reminder_occurrences (
    id text PRIMARY KEY,
    birthday_user_id text NOT NULL REFERENCES users(id),
    birthday_date date NOT NULL,
    days_before smallint NOT NULL CHECK (days_before BETWEEN 0 AND 2),
    intended_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at>intended_at),
    collection_closes_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','expired','unavailable')),
    unavailable_count integer NOT NULL DEFAULT 0 CHECK (unavailable_count>=0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(birthday_user_id,birthday_date,days_before)
);
CREATE TABLE birthday_reminder_targets (
    id text PRIMARY KEY,
    occurrence_id text NOT NULL REFERENCES birthday_reminder_occurrences(id),
    recipient_id text NOT NULL REFERENCES users(id),
    chat_id bigint CHECK (chat_id>0),
    state text NOT NULL CHECK (state IN ('queued','unavailable')),
    UNIQUE(occurrence_id,recipient_id),
    CHECK (state<>'queued' OR chat_id IS NOT NULL)
);
ALTER TABLE notification_deliveries ADD COLUMN birthday_reminder_target_id text REFERENCES birthday_reminder_targets(id);
CREATE INDEX birthday_reminder_deliveries_idx ON notification_deliveries(birthday_reminder_target_id,status);
