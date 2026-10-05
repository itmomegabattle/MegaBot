-- Keyset pagination across all tasks; existing per-task index covers individual history only.
CREATE INDEX task_status_history_log_cursor_idx ON task_status_history (occurred_at, id);
