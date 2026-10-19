ALTER TABLE telegram_slot_drafts ADD COLUMN panel jsonb
    CHECK (panel IS NULL OR (jsonb_typeof(panel)='object'
        AND jsonb_exists_all(panel,ARRAY['text','markup'])
        AND jsonb_typeof(panel->'text')='string' AND jsonb_typeof(panel->'markup')='object'));
