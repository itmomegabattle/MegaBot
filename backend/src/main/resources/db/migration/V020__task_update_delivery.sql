ALTER TABLE task_manual_intents DROP CONSTRAINT task_manual_intents_action_check;
ALTER TABLE task_manual_intents ADD CONSTRAINT task_manual_intents_action_check
    CHECK (action IN ('manual_reminder','created','status','updated'));
CREATE INDEX task_update_outbox_idx ON outbox_events(aggregate_id,available_at,id)
    WHERE event_type='task.updated' AND status IN ('pending','retry');
