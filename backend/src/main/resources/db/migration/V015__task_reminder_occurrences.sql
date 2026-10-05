CREATE TABLE task_reminder_occurrences (
    id text PRIMARY KEY,
    reminder_id text NOT NULL REFERENCES task_reminders(id),
    reminder_version bigint NOT NULL,
    task_id text NOT NULL REFERENCES tasks(id),
    task_version bigint NOT NULL,
    intended_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','expired','unavailable')),
    unavailable_count integer NOT NULL DEFAULT 0 CHECK (unavailable_count>=0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(reminder_id,reminder_version,intended_at)
);
ALTER TABLE notification_deliveries ADD COLUMN task_occurrence_id text REFERENCES task_reminder_occurrences(id);
CREATE INDEX task_occurrence_deliveries_idx ON notification_deliveries(task_occurrence_id,status);
