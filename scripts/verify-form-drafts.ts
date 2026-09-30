import assert from 'node:assert/strict';
import { FORM_DRAFT_SCHEMA, formDraftKey, readFormDraft, removeUserFormDrafts, writeFormDraft } from '../src/formDrafts.js';

class MemoryStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const storage = new MemoryStorage();
writeFormDraft(storage, { userId: 'alice', kind: 'task', entityId: 'new', context: '', payload: { title: 'Черновик' } });
assert.equal(readFormDraft<{ title: string }>(storage, 'alice', 'task')?.payload.title, 'Черновик');
assert.equal(readFormDraft(storage, 'bob', 'task'), null, 'another user cannot restore the draft');

const staleKey = formDraftKey('alice', 'meeting');
storage.setItem(staleKey, JSON.stringify({ schema: FORM_DRAFT_SCHEMA + 1, userId: 'alice', kind: 'meeting', entityId: 'new', context: '', payload: {} }));
assert.equal(readFormDraft(storage, 'alice', 'meeting'), null, 'incompatible schema is discarded');
assert.equal(storage.getItem(staleKey), null);

writeFormDraft(storage, { userId: 'alice', kind: 'slots', entityId: 'new', context: '2026-09-21', payload: { dirtyWeekIndexes: [0] } });
writeFormDraft(storage, { userId: 'bob', kind: 'task', entityId: 'new', context: '', payload: { title: 'Чужой' } });
assert.equal(removeUserFormDrafts(storage, 'alice'), 2);
assert.ok(readFormDraft(storage, 'bob', 'task'));

console.log('Form draft checks passed: schema, user isolation, context scope, and logout cleanup.');
