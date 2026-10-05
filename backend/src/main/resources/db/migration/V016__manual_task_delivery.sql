CREATE TABLE task_manual_intents (
    id text PRIMARY KEY REFERENCES outbox_events(id),
    task_id text NOT NULL REFERENCES tasks(id),
    task_version bigint NOT NULL CHECK (task_version>=0),
    actor_id text NOT NULL REFERENCES users(id),
    expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','expired','unavailable','cancelled')),
    unavailable_count integer NOT NULL DEFAULT 0 CHECK (unavailable_count>=0),
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notification_deliveries ADD COLUMN task_manual_id text REFERENCES task_manual_intents(id);
CREATE INDEX task_manual_deliveries_idx ON notification_deliveries(task_manual_id,status);
CREATE INDEX manual_task_outbox_idx ON outbox_events(aggregate_id,available_at,id)
    WHERE event_type='task.manual_reminder' AND status IN ('pending','retry');
