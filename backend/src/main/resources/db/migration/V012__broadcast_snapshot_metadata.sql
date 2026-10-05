ALTER TABLE broadcasts ADD COLUMN title text NOT NULL DEFAULT '';
ALTER TABLE broadcasts ADD COLUMN recipient_mode text NOT NULL DEFAULT 'people'
    CHECK (recipient_mode IN ('all','people','blocks','missing_slots'));
ALTER TABLE broadcasts ADD COLUMN week_start date CHECK (extract(isodow FROM week_start)=1);
ALTER TABLE broadcast_targets ALTER COLUMN chat_id DROP NOT NULL;
ALTER TABLE broadcast_targets ADD COLUMN availability text NOT NULL DEFAULT 'ready'
    CHECK (availability IN ('ready','unavailable'));
ALTER TABLE broadcast_targets ADD CONSTRAINT broadcast_target_ready_has_chat CHECK (availability<>'ready' OR chat_id IS NOT NULL);
CREATE INDEX broadcast_delivery_revision_idx ON notification_deliveries(broadcast_target_id,status);
