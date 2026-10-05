-- Keep the configured reminder when a completed task temporarily pauses scheduling.
ALTER TABLE task_reminders ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE task_reminders ADD CONSTRAINT task_reminders_enabled_check CHECK (enabled OR NOT active);

UPDATE task_reminders r SET anchor_at = CASE WHEN r.type = 'repeat' THEN t.created_at ELSE t.due_at END
FROM tasks t WHERE r.task_id = t.id AND r.anchor_at IS NULL;
-- A legacy reminder with no usable deadline cannot be scheduled safely.
UPDATE task_reminders SET enabled = false, active = false, next_due_at = NULL WHERE anchor_at IS NULL;
UPDATE task_reminders r SET active = false, next_due_at = NULL FROM tasks t
WHERE r.task_id = t.id AND (t.status IN ('completed', 'cancelled') OR (r.type = 'before_deadline' AND r.sent_at IS NOT NULL));
UPDATE task_reminders SET next_due_at = CASE WHEN type = 'repeat'
    THEN anchor_at + value * CASE WHEN unit = 'days' THEN interval '24 hours' ELSE interval '1 hour' END
    ELSE anchor_at - value * CASE WHEN unit = 'days' THEN interval '24 hours' ELSE interval '1 hour' END END
WHERE active AND next_due_at IS NULL;

-- Completion text and discussion are both append-only, but have different frontend projections.
ALTER TABLE task_comments ADD COLUMN kind text NOT NULL DEFAULT 'discussion'
    CHECK (kind IN ('discussion', 'completion'));
ALTER TABLE task_comments ADD COLUMN task_version bigint CHECK (task_version IS NULL OR task_version >= 0);
