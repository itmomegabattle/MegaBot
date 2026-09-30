import crypto from 'node:crypto';
import type { NotificationDelivery, NotificationDeliveryStatus } from './types.js';

export type TelegramDeliveryOutcome =
  | { kind: 'sent'; messageId: number }
  | { kind: 'rate_limited'; retryAfterSeconds: number; code?: string; message?: string }
  | { kind: 'forbidden'; code?: string; message?: string }
  | { kind: 'retryable'; code?: string; message?: string }
  | { kind: 'unknown'; code?: string; message?: string }
  | { kind: 'permanent'; code?: string; message?: string };

const TERMINAL = new Set<NotificationDeliveryStatus>(['sent', 'failed', 'unknown', 'cancelled', 'expired']);

export function createNotificationDelivery(input: {
  id?: string;
  dedupeKey?: string;
  category: string;
  recipientId?: string;
  chatId: string | number;
  text: string;
  replyMarkup?: Record<string, unknown>;
  messageThreadId?: number;
  disableNotification?: boolean;
  disableWebPagePreview?: boolean;
  intendedAt?: string;
  availableAt?: string;
  expiresAt?: string;
}, now = new Date()): NotificationDelivery {
  const timestamp = now.toISOString();
  const id = input.id || `delivery_${crypto.randomUUID()}`;
  return {
    id,
    dedupeKey: input.dedupeKey || id,
    category: input.category,
    recipientId: input.recipientId,
    chatId: String(input.chatId),
    text: input.text,
    replyMarkup: input.replyMarkup,
    messageThreadId: input.messageThreadId,
    disableNotification: Boolean(input.disableNotification),
    disableWebPagePreview: Boolean(input.disableWebPagePreview),
    intendedAt: input.intendedAt || timestamp,
    availableAt: input.availableAt || timestamp,
    expiresAt: input.expiresAt,
    status: 'planned',
    attempts: 0,
    updatedAt: timestamp,
  };
}

export function claimNotificationDelivery(delivery: NotificationDelivery, now = new Date(), leaseMs = 60_000) {
  const nowMs = now.getTime();
  if (delivery.expiresAt && Date.parse(delivery.expiresAt) <= nowMs) {
    delivery.status = 'expired';
    delivery.updatedAt = now.toISOString();
    return undefined;
  }
  if (delivery.status === 'sending' && (!delivery.leasedUntil || Date.parse(delivery.leasedUntil) <= nowMs)) {
    delivery.status = 'retry';
    delivery.lastErrorCode = 'lease_expired';
  }
  if (!['planned', 'retry'].includes(delivery.status) || Date.parse(delivery.availableAt) > nowMs) return undefined;
  const leaseToken = crypto.randomUUID();
  delivery.status = 'sending';
  delivery.leaseToken = leaseToken;
  delivery.leasedUntil = new Date(nowMs + leaseMs).toISOString();
  delivery.lastAttemptAt = now.toISOString();
  delivery.attempts += 1;
  delivery.updatedAt = now.toISOString();
  return leaseToken;
}

export function applyTelegramDeliveryOutcome(
  delivery: NotificationDelivery,
  leaseToken: string,
  outcome: TelegramDeliveryOutcome,
  now = new Date(),
) {
  if (delivery.status !== 'sending' || delivery.leaseToken !== leaseToken) return false;
  delivery.leaseToken = undefined;
  delivery.leasedUntil = undefined;
  delivery.updatedAt = now.toISOString();
  delivery.lastErrorCode = outcome.kind === 'sent' ? undefined : outcome.code || outcome.kind;
  delivery.lastErrorMessage = outcome.kind === 'sent' ? undefined : outcome.message;
  if (outcome.kind === 'sent') {
    delivery.status = 'sent';
    delivery.telegramMessageId = outcome.messageId;
    delivery.sentAt = now.toISOString();
  } else if (outcome.kind === 'rate_limited') {
    delivery.status = 'retry';
    delivery.availableAt = new Date(now.getTime() + Math.max(1, outcome.retryAfterSeconds) * 1000).toISOString();
  } else if (outcome.kind === 'retryable') {
    delivery.status = 'retry';
    const delaySeconds = Math.min(30 * 60, 30 * (2 ** Math.max(0, delivery.attempts - 1)));
    delivery.availableAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  } else if (outcome.kind === 'unknown') {
    delivery.status = 'unknown';
  } else {
    delivery.status = 'failed';
  }
  return true;
}

export function retryNotificationDelivery(delivery: NotificationDelivery, now = new Date()) {
  if (!TERMINAL.has(delivery.status) || delivery.status === 'sent' || delivery.status === 'cancelled' || delivery.status === 'expired') return false;
  delivery.status = 'retry';
  delivery.availableAt = now.toISOString();
  delivery.lastErrorCode = undefined;
  delivery.lastErrorMessage = undefined;
  delivery.updatedAt = now.toISOString();
  return true;
}

export function notificationDeliverySummary(deliveries: NotificationDelivery[]) {
  const byStatus = deliveries.reduce<Record<string, number>>((result, delivery) => {
    result[delivery.status] = (result[delivery.status] || 0) + 1;
    return result;
  }, {});
  const unfinished = deliveries.filter((delivery) => ['planned', 'sending', 'retry'].includes(delivery.status));
  return {
    total: deliveries.length,
    byStatus,
    pending: unfinished.length,
    attention: (byStatus.failed || 0) + (byStatus.unknown || 0),
    overloaded: unfinished.length >= 500,
    oldestPendingAt: unfinished.map((item) => item.intendedAt).sort()[0],
  };
}
