import assert from 'node:assert/strict';
import {
  claimTelegramInboxEntry,
  completeTelegramInboxEntry,
  failTelegramInboxEntry,
  recordTelegramUpdates,
  telegramUpdateChatKey,
} from '../src/telegramInbox.js';
import type { SimulationState } from '../src/types.js';

const state: SimulationState = { users: [], availabilities: {}, meetings: [], tasks: [], messages: {}, settings: {} };
const firstUpdate = { update_id: 101, message: { chat: { id: 500 }, text: '/start' } };
const secondUpdate = { update_id: 102, callback_query: { from: { id: 700 }, data: 'open_tasks' } };
const recorded = recordTelegramUpdates(state, [firstUpdate, secondUpdate, firstUpdate], new Date('2026-09-29T09:00:00.000Z'));
assert.equal(recorded.inserted.length, 2);
assert.equal(recorded.existing.length, 1);
assert.equal(state.settings?.telegramInbox?.length, 2);
assert.equal(telegramUpdateChatKey(firstUpdate), '500');
assert.equal(telegramUpdateChatKey(secondUpdate), '700');

const first = state.settings!.telegramInbox![0];
const firstLease = claimTelegramInboxEntry(first, new Date('2026-09-29T09:00:00.000Z'))!;
assert.equal(first.status, 'processing');
failTelegramInboxEntry(first, firstLease, new Error('temporary'), new Date('2026-09-29T09:00:00.000Z'));
assert.equal(first.status, 'retry');
assert.equal(first.availableAt, '2026-09-29T09:00:01.000Z');
assert.equal(claimTelegramInboxEntry(first, new Date('2026-09-29T09:00:00.999Z')), undefined);
const retryLease = claimTelegramInboxEntry(first, new Date('2026-09-29T09:00:01.000Z'))!;
completeTelegramInboxEntry(first, retryLease, new Date('2026-09-29T09:00:02.000Z'));
assert.equal(first.status, 'completed');
assert.equal(claimTelegramInboxEntry(first, new Date('2026-09-30T09:00:00.000Z')), undefined);

const second = state.settings!.telegramInbox![1];
const abandonedLease = claimTelegramInboxEntry(second, new Date('2026-09-29T09:00:00.000Z'), 1_000)!;
assert.ok(abandonedLease);
assert.equal(claimTelegramInboxEntry(second, new Date('2026-09-29T09:00:00.999Z')), undefined);
assert.ok(claimTelegramInboxEntry(second, new Date('2026-09-29T09:00:01.000Z')), 'expired processing leases must resume after restart');

const terminalState: SimulationState = { users: [], availabilities: {}, meetings: [], tasks: [], messages: {}, settings: {} };
recordTelegramUpdates(terminalState, [{ update_id: 999 }]);
const terminal = terminalState.settings!.telegramInbox![0];
for (let attempt = 0; attempt < 10; attempt += 1) {
  const lease = claimTelegramInboxEntry(terminal, new Date(Date.parse(terminal.availableAt) + 1))!;
  failTelegramInboxEntry(terminal, lease, 'broken', new Date(Date.parse(terminal.availableAt) + 1));
}
assert.equal(terminal.status, 'failed');

console.log('Telegram inbox verification passed: unique update IDs, chat routing, retry backoff, completed dedupe, lease recovery, and terminal failure.');
