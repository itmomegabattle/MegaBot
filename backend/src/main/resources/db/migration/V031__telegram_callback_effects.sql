-- Independent of raw inbox payload retention: never purge this ledger with the 7-day inbox cleanup.
-- Written in the same transaction as handler effects and inbox completion, not at intake/claim.
CREATE TABLE telegram_callback_effects (
    bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,19}$'),
    callback_id text NOT NULL CHECK (octet_length(callback_id) BETWEEN 1 AND 256),
    first_inbox_id text NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (bot_id, callback_id)
);
