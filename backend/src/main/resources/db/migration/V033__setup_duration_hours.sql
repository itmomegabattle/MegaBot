-- Preserve existing rows; enforce whole setup hours for new/updated records.
ALTER TABLE meetings DROP CONSTRAINT meetings_duration_minutes_check;
ALTER TABLE meetings DROP CONSTRAINT meetings_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_duration_by_kind CHECK (
    (kind = 'setup' AND duration_minutes BETWEEN 60 AND 720 AND duration_minutes % 60 = 0)
    OR (kind <> 'setup' AND duration_minutes BETWEEN 30 AND 360 AND duration_minutes % 30 = 0)
) NOT VALID;
ALTER TABLE meetings ADD CONSTRAINT meetings_setup_event CHECK (kind <> 'setup' OR event_id IS NOT NULL) NOT VALID;
