-- Keep the original planned/retry vocabulary; distinguish a lease from an HTTP attempt.
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_status_check;
ALTER TABLE notification_deliveries ADD COLUMN claimed_at timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN request_started_at timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN response_at timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE notification_deliveries ADD COLUMN initial_available_at timestamptz;
UPDATE notification_deliveries SET initial_available_at=available_at;
ALTER TABLE notification_deliveries ALTER COLUMN initial_available_at SET NOT NULL;
ALTER TABLE notification_deliveries ALTER COLUMN initial_available_at SET DEFAULT clock_timestamp();

-- Existing sending rows have no proof that an HTTP request did not start. Never replay them on upgrade.
UPDATE notification_deliveries SET status='unknown',lease_token=NULL,leased_until=NULL,
    last_error_code='migration_uncertain',updated_at=now() WHERE status='sending';

ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_check
    CHECK (status IN ('planned','claimed','sending','sent','retry','failed','unknown','cancelled','expired'));
ALTER TABLE notification_deliveries ADD CONSTRAINT delivery_claim_has_lease
    CHECK (status <> 'claimed' OR (lease_token IS NOT NULL AND leased_until IS NOT NULL));
ALTER TABLE notification_deliveries ADD CONSTRAINT delivery_sending_has_attempt
    CHECK (status <> 'sending' OR (lease_token IS NOT NULL AND leased_until IS NOT NULL AND request_started_at IS NOT NULL));

CREATE INDEX notification_deliveries_lease_expiry_idx ON notification_deliveries (leased_until,id)
    WHERE status IN ('claimed','sending');
