import assert from 'node:assert/strict';
import {
  applyTelegramDeliveryOutcome,
  claimNotificationDelivery,
  createNotificationDelivery,
  notificationDeliverySummary,
  retryNotificationDelivery,
} from '../src/notificationDelivery.js';
import { sanitizeSimulationState } from '../src/stateMaintenance.js';

const start = new Date('2026-09-28T09:00:00.000Z');
const rateLimited = createNotificationDelivery({
  id: 'delivery-rate-limit', dedupeKey: 'broadcast-1:user-1', category: 'broadcast',
  recipientId: 'user-1', chatId: '100', text: 'Проверка', disableNotification: true,
}, start);
const firstLease = claimNotificationDelivery(rateLimited, start);
assert.ok(firstLease);
assert.equal(rateLimited.status, 'sending');
assert.equal(rateLimited.attempts, 1);
assert.equal(applyTelegramDeliveryOutcome(rateLimited, firstLease, {
  kind: 'rate_limited', retryAfterSeconds: 17, code: '429', message: 'Too Many Requests',
}, start), true);
assert.equal(rateLimited.status, 'retry');
assert.equal(rateLimited.availableAt, '2026-09-28T09:00:17.000Z');
assert.equal(claimNotificationDelivery(rateLimited, new Date('2026-09-28T09:00:16.999Z')), undefined);
const secondLease = claimNotificationDelivery(rateLimited, new Date('2026-09-28T09:00:17.000Z'));
assert.ok(secondLease);
applyTelegramDeliveryOutcome(rateLimited, secondLease, { kind: 'sent', messageId: 501 }, new Date('2026-09-28T09:00:18.000Z'));
assert.equal(rateLimited.status, 'sent');
assert.equal(rateLimited.telegramMessageId, 501);

const forbidden = createNotificationDelivery({ category: 'task', chatId: '200', text: 'Задача' }, start);
const forbiddenLease = claimNotificationDelivery(forbidden, start)!;
applyTelegramDeliveryOutcome(forbidden, forbiddenLease, { kind: 'forbidden', code: '403', message: 'bot was blocked' }, start);
assert.equal(forbidden.status, 'failed');
assert.equal(claimNotificationDelivery(forbidden, new Date('2026-09-28T10:00:00.000Z')), undefined);
assert.equal(retryNotificationDelivery(forbidden, new Date('2026-09-28T10:00:00.000Z')), true);
assert.equal(forbidden.status, 'retry');

const unknown = createNotificationDelivery({ category: 'meeting', chatId: '300', text: 'Встреча' }, start);
const unknownLease = claimNotificationDelivery(unknown, start)!;
applyTelegramDeliveryOutcome(unknown, unknownLease, { kind: 'unknown', code: 'timeout' }, start);
assert.equal(unknown.status, 'unknown');
assert.equal(claimNotificationDelivery(unknown, new Date('2026-09-29T09:00:00.000Z')), undefined, 'unknown must never retry automatically');

const expired = createNotificationDelivery({
  category: 'reminder', chatId: '400', text: 'Устарело', expiresAt: '2026-09-28T08:59:59.000Z',
}, start);
assert.equal(claimNotificationDelivery(expired, start), undefined);
assert.equal(expired.status, 'expired');

const summary = notificationDeliverySummary([rateLimited, forbidden, unknown, expired]);
assert.equal(summary.byStatus.sent, 1);
assert.equal(summary.byStatus.retry, 1);
assert.equal(summary.attention, 1);

const restarted = sanitizeSimulationState({
  users: [], availabilities: {}, meetings: [], tasks: [], messages: {},
  settings: { notificationDeliveries: [rateLimited, forbidden, unknown] },
}).settings?.notificationDeliveries || [];
assert.equal(claimNotificationDelivery(restarted.find((item) => item.status === 'sent')!, new Date('2026-09-30T09:00:00.000Z')), undefined);
assert.equal(claimNotificationDelivery(restarted.find((item) => item.status === 'unknown')!, new Date('2026-09-30T09:00:00.000Z')), undefined);
assert.ok(claimNotificationDelivery(restarted.find((item) => item.status === 'retry')!, new Date('2026-09-30T09:00:00.000Z')));

const manyDeliveries = Array.from({ length: 130 }, (_, index) => createNotificationDelivery({
  id: `delivery-${index}`, dedupeKey: `dedupe-${index}`, category: 'test', chatId: String(index + 1), text: `Message ${index}`,
}, new Date(start.getTime() + index)));
const sanitized = sanitizeSimulationState({
  users: [], availabilities: {}, meetings: [], tasks: [], messages: {},
  settings: { notificationDeliveries: manyDeliveries },
});
assert.equal(sanitized.settings?.notificationDeliveries?.length, 130, 'pending delivery history must not be silently truncated');

console.log('Notification delivery verification passed: 429 retry_after, 403 terminal failure, timeout uncertainty, manual retry, expiry, and non-truncating persistence.');
