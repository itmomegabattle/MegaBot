ALTER TABLE notification_deliveries
    ADD COLUMN command_reply_outbox_id text UNIQUE REFERENCES outbox_events(id),
    ADD CONSTRAINT command_reply_source CHECK
        ((category = 'telegram_command_reply') = (command_reply_outbox_id IS NOT NULL));
