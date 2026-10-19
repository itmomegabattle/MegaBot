ALTER TABLE telegram_meeting_drafts
    DROP CONSTRAINT telegram_meeting_drafts_status_check,
    DROP CONSTRAINT telegram_meeting_drafts_step_check,
    ADD COLUMN meeting_id text REFERENCES meetings(id),
    ADD CHECK (status IN ('open', 'cancelled', 'completed')),
    ADD CHECK (step IN ('choose_type', 'pick_competency', 'confirm_competency', 'topic', 'description', 'date', 'time')),
    ADD CHECK ((status = 'completed') = (meeting_id IS NOT NULL));
