ALTER TABLE telegram_slot_drafts ADD COLUMN day_baseline jsonb
    CHECK (day_baseline IS NULL OR (jsonb_typeof(day_baseline) = 'object'
        AND jsonb_exists_all(day_baseline, ARRAY['date', 'day'])));
