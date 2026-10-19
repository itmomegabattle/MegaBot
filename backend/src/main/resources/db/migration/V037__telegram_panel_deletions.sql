ALTER TABLE notification_deliveries
    ADD COLUMN panel_delete_source_id text REFERENCES notification_deliveries(id),
    ADD COLUMN panel_delete_replacement_id text REFERENCES notification_deliveries(id),
    ADD CONSTRAINT panel_delete_source CHECK (
        (category = 'telegram_panel_delete') = (panel_delete_source_id IS NOT NULL)
        AND (category = 'telegram_panel_delete') = (panel_delete_replacement_id IS NOT NULL));

CREATE UNIQUE INDEX telegram_panel_delete_target ON notification_deliveries
    ((payload->>'botId'), chat_id, (payload->>'targetMessageId'))
    WHERE category = 'telegram_panel_delete';
