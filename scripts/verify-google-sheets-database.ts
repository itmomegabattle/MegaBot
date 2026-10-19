import assert from 'node:assert/strict';
import {
  compareDatabaseStateCounts,
  decodeGoogleSheetsDatabaseSnapshot,
  encodeGoogleSheetsDatabaseSnapshot,
  exportStateToGoogleSheetsDatabase,
  importStateFromGoogleSheetsDatabase,
} from '../src/googleSheetsDatabase.js';
import type { SimulationState } from '../src/types.js';
import { resetOperationalData, sanitizeSimulationState } from '../src/stateMaintenance.js';

const state: SimulationState = {
  users: [{ id: 'u1', username: 'nikita', realName: 'Никита 🚀', role: 'admin', avatarSeed: 'seed', avatarDataUrl: `data:image/webp;base64,${'a'.repeat(64)}` }],
  faculties: [{ id: 'f1', name: 'Организаторы' }],
  competencies: ['Продакшн', 'Дизайн'],
  facultyCompetencies: ['Продакшн'],
  availabilities: { u1: { userId: 'u1', weekStart: '2026-08-03', updatedAt: '2026-08-05T00:00:00.000Z', slots: { 0: [9, 10] }, hardUnavailableDays: [], outWeekIndexes: [1] } },
  meetings: [{ id: 'm1', title: 'Монтаж сцены', kind: 'setup', eventId: 'e1', type: 'general', date: '2026-08-06', time: '12:00', duration: 1, hostId: 'u1', participants: 'all', attendeeIds: ['u1'], status: 'scheduled', googleCalendarEventId: 'megabot-calendar-event' }],
  events: [{ id: 'e1', name: 'Мегабатл', status: 'active', createdAt: '2026-08-05T00:00:00.000Z' }],
  tasks: [{ id: 't1', eventId: 'e1', title: 'Сцена', description: 'Очень длинное описание '.repeat(5_000), deadline: '2026-08-07', assignedTo: ['u1'], competency: 'Продакшн', competencies: ['Продакшн', 'Дизайн'], sow: '', tips: [], status: 'assigned', priority: 'critical', reminders: [{ id: 'r1', type: 'before_deadline', value: 2, unit: 'hours' }], assigneeNotes: { u1: { executor: 'В процессе' } }, completionComments: {} }],
  messages: { u1: [{ id: 'msg1', userId: 'u1', sender: 'bot', text: 'Готово ✅', timestamp: '2026-08-05T00:00:00.000Z' }] },
  settings: {
    availabilityWeekCount: 2,
    availabilityWeekNames: ['Подготовка', 'Финал'],
    availabilityWeekDescriptions: ['Собираем материалы', 'Проводим мероприятие'],
    databaseRevision: 7,
  },
};

(state.tasks[0] as typeof state.tasks[0] & { legacyField: string }).legacyField = 'must survive';
(state.users[0] as typeof state.users[0] & { obsoleteFlag: boolean }).obsoleteFlag = true;
const encoded = encodeGoogleSheetsDatabaseSnapshot(state, 127);
assert.ok(encoded.length > 1, 'large snapshots must be split into chunks');
const decoded = decodeGoogleSheetsDatabaseSnapshot(encoded.map(([chunk_index, data]) => ({ chunk_index, data })));
assert.deepEqual(decoded, state, 'snapshot roundtrip must preserve every field and Unicode character');
assert.equal(compareDatabaseStateCounts(state, decoded!).passed, true);
(decoded!.tasks[0] as any).assignedTo = 'u1';
const sanitized = sanitizeSimulationState(decoded!);
assert.equal('legacyField' in sanitized.tasks[0], false, 'obsolete task fields must be removed from active state');
assert.equal('obsoleteFlag' in sanitized.users[0], false, 'obsolete user fields must be removed from active state');
assert.equal(sanitized.meetings[0].googleCalendarEventId, 'megabot-calendar-event');
assert.equal(sanitized.meetings[0].kind, 'setup');
assert.equal(sanitized.meetings[0].eventId, 'e1');
const vibeState = sanitizeSimulationState({ ...state, meetings: [{ ...state.meetings[0], kind: 'vibe' }] });
assert.equal(vibeState.meetings[0].kind, 'vibe', 'informal meeting kind must survive sanitization and database snapshots');
const vibeSnapshot = encodeGoogleSheetsDatabaseSnapshot(vibeState);
assert.equal(decodeGoogleSheetsDatabaseSnapshot(vibeSnapshot.map(([chunk_index, data]) => ({ chunk_index, data })))?.meetings[0].kind, 'vibe');
assert.equal(sanitized.users[0].avatarDataUrl, state.users[0].avatarDataUrl, 'compressed avatar must survive maintenance');
assert.deepEqual(sanitized.tasks[0].competencies, ['Продакшн', 'Дизайн'], 'multiple executor blocks must survive maintenance');
assert.deepEqual(sanitized.tasks[0].assignedTo, ['u1'], 'legacy single-assignee tasks must migrate without breaking startup');
assert.deepEqual(sanitized.availabilities.u1.slots, {}, 'hours outside the configured availability window must be removed');
assert.deepEqual(sanitized.settings?.availabilityActiveDays, [0, 1, 2, 3, 4]);
assert.equal(sanitized.settings?.availabilityStartHour, 17);
assert.equal(sanitized.settings?.availabilityEndHour, 23);
assert.deepEqual(sanitized.settings?.availabilityWeekNames, ['Подготовка', 'Финал']);
assert.deepEqual(sanitized.settings?.availabilityWeekDescriptions, ['Собираем материалы', 'Проводим мероприятие']);
const reset = resetOperationalData(decoded!);
assert.equal(reset.users.length, 1, 'production reset must preserve team members');
assert.equal(reset.users[0].joinedAt, '', 'production reset must clear test-era join timestamps');
assert.equal(reset.users[0].lastSeenAt, '', 'production reset must clear test-era activity timestamps');
assert.deepEqual({ tasks: reset.tasks, meetings: reset.meetings, events: reset.events, availabilities: reset.availabilities, messages: reset.messages }, {
  tasks: [], meetings: [], events: [], availabilities: {}, messages: {},
});
console.log('Google Sheets database verification passed: exact snapshots, schema cleanup, and safe operational reset.');

