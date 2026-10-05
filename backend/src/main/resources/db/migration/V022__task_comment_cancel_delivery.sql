ALTER TABLE task_manual_intents DROP CONSTRAINT task_manual_intents_action_check;
ALTER TABLE task_manual_intents ADD CONSTRAINT task_manual_intents_action_check
    CHECK (action IN ('manual_reminder','created','status','updated','claim','release','comment','cancel'));
ALTER TABLE task_manual_intents DROP CONSTRAINT task_status_intent_shape;
ALTER TABLE task_manual_intents ADD CONSTRAINT task_status_intent_shape CHECK (
    (action='status' AND task_status IS NOT NULL AND task_status IN ('open','assigned','waiting','in_progress','completed'))
    OR (action='claim' AND task_status IS NOT NULL AND task_status='assigned')
    OR (action IN ('release','comment') AND task_status IS NOT NULL AND task_status IN ('open','assigned','waiting','in_progress'))
    OR (action='cancel' AND task_status IS NOT NULL AND task_status='cancelled')
    OR (action NOT IN ('status','claim','release','comment','cancel') AND task_status IS NULL));
CREATE INDEX task_comment_cancel_outbox_idx ON outbox_events(aggregate_id,available_at,id)
    WHERE event_type IN ('task.comment','task.cancel') AND status IN ('pending','retry');
