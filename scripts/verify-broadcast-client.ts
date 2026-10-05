import assert from 'node:assert/strict';
import { broadcastAction, BroadcastHttpError, broadcastJson, broadcastRequestKey, broadcastScheduledAt, broadcastTimeLabel } from '../src/broadcastClient';
import { readFormDraft, removeFormDraft, removeUserFormDrafts, writeFormDraft } from '../src/formDrafts';

const data = new Map<string, string>();
const storage = {
  get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); },
} as Storage;
assert.equal(broadcastScheduledAt('2026-10-06', '12:00'), '2026-10-06T09:00:00.000Z');
for (const [date, time] of [['2026-02-29','12:00'], ['2026-10-06','24:00'], ['','12:00'], ['2026-10-06','2:00']]) assert.equal(broadcastScheduledAt(date, time), null);
assert.match(broadcastTimeLabel('2026-10-06T09:00:00Z'), /12:00 МСК$/);
const request = { body: 'Тест', dispatchMode: 'scheduled', scheduledAt: '2026-10-06T09:00:00Z' };
const key = broadcastRequestKey(storage, 'alice', request);
assert.equal(broadcastRequestKey(storage, 'alice', request), key, 'retry retains key');
assert.throws(() => broadcastRequestKey(storage, 'alice', { ...request, body: 'Изменён' }), /Новая рассылка не создана/, 'changed unresolved intent requires explicit approval');
assert.notEqual(broadcastRequestKey(storage, 'bob', request), key, 'actor isolation');
writeFormDraft(storage, { userId: 'alice', kind: 'broadcast', entityId: 'new', context: '', payload: request });
const originalFetch = globalThis.fetch;
const originalTimer = globalThis.setTimeout;
try {
  const seen: string[] = [];
  globalThis.fetch = async (_, init) => {
    seen.push((init!.headers as Record<string,string>)['Idempotency-Key']);
    throw new TypeError('Failed to fetch');
  };
  for (let i = 0; i < 2; i++) await assert.rejects(broadcastJson('/api/team/broadcast', { body: request, key: broadcastRequestKey(storage, 'alice', request) }), /не создаст вторую/);
  assert.deepEqual(seen, [key, key]);
  assert.equal(readFormDraft<typeof request>(storage, 'alice', 'broadcast')?.payload.body, request.body, 'network failure retains draft');
  for (const status of [401,403,500]) {
    globalThis.fetch = async () => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(broadcastJson('/api/v1/broadcasts'), status === 401 ? /Сессия/ : status === 403 ? /доступа/ : /Повтори/);
  }
  globalThis.fetch = async () => new Response('<html>proxy error</html>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(broadcastJson('/api/v1/broadcasts'), /не подтвердил/);
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay: number) => {
    assert.equal(delay, 12000, 'HTTP request has bounded wait');
    return originalTimer(callback, 1);
  }) as typeof setTimeout;
  globalThis.fetch = async (_, init) => new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  await assert.rejects(broadcastJson('/api/v1/broadcasts'), /не подтвердил/);
  globalThis.setTimeout = originalTimer;
  globalThis.fetch = async () => new Response('{"broadcastId":"b","queued":1}', { status: 202, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await broadcastJson('/api/team/broadcast', { body: request, key })).broadcastId, 'b');
  const path = '/api/v1/broadcasts/b/deliveries/d/retry';
  const commands: { key: string; body: any }[] = [];
  globalThis.fetch = async (_, init) => {
    commands.push({ key: (init!.headers as Record<string,string>)['Idempotency-Key'], body: JSON.parse(init!.body as string) });
    if (commands.length === 1) throw new TypeError('reply lost after commit');
    return new Response('{"id":"child","version":8}', { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(broadcastAction(storage, 'alice', path, { expectedVersion: 7, acknowledgeDuplicateRisk: true }), /ключ безопасного повтора сохранён/);
  assert.equal((await broadcastAction(storage, 'alice', path, { expectedVersion: 8, acknowledgeDuplicateRisk: true })).id, 'child');
  assert.deepEqual(commands[0], commands[1], 'lost reply replays original version and key even after refreshed history');
  assert.equal(readFormDraft(storage, 'alice', 'broadcast-action', path), null, 'confirmed action clears intent');
  globalThis.fetch = async () => new Response('{}', { status: 409, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(broadcastAction(storage, 'alice', path, { expectedVersion: 7, acknowledgeDuplicateRisk: true }), (e: any) => e instanceof BroadcastHttpError && e.status === 409);
  assert.equal(readFormDraft(storage, 'alice', 'broadcast-action', path), null, 'definitive conflict allows reconfirmation on current version');
  globalThis.fetch = async () => new Response('{"id":"child"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(broadcastAction(storage, 'alice', path, { expectedVersion: 8, acknowledgeDuplicateRisk: true }), /не подтвердил действие/);
  assert.ok(readFormDraft(storage, 'alice', 'broadcast-action', path), 'incomplete success retains safe replay');
  const transferPath = '/api/v1/broadcasts/b/reschedule';
  await assert.rejects(broadcastAction(storage, 'alice', transferPath, { expectedVersion: 8, scheduledAt: '2026-10-07T09:00:00.000Z' }), /не подтвердил действие/);
  await assert.rejects(broadcastAction(storage, 'alice', transferPath, { expectedVersion: 8, scheduledAt: '2026-10-08T09:00:00.000Z' }), /Предыдущий перенос/, 'changed ambiguous time cannot silently replay different confirmation');
  globalThis.fetch = async () => new Response('{}', { status: 400, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(broadcastAction(storage, 'alice', transferPath, { expectedVersion: 8, scheduledAt: '2026-10-07T09:00:00.000Z' }));
  assert.equal(readFormDraft(storage, 'alice', 'broadcast-action', transferPath), null, 'definitive invalid schedule can be corrected');
  globalThis.fetch = async () => new Response('{"id":"child"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
  const cancelPath = '/api/v1/broadcasts/b/cancel';
  await assert.rejects(broadcastAction(storage, 'alice', cancelPath, { expectedVersion: 8 }), /не подтвердил действие/);
  assert.notEqual(readFormDraft<any>(storage, 'alice', 'broadcast-action', path)?.payload.key, readFormDraft<any>(storage, 'alice', 'broadcast-action', cancelPath)?.payload.key, 'operations have independent intents');
  removeFormDraft(storage, 'alice', 'broadcast-request');
  assert.notEqual(broadcastRequestKey(storage, 'alice', request), key, 'new successful intent gets new key');
  removeUserFormDrafts(storage, 'alice');
  assert.equal(readFormDraft(storage, 'alice', 'broadcast-request'), null, 'logout removes retry intent');
  assert.equal(readFormDraft(storage, 'alice', 'broadcast-action', path), null, 'logout removes action intent');
} finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer; }
console.log('Broadcast client: Moscow time, bounds, persistent retry key, isolation, failures and logout passed.');
