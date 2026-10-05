CREATE TABLE task_recovery_operations (
    id text PRIMARY KEY,
    mode text NOT NULL CHECK (mode IN ('archive', 'season-reset')),
    actor_id text REFERENCES users(id),
    preview_fingerprint text NOT NULL,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'array'),
    task_count integer NOT NULL CHECK (task_count >= 0),
    created_at timestamptz NOT NULL,
    restored_at timestamptz,
    restored_by text REFERENCES users(id),
    CHECK ((restored_at IS NULL) = (restored_by IS NULL))
);

-- Hide, never physically delete: preserve comments, history, assignments and scheduling markers.
ALTER TABLE tasks ADD COLUMN removed_at timestamptz;
ALTER TABLE tasks ADD COLUMN removal_operation_id text REFERENCES task_recovery_operations(id);
ALTER TABLE tasks ADD CONSTRAINT task_removal_pair CHECK ((removed_at IS NULL) = (removal_operation_id IS NULL));
CREATE INDEX tasks_removal_operation_idx ON tasks(removal_operation_id) WHERE removal_operation_id IS NOT NULL;
