CREATE TABLE users (
    id text PRIMARY KEY,
    telegram_id bigint UNIQUE,
    username text NOT NULL,
    real_name text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'organizer', 'faculty_responsible', 'faculty_helper')),
    registered boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    birthday_day smallint CHECK (birthday_day BETWEEN 1 AND 31),
    birthday_month smallint CHECK (birthday_month BETWEEN 1 AND 12),
    birthday_year smallint CHECK (birthday_year BETWEEN 1900 AND 2100),
    joined_at timestamptz,
    last_seen_at timestamptz,
    deactivated_at timestamptz,
    deactivated_by text REFERENCES users(id),
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((birthday_day IS NULL) = (birthday_month IS NULL)),
    CHECK (active OR deactivated_at IS NOT NULL)
);

CREATE INDEX users_active_role_idx ON users (active, role);
CREATE INDEX users_username_lower_idx ON users (lower(username));

CREATE TABLE user_avatars (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    content bytea NOT NULL,
    checksum text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (octet_length(content) <= 1048576)
);

CREATE TABLE competencies (
    id text PRIMARY KEY,
    name text NOT NULL,
    scope text NOT NULL CHECK (scope IN ('core', 'faculty')),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope, name)
);

CREATE TABLE user_competencies (
    user_id text NOT NULL REFERENCES users(id),
    competency_id text NOT NULL REFERENCES competencies(id),
    is_primary boolean NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, competency_id)
);

CREATE UNIQUE INDEX user_competencies_one_primary_idx
    ON user_competencies (user_id) WHERE is_primary;

CREATE TABLE faculties (
    id text PRIMARY KEY,
    name text NOT NULL UNIQUE,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE faculty_memberships (
    user_id text PRIMARY KEY REFERENCES users(id),
    faculty_id text NOT NULL REFERENCES faculties(id),
    faculty_role text NOT NULL CHECK (faculty_role IN ('responsible', 'helper', 'member')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX faculty_memberships_faculty_idx ON faculty_memberships (faculty_id);

CREATE TABLE work_events (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text,
    starts_at timestamptz,
    ends_at timestamptz,
    status text NOT NULL CHECK (status IN ('active', 'archived')),
    created_by text REFERENCES users(id),
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX work_events_status_starts_idx ON work_events (status, starts_at);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_active_idx ON sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE app_settings (
    setting_key text PRIMARY KEY,
    setting_value jsonb NOT NULL,
    version bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
    id text PRIMARY KEY,
    actor_id text REFERENCES users(id),
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    action text NOT NULL,
    changes jsonb,
    request_id text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, occurred_at DESC);
