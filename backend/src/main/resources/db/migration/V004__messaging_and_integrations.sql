CREATE TABLE chat_bindings (
    id text PRIMARY KEY,
    bot_id text NOT NULL,
    chat_id bigint NOT NULL,
    type text NOT NULL CHECK (type IN ('private', 'team', 'important')),
    important_thread_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bot_id, chat_id, type),
    CHECK (type <> 'important' OR important_thread_id IS NOT NULL)
);

CREATE TABLE telegram_group_members (
    chat_id bigint NOT NULL,
    telegram_id bigint NOT NULL,
    status text NOT NULL,
    observed_at timestamptz NOT NULL,
    PRIMARY KEY (chat_id, telegram_id)
);

CREATE TABLE telegram_inbox (
    id text PRIMARY KEY,
    bot_id text NOT NULL,
    update_id bigint NOT NULL,
    chat_key text NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    available_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL CHECK (status IN ('received', 'processing', 'retry', 'completed', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token text,
    leased_until timestamptz,
    last_error text,
    processed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bot_id, update_id)
);

CREATE INDEX telegram_inbox_claim_idx ON telegram_inbox (available_at, id)
    WHERE status IN ('received', 'retry');
CREATE INDEX telegram_inbox_chat_order_idx ON telegram_inbox (chat_key, update_id);

CREATE TABLE bot_messages (
    id text PRIMARY KEY,
    user_id text REFERENCES users(id),
    sender text NOT NULL CHECK (sender IN ('user', 'bot')),
    text text NOT NULL,
    buttons jsonb,
    occurred_at timestamptz NOT NULL
);

CREATE INDEX bot_messages_user_time_idx ON bot_messages (user_id, occurred_at DESC);

CREATE TABLE broadcasts (
    id text PRIMARY KEY,
    author_id text REFERENCES users(id),
    content_revision bigint NOT NULL DEFAULT 1 CHECK (content_revision > 0),
    content text NOT NULL,
    scheduled_at timestamptz,
    zone_id text NOT NULL DEFAULT 'Europe/Moscow',
    misfire_policy text NOT NULL CHECK (misfire_policy IN ('send_within_grace', 'skip', 'send_immediately')),
    expires_at timestamptz,
    status text NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'cancelled', 'expired')),
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at IS NULL OR scheduled_at IS NULL OR expires_at >= scheduled_at)
);

CREATE INDEX broadcasts_schedule_idx ON broadcasts (scheduled_at, id) WHERE status = 'scheduled';

CREATE TABLE broadcast_targets (
    id text PRIMARY KEY,
    broadcast_id text NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    revision bigint NOT NULL CHECK (revision > 0),
    target_key text NOT NULL,
    recipient_id text REFERENCES users(id),
    chat_id bigint NOT NULL,
    message_thread_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (broadcast_id, revision, target_key)
);

CREATE TABLE notification_deliveries (
    id text PRIMARY KEY,
    broadcast_target_id text REFERENCES broadcast_targets(id),
    operation_id text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    category text NOT NULL,
    recipient_id text REFERENCES users(id),
    chat_id bigint NOT NULL,
    message_thread_id bigint,
    payload jsonb NOT NULL,
    disable_notification boolean NOT NULL DEFAULT false,
    intended_at timestamptz NOT NULL,
    available_at timestamptz NOT NULL,
    expires_at timestamptz,
    status text NOT NULL CHECK (status IN ('planned', 'sending', 'sent', 'retry', 'failed', 'unknown', 'cancelled', 'expired')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token text,
    leased_until timestamptz,
    last_error_code text,
    telegram_message_id bigint,
    sent_at timestamptz,
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at IS NULL OR expires_at >= intended_at)
);

CREATE INDEX notification_deliveries_claim_idx ON notification_deliveries (available_at, id)
    WHERE status IN ('planned', 'retry');
CREATE INDEX notification_deliveries_recipient_idx ON notification_deliveries (recipient_id, created_at DESC);

CREATE TABLE delivery_attempts (
    id text PRIMARY KEY,
    delivery_id text NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    result_status text NOT NULL,
    provider_code text,
    provider_message_id bigint,
    error_summary text,
    UNIQUE (delivery_id, attempt_number)
);

CREATE TABLE integration_jobs (
    id text PRIMARY KEY,
    provider text NOT NULL CHECK (provider IN ('telegram', 'google_calendar', 'google_sheets')),
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    entity_version bigint NOT NULL,
    payload jsonb NOT NULL,
    available_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'failed', 'cancelled')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token text,
    leased_until timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, entity_type, entity_id, entity_version)
);

CREATE INDEX integration_jobs_claim_idx ON integration_jobs (available_at, id)
    WHERE status IN ('pending', 'retry');

CREATE TABLE idempotency_requests (
    id text PRIMARY KEY,
    actor_id text NOT NULL,
    operation text NOT NULL,
    request_key text NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL CHECK (status IN ('processing', 'completed')),
    result_code integer,
    result_body jsonb,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (actor_id, operation, request_key),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX idempotency_requests_expiry_idx ON idempotency_requests (expires_at);

CREATE TABLE outbox_events (
    id text PRIMARY KEY,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    available_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'failed', 'cancelled')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token text,
    leased_until timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_events_claim_idx ON outbox_events (available_at, id)
    WHERE status IN ('pending', 'retry');
