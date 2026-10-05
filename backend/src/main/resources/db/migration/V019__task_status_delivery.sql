ALTER TABLE task_manual_intents DROP CONSTRAINT task_manual_intents_action_check;
ALTER TABLE task_manual_intents ADD CONSTRAINT task_manual_intents_action_check
    CHECK (action IN ('manual_reminder','created','status'));
ALTER TABLE task_manual_intents ADD COLUMN task_status text;
ALTER TABLE task_manual_intents ADD CONSTRAINT task_status_intent_shape CHECK (
    (action='status' AND task_status IS NOT NULL AND task_status IN ('open','assigned','waiting','in_progress','completed'))
    OR (action<>'status' AND task_status IS NULL));
CREATE INDEX task_status_outbox_idx ON outbox_events(aggregate_id,available_at,id)
    WHERE event_type='task.status' AND status IN ('pending','retry');