const config = { spreadsheetId: 'synthetic', credentialsFile: 'unused', enabled: true };
const large = structuredClone(state);
large.tasks[0].description = 'Short';
large.settings!.telegramInbox = Array.from({length:47}, (_, updateId) => ({updateId, chatKey:'test', payload:{text:'Ю🚀'.repeat(1000)},status:'completed' as const,receivedAt:'2030-01-01',availableAt:'2030-01-01',updatedAt:'2030-01-01',attempts:1}));
const calls: string[] = [];
let written: {range:string;values:unknown[][]}[] = [];
const dependencies: NonNullable<Parameters<typeof exportStateToGoogleSheetsDatabase>[3]> = {
  initialize: async () => { calls.push('initialize'); return {spreadsheetId:config.spreadsheetId,sheets:[],created:false}; },
  request: async (_config, route, options) => {
    calls.push(route);
    if (route === '/values:batchUpdate') written = JSON.parse(String(options!.body)).data;
    if (route.startsWith('/values:batchGet')) return {valueRanges: new URLSearchParams(route.split('?')[1]).getAll('ranges').map(range => {
      const title = range.match(/^'([^']+)'/)![1];
      const data = written.find(item => item.range.startsWith(`'${title}'!`));
      const headers = title === 'settings' ? ['key','value_json','chunk_index'] : title === 'meta' ? null : [];
      return {range,values:title === 'snapshot' ? [] : headers === null ? data!.values : [headers,...(data?.values || [])]};
    })};
    return {};
  },
};
await exportStateToGoogleSheetsDatabase(config, large, 'test', dependencies);
const chunks = written.find(item => item.range === "'settings'!A2")!.values.filter(row => row[0] === 'settings');
assert.ok(chunks.length > 2);
assert.ok(chunks.every(row => String(row[1]).length <= 30_000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(String(row[1]))), 'chunks must not split Unicode surrogate pairs');
assert.ok(written.every(item => item.values.every(row => row.every(cell => typeof cell !== 'string' || cell.length <= 50_000))));
assert.deepEqual(JSON.parse(chunks.map(row => row[1]).join('')), large.settings);
// Domain fallback, not just the already-chunked snapshot, must restore the queue.
assert.deepEqual((await importStateFromGoogleSheetsDatabase(config, dependencies)).state!.settings, large.settings);
written.find(item => item.range === "'settings'!A2")!.values = [['settings',JSON.stringify(state.settings)]];
assert.deepEqual((await importStateFromGoogleSheetsDatabase(config, dependencies)).state!.settings, state.settings);
for (const length of [50_001, 120_000]) {
  const invalid = structuredClone(large);
  invalid.tasks[0].description = 'x'.repeat(length);
  calls.length = 0;
  await assert.rejects(exportStateToGoogleSheetsDatabase(config, invalid, 'test', dependencies), /tasks!F2/);
  assert.deepEqual(calls, [], 'oversized cells must fail before initialization, writing meta, or clearing data');
}
large.tasks[0].description = 'x'.repeat(50_000);
await exportStateToGoogleSheetsDatabase(config, large, 'test', dependencies);
console.log('Oversized settings verification passed: chunked Unicode queue, legacy/fallback read, 50000 boundary, and zero remote mutations on invalid payload.');
