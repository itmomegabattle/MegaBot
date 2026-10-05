CREATE TABLE delivery_rate_limits (
    bucket_key text PRIMARY KEY,
    next_at timestamptz NOT NULL DEFAULT '-infinity',
    blocked_until timestamptz NOT NULL DEFAULT '-infinity',
    updated_at timestamptz NOT NULL DEFAULT now()
);
