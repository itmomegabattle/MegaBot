CREATE TABLE tasks (
    id text PRIMARY KEY,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    sow text NOT NULL DEFAULT '',
    priority text NOT NULL CHECK (priority IN ('normal', 'important', 'critical')),
    status text NOT NULL CHECK (status IN ('open', 'assigned', 'completed', 'waiting', 'in_progress', 'cancelled')),
    event_id text REFERENCES work_events(id),
    faculty_id text REFERENCES faculties(id),
    creator_id text REFERENCES users(id),
    due_at timestamptz,
    legacy_deadline text,
    assignment_mode text NOT NULL DEFAULT 'shared' CHECK (assignment_mode = 'shared'),
    completed_by text REFERENCES users(id),
    time_spent_minutes integer CHECK (time_spent_minutes IS NULL OR time_spent_minutes >= 0),
    completed_at timestamptz,
    cancelled_at timestamptz,
    cancelled_by text REFERENCES users(id),
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX tasks_status_due_idx ON tasks (status, due_at);
CREATE INDEX tasks_event_status_idx ON tasks (event_id, status);
CREATE INDEX tasks_faculty_status_idx ON tasks (faculty_id, status);

CREATE TABLE task_assignees (
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id),
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
);

CREATE INDEX task_assignees_user_idx ON task_assignees (user_id, task_id);

CREATE TABLE task_competencies (
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    competency_id text NOT NULL REFERENCES competencies(id),
    PRIMARY KEY (task_id, competency_id)
);

CREATE TABLE task_tips (
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 0),
    text text NOT NULL,
    PRIMARY KEY (task_id, position)
);

CREATE TABLE task_comments (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id),
    author_id text REFERENCES users(id),
    target_assignee_id text REFERENCES users(id),
    side text NOT NULL CHECK (side IN ('executor', 'coordinator')),
    text text NOT NULL,
    legacy_source text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_comments_task_created_idx ON task_comments (task_id, created_at);

CREATE TABLE task_reminders (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type IN ('before_deadline', 'repeat')),
    value integer NOT NULL CHECK (value > 0),
    unit text NOT NULL CHECK (unit IN ('days', 'hours')),
    anchor_at timestamptz,
    next_due_at timestamptz,
    sent_at timestamptz,
    last_sent_at timestamptz,
    active boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 0
);

CREATE INDEX task_reminders_due_idx ON task_reminders (next_due_at, id) WHERE active;

CREATE TABLE task_status_history (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id),
    actor_id text REFERENCES users(id),
    previous_status text,
    new_status text NOT NULL,
    details jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_status_history_task_idx ON task_status_history (task_id, occurred_at);
