CREATE TABLE meeting_notification_events (
    id text PRIMARY KEY REFERENCES outbox_events(id),
    meeting_id text NOT NULL REFERENCES meetings(id),
    meeting_version bigint NOT NULL CHECK (meeting_version>=0),
    actor_id text NOT NULL REFERENCES users(id),
    action text NOT NULL CHECK (action IN ('created','updated','cancelled')),
    expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','cancelled','expired','unavailable')),
    unavailable_count integer NOT NULL DEFAULT 0 CHECK (unavailable_count>=0)
);
CREATE TABLE meeting_notification_targets (
    id text PRIMARY KEY,
    event_id text NOT NULL REFERENCES meeting_notification_events(id),
    target_key text NOT NULL,
    recipient_id text REFERENCES users(id),
    chat_id bigint NOT NULL CHECK (chat_id<>0),
    message_thread_id bigint,
    bot_id text,
    kind text NOT NULL CHECK (kind IN ('invited','removed','group')),
    UNIQUE(event_id,target_key),
    CHECK ((kind='group' AND recipient_id IS NULL AND chat_id<0 AND message_thread_id IS NOT NULL AND message_thread_id>0 AND bot_id IS NOT NULL AND bot_id ~ '^[0-9]{1,20}$')
        OR (kind<>'group' AND recipient_id IS NOT NULL AND chat_id>0 AND message_thread_id IS NULL AND bot_id IS NULL))
);
ALTER TABLE notification_deliveries ADD COLUMN meeting_target_id text REFERENCES meeting_notification_targets(id);
CREATE INDEX meeting_notification_deliveries_idx ON notification_deliveries(meeting_target_id,status);
CREATE INDEX meeting_notification_outbox_idx ON outbox_events(aggregate_id,available_at,id)
    WHERE aggregate_type='meeting' AND event_type IN ('meeting.created','meeting.updated','meeting.cancelled') AND status IN ('pending','retry');
