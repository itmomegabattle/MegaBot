CREATE TABLE availability_week_metadata (
    week_start date PRIMARY KEY,
    title text,
    description text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (extract(isodow FROM week_start) = 1)
);

CREATE TABLE availability_weeks (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    week_start date NOT NULL,
    out_of_week boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, week_start),
    UNIQUE (id, week_start),
    CHECK (extract(isodow FROM week_start) = 1)
);

CREATE INDEX availability_weeks_week_user_idx ON availability_weeks (week_start, user_id);

CREATE TABLE availability_days (
    id text PRIMARY KEY,
    week_id text NOT NULL,
    week_start date NOT NULL,
    day_date date NOT NULL,
    status text NOT NULL CHECK (status IN ('unanswered', 'available', 'unavailable')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (week_id, week_start) REFERENCES availability_weeks(id, week_start) ON DELETE CASCADE,
    UNIQUE (week_id, day_date),
    CHECK (day_date BETWEEN week_start AND week_start + 6)
);

CREATE INDEX availability_days_date_idx ON availability_days (day_date, status);

CREATE TABLE availability_slots (
    day_id text NOT NULL REFERENCES availability_days(id) ON DELETE CASCADE,
    start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1380 AND start_minute % 60 = 0),
    PRIMARY KEY (day_id, start_minute)
);

CREATE TABLE meetings (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('meeting', 'setup', 'vibe')),
    title text NOT NULL,
    event_id text REFERENCES work_events(id),
    starts_at timestamptz NOT NULL,
    duration_minutes smallint NOT NULL CHECK (duration_minutes BETWEEN 30 AND 360),
    zone_id text NOT NULL,
    host_id text NOT NULL REFERENCES users(id),
    audience_mode text NOT NULL CHECK (audience_mode IN ('all', 'selected', 'block')),
    competency_id text REFERENCES competencies(id),
    topic text,
    description text,
    status text NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled')),
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (kind <> 'setup' OR (event_id IS NOT NULL AND duration_minutes = 60))
);

CREATE INDEX meetings_starts_status_idx ON meetings (starts_at, status);
CREATE INDEX meetings_event_idx ON meetings (event_id, starts_at);

CREATE TABLE meeting_invitations (
    meeting_id text NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id),
    rsvp text NOT NULL DEFAULT 'unanswered' CHECK (rsvp IN ('unanswered', 'yes', 'no')),
    responded_at timestamptz,
    legacy_source boolean NOT NULL DEFAULT false,
    PRIMARY KEY (meeting_id, user_id),
    CHECK ((rsvp = 'unanswered' AND responded_at IS NULL) OR rsvp <> 'unanswered')
);

CREATE INDEX meeting_invitations_user_idx ON meeting_invitations (user_id, rsvp);

CREATE TABLE calendar_links (
    meeting_id text PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    calendar_id text NOT NULL,
    external_event_id text NOT NULL,
    synced_version bigint NOT NULL,
    last_success_at timestamptz,
    last_error_code text,
    UNIQUE (calendar_id, external_event_id)
);
