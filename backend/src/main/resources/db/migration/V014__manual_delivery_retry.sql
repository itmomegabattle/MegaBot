ALTER TABLE notification_deliveries ADD COLUMN retry_of text REFERENCES notification_deliveries(id);
ALTER TABLE notification_deliveries ADD CONSTRAINT delivery_one_manual_retry UNIQUE (retry_of);
ALTER TABLE notification_deliveries ADD CONSTRAINT delivery_retry_not_self CHECK (retry_of IS NULL OR retry_of<>id);
CREATE INDEX broadcast_delivery_journal_idx ON notification_deliveries(broadcast_target_id,id);
