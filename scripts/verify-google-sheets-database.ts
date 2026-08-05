import assert from 'node:assert/strict';
import {
  compareDatabaseStateCounts,
  decodeGoogleSheetsDatabaseSnapshot,
  encodeGoogleSheetsDatabaseSnapshot,
} from '../src/googleSheetsDatabase.js';
import type { SimulationState } from '../src/types.js';
import { resetOperationalData, sanitizeSimulationState } from '../src/stateMaintenance.js';

const state: SimulationState = {
  users: [{ id: 'u1', username: 'nikita', realName: 'Никита 🚀', role: 'admin', avatarSeed: 'seed' }],
  faculties: [{ id: 'f1', name: 'Организаторы' }],
  competencies: ['Продакшн'],
  facultyCompetencies: ['Продакшн'],
  availabilities: { u1: { userId: 'u1', weekStart: '2026-08-03', updatedAt: '2026-08-05T00:00:00.000Z', slots: { 0: [9, 10] }, hardUnavailableDays: [] } },
  meetings: [{ id: 'm1', title: 'Планёрка', type: 'custom', date: '2026-08-06', time: '12:00', duration: 6, hostId: 'u1', participants: ['u1'], attendeeIds: ['u1'], status: 'scheduled' }],
  events: [{ id: 'e1', name: 'Мегабатл', status: 'active', createdAt: '2026-08-05T00:00:00.000Z' }],
  tasks: [{ id: 't1', eventId: 'e1', title: 'Сцена', description: 'Очень длинное описание '.repeat(5_000), deadline: '2026-08-07', assignedTo: ['u1'], sow: '', tips: [], status: 'assigned', priority: 'critical', reminders: [{ id: 'r1', type: 'before_deadline', value: 2, unit: 'hours' }], assigneeNotes: { u1: { executor: 'В процессе' } }, completionComments: {} }],
  messages: { u1: [{ id: 'msg1', userId: 'u1', sender: 'bot', text: 'Готово ✅', timestamp: '2026-08-05T00:00:00.000Z' }] },
  settings: { availabilityWeekCount: 2, databaseRevision: 7 },
};

(state.tasks[0] as typeof state.tasks[0] & { legacyField: string }).legacyField = 'must survive';
(state.users[0] as typeof state.users[0] & { obsoleteFlag: boolean }).obsoleteFlag = true;
const encoded = encodeGoogleSheetsDatabaseSnapshot(state, 127);
assert.ok(encoded.length > 1, 'large snapshots must be split into chunks');
const decoded = decodeGoogleSheetsDatabaseSnapshot(encoded.map(([chunk_index, data]) => ({ chunk_index, data })));
assert.deepEqual(decoded, state, 'snapshot roundtrip must preserve every field and Unicode character');
assert.equal(compareDatabaseStateCounts(state, decoded!).passed, true);
const sanitized = sanitizeSimulationState(decoded!);
assert.equal('legacyField' in sanitized.tasks[0], false, 'obsolete task fields must be removed from active state');
assert.equal('obsoleteFlag' in sanitized.users[0], false, 'obsolete user fields must be removed from active state');
const reset = resetOperationalData(decoded!);
assert.equal(reset.users.length, 1, 'production reset must preserve team members');
assert.equal(reset.users[0].joinedAt, '', 'production reset must clear test-era join timestamps');
assert.equal(reset.users[0].lastSeenAt, '', 'production reset must clear test-era activity timestamps');
assert.deepEqual({ tasks: reset.tasks, meetings: reset.meetings, events: reset.events, availabilities: reset.availabilities, messages: reset.messages }, {
  tasks: [], meetings: [], events: [], availabilities: {}, messages: {},
});
console.log('Google Sheets database verification passed: exact snapshots, schema cleanup, and safe operational reset.');
