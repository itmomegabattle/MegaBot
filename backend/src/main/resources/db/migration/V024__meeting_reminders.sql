ALTER TABLE meeting_notification_events DROP CONSTRAINT meeting_notification_events_action_check;
ALTER TABLE meeting_notification_events ADD CONSTRAINT meeting_notification_events_action_check
    CHECK (action IN ('created','updated','cancelled','reminder'));
DROP INDEX meeting_notification_outbox_idx;
CREATE INDEX meeting_notification_outbox_idx ON outbox_events(aggregate_id,available_at,id)
    WHERE aggregate_type='meeting'
      AND event_type IN ('meeting.created','meeting.updated','meeting.cancelled','meeting.reminder')
      AND status IN ('pending','retry');
