-- The existing audited task intent also serves creation notifications; its name is retained for compatibility.
ALTER TABLE task_manual_intents ADD COLUMN action text NOT NULL DEFAULT 'manual_reminder'
    CHECK (action IN ('manual_reminder','created'));
CREATE INDEX task_creation_outbox_idx ON outbox_events(aggregate_id,available_at,id)
    WHERE event_type='task.created' AND status IN ('pending','retry');
