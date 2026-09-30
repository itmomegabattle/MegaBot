import crypto from 'node:crypto';
import type { SimulationState, TelegramInboxEntry } from './types.js';

export function telegramUpdateChatKey(update: Record<string, any>) {
  return String(
    update.callback_query?.message?.chat?.id
    || update.callback_query?.from?.id
    || update.message?.chat?.id
    || update.chat_member?.chat?.id
    || update.my_chat_member?.chat?.id
    || 'unknown',
  );
}

export function recordTelegramUpdates(state: SimulationState, updates: unknown[], now = new Date()) {
  state.settings ||= {};
  const inbox = state.settings.telegramInbox ||= [];
  const inserted: TelegramInboxEntry[] = [];
  const existing: TelegramInboxEntry[] = [];
  for (const rawUpdate of updates) {
    if (!rawUpdate || typeof rawUpdate !== 'object' || Array.isArray(rawUpdate)) continue;
    const update = rawUpdate as Record<string, any>;
    const updateId = Number(update.update_id);
    if (!Number.isSafeInteger(updateId) || updateId < 0) continue;
    const duplicate = inbox.find((entry) => entry.updateId === updateId);
    if (duplicate) {
      existing.push(duplicate);
      continue;
    }
    const timestamp = now.toISOString();
    const entry: TelegramInboxEntry = {
      updateId,
      chatKey: telegramUpdateChatKey(update),
      payload: structuredClone(update),
      status: 'received',
      receivedAt: timestamp,
      availableAt: timestamp,
      attempts: 0,
      updatedAt: timestamp,
    };
    inbox.push(entry);
    inserted.push(entry);
  }
  return { inserted, existing };
}

export function claimTelegramInboxEntry(entry: TelegramInboxEntry, now = new Date(), leaseMs = 60_000) {
  const nowMs = now.getTime();
  if (entry.status === 'processing' && (!entry.leasedUntil || Date.parse(entry.leasedUntil) <= nowMs)) {
    entry.status = 'retry';
    entry.lastError = 'Processing lease expired';
  }
  if (!['received', 'retry'].includes(entry.status) || Date.parse(entry.availableAt) > nowMs) return undefined;
  const leaseToken = crypto.randomUUID();
  entry.status = 'processing';
  entry.leaseToken = leaseToken;
  entry.leasedUntil = new Date(nowMs + leaseMs).toISOString();
  entry.lastAttemptAt = now.toISOString();
  entry.attempts += 1;
  entry.updatedAt = now.toISOString();
  return leaseToken;
}

export function completeTelegramInboxEntry(entry: TelegramInboxEntry, leaseToken: string, now = new Date()) {
  if (entry.status !== 'processing' || entry.leaseToken !== leaseToken) return false;
  entry.status = 'completed';
  entry.leaseToken = undefined;
  entry.leasedUntil = undefined;
  entry.lastError = undefined;
  entry.processedAt = now.toISOString();
  entry.updatedAt = now.toISOString();
  return true;
}

export function failTelegramInboxEntry(
  entry: TelegramInboxEntry,
  leaseToken: string,
  error: unknown,
  now = new Date(),
  maxAttempts = 10,
) {
  if (entry.status !== 'processing' || entry.leaseToken !== leaseToken) return false;
  entry.leaseToken = undefined;
  entry.leasedUntil = undefined;
  entry.lastError = String(error instanceof Error ? error.message : error).slice(0, 1_000);
  entry.updatedAt = now.toISOString();
  if (entry.attempts >= maxAttempts) {
    entry.status = 'failed';
  } else {
    entry.status = 'retry';
    const delaySeconds = Math.min(5 * 60, 2 ** Math.max(0, entry.attempts - 1));
    entry.availableAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  }
  return true;
}
