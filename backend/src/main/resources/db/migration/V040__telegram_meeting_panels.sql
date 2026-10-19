ALTER TABLE telegram_meeting_drafts ADD COLUMN panel jsonb
    CHECK (panel IS NULL OR jsonb_typeof(panel) = 'object');
