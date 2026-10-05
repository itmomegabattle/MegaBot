ALTER TABLE broadcast_targets ADD COLUMN part_count integer NOT NULL DEFAULT 1 CHECK (part_count BETWEEN 1 AND 20);
ALTER TABLE notification_deliveries ADD COLUMN part_number integer NOT NULL DEFAULT 1;
ALTER TABLE notification_deliveries ADD COLUMN part_count integer NOT NULL DEFAULT 1;
ALTER TABLE notification_deliveries ADD CONSTRAINT delivery_part_bounds CHECK (part_count BETWEEN 1 AND 20 AND part_number BETWEEN 1 AND part_count);
CREATE UNIQUE INDEX broadcast_original_part_idx ON notification_deliveries(broadcast_target_id,part_number)
    WHERE broadcast_target_id IS NOT NULL AND retry_of IS NULL;
CREATE INDEX broadcast_part_order_idx ON notification_deliveries(broadcast_target_id,part_number,status);

CREATE FUNCTION broadcast_part_ready(target text, number integer) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT count(*)=number-1 FROM notification_deliveries d
    WHERE d.broadcast_target_id=target AND d.part_number<number AND d.status='sent'
        AND NOT EXISTS(SELECT 1 FROM notification_deliveries child WHERE child.retry_of=d.id)
$$;

-- Shared recipient-level result for API and author expiry notice; retry leaves count once per part.
CREATE VIEW broadcast_target_delivery_summary AS
SELECT t.*,
    CASE WHEN t.availability='unavailable' OR a.total=0 THEN 'unavailable'
         WHEN t.part_count=1 AND a.total=1 THEN a.single_status
         WHEN a.total<>t.part_count THEN 'failed'
         WHEN a.sent=t.part_count THEN 'sent'
         WHEN a.unknown>0 THEN 'unknown'
         WHEN a.sent>0 THEN 'partial'
         WHEN a.claimed+a.sending>0 THEN 'sending'
         WHEN a.retry>0 THEN 'retry'
         WHEN a.planned>0 THEN 'planned'
         WHEN a.expired>0 THEN 'expired'
         WHEN a.failed>0 THEN 'failed' ELSE 'cancelled' END AS status,
    jsonb_build_object('planned',a.planned,'retry',a.retry,'claimed',a.claimed,'sending',a.sending,
        'sent',a.sent,'unknown',a.unknown,'expired',a.expired,'failed',a.failed,'cancelled',a.cancelled) AS part_counts
FROM broadcast_targets t LEFT JOIN LATERAL (
    SELECT count(*) AS total,max(d.status) AS single_status,
        count(*) FILTER (WHERE d.status='planned') AS planned,count(*) FILTER (WHERE d.status='retry') AS retry,
        count(*) FILTER (WHERE d.status='claimed') AS claimed,count(*) FILTER (WHERE d.status='sending') AS sending,
        count(*) FILTER (WHERE d.status='sent') AS sent,count(*) FILTER (WHERE d.status='unknown') AS unknown,
        count(*) FILTER (WHERE d.status='expired') AS expired,count(*) FILTER (WHERE d.status='failed') AS failed,
        count(*) FILTER (WHERE d.status='cancelled') AS cancelled
    FROM notification_deliveries d WHERE d.broadcast_target_id=t.id
        AND NOT EXISTS(SELECT 1 FROM notification_deliveries child WHERE child.retry_of=d.id)
) a ON true;
