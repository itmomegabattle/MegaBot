import crypto from 'node:crypto';
import type { SimulationState } from './types.js';

export type IdempotencyRecord = {
  key: string;
  actorId: string;
  operation: string;
  bodyHash: string;
  status: 'processing' | 'completed';
  responseStatus?: number;
  responseBody?: unknown;
  createdAt: string;
  completedAt?: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

export function idempotencyBodyHash(body: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalValue(body))).digest('hex');
}

export function idempotencyActor(body: Record<string, unknown>) {
  return String(body.requesterId || body.creatorId || body.hostId || '').trim();
}

export function findIdempotencyRecord(state: SimulationState, actorId: string, key: string) {
  return (state.settings?.idempotencyRecords || []).find((record) => record.actorId === actorId && record.key === key);
}

export function reserveIdempotency(
  state: SimulationState,
  input: Pick<IdempotencyRecord, 'actorId' | 'bodyHash' | 'key' | 'operation'>,
  now = new Date(),
) {
  state.settings ||= {};
  state.settings.idempotencyRecords ||= [];
  const existing = findIdempotencyRecord(state, input.actorId, input.key);
  if (existing) {
    if (existing.operation !== input.operation || existing.bodyHash !== input.bodyHash) {
      return { kind: 'conflict' as const, record: existing };
    }
    return { kind: existing.status === 'completed' ? 'replay' as const : 'processing' as const, record: existing };
  }
  if (state.settings.idempotencyRecords.length >= 5_000) return { kind: 'full' as const };
  const record: IdempotencyRecord = {
    ...input,
    status: 'processing',
    createdAt: now.toISOString(),
  };
  state.settings.idempotencyRecords.push(record);
  return { kind: 'reserved' as const, record };
}

export function completeIdempotency(
  state: SimulationState,
  actorId: string,
  key: string,
  responseStatus: number,
  responseBody: unknown,
  now = new Date(),
) {
  const record = findIdempotencyRecord(state, actorId, key);
  if (!record) return false;
  record.status = 'completed';
  record.responseStatus = responseStatus;
  record.responseBody = structuredClone(responseBody);
  record.completedAt = now.toISOString();
  return true;
}
