ALTER TABLE telegram_slot_drafts ADD COLUMN pending_weeks jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(pending_weeks) = 'object');
