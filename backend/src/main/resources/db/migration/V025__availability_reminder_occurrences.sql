CREATE TABLE availability_reminder_occurrences (
    week_start date PRIMARY KEY CHECK (extract(isodow FROM week_start)=1),
    intended_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at>intended_at),
    state text NOT NULL CHECK (state IN ('queued','expired','unavailable')),
    unavailable_count integer NOT NULL DEFAULT 0 CHECK (unavailable_count>=0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE availability_reminder_targets (
    id text PRIMARY KEY,
    week_start date NOT NULL REFERENCES availability_reminder_occurrences(week_start),
    recipient_id text NOT NULL REFERENCES users(id),
    chat_id bigint CHECK (chat_id>0),
    state text NOT NULL CHECK (state IN ('queued','unavailable')),
    UNIQUE(week_start,recipient_id),
    CHECK (state<>'queued' OR chat_id IS NOT NULL)
);
ALTER TABLE notification_deliveries ADD COLUMN availability_reminder_target_id text REFERENCES availability_reminder_targets(id);
CREATE INDEX availability_reminder_deliveries_idx ON notification_deliveries(availability_reminder_target_id,status);
