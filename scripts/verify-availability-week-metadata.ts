import assert from 'node:assert/strict';
import { addAvailabilityWeeks, alignAvailabilityToWeek, currentAvailabilityWeekStart, normalizeAvailabilityConfig } from '../src/availabilityConfig.js';
import { mergePrimarySheetAvailability, sanitizeSimulationState } from '../src/stateMaintenance.js';
import type { SimulationState } from '../src/types.js';

assert.equal(addAvailabilityWeeks('2030-01-07', 2), '2030-01-21');

const beforeRollover = normalizeAvailabilityConfig({
  availabilityWeekCount: 3,
  availabilityWeekMetadata: {
    '2030-01-07': { name: 'Первая', description: 'Уже прошла' },
    '2030-01-14': { name: 'Вторая', description: 'Теперь текущая' },
    '2030-01-21': { name: 'Третья', description: 'Теперь следующая' },
  },
}, '2030-01-07');
assert.deepEqual(beforeRollover.weekNames, ['Первая', 'Вторая', 'Третья']);

const afterRollover = normalizeAvailabilityConfig({
  availabilityWeekCount: 3,
  availabilityWeekNames: ['Старый индекс 1', 'Старый индекс 2', 'Старый индекс 3'],
  availabilityWeekMetadata: beforeRollover.weekMetadata,
}, '2030-01-14');
assert.deepEqual(afterRollover.weekStarts, ['2030-01-14', '2030-01-21', '2030-01-28']);
assert.deepEqual(afterRollover.weekNames, ['Вторая', 'Третья', 'Неделя 3']);
assert.deepEqual(afterRollover.weekDescriptions, ['Теперь текущая', 'Теперь следующая', '']);

assert.equal(currentAvailabilityWeekStart(new Date('2030-01-13T20:59:59Z')), '2030-01-07');
assert.equal(currentAvailabilityWeekStart(new Date('2030-01-13T21:00:00Z')), '2030-01-14');

const fixture: SimulationState = {
  users: [{ id: 'u1', username: '@test', realName: 'Тест', role: 'organizer', avatarSeed: 'test' }],
  competencies: [], tasks: [], meetings: [], messages: {},
  settings: {
    availabilityWeekCount: 3,
    availabilityWeekNames: ['Первая', 'Вторая', 'Третья'],
    availabilityWeekDescriptions: ['Прошла', 'Текущая', 'Следующая'],
  },
  availabilities: { u1: {
    userId: 'u1', weekStart: '2030-01-07', updatedAt: '2030-01-13T20:59:59Z',
    slots: { 0: [17], 7: [18], 14: [19] },
    hardUnavailableDays: [1, 8, 15], outWeekIndexes: [2],
  } },
};
const before = sanitizeSimulationState(fixture, '2030-01-07');
const after = sanitizeSimulationState(before, '2030-01-14');
assert.deepEqual(after.settings?.availabilityWeekNames, ['Вторая', 'Третья', 'Неделя 3']);
assert.deepEqual(after.settings?.availabilityWeekDescriptions, ['Текущая', 'Следующая', '']);
assert.equal(after.settings?.availabilityWeekMetadata?.['2030-01-07'], undefined);
assert.deepEqual(after.availabilities.u1.slots, { 0: [18], 7: [19] });
assert.deepEqual(after.availabilities.u1.hardUnavailableDays, [1, 8]);
assert.deepEqual(after.availabilities.u1.outWeekIndexes, [1]);
assert.equal(after.settings?.availabilityWeekCount, 3);
assert.deepEqual(sanitizeSimulationState(after, '2030-01-14'), after, 'repeated maintenance must not shift again');
assert.deepEqual(sanitizeSimulationState(JSON.parse(JSON.stringify(after)), '2030-01-14'), after, 'restart must preserve the shifted dates');

const afterGap = sanitizeSimulationState(after, '2030-02-04');
assert.deepEqual(afterGap.availabilities.u1.slots, {});
assert.deepEqual(afterGap.availabilities.u1.hardUnavailableDays, []);
assert.deepEqual(afterGap.availabilities.u1.outWeekIndexes, []);
assert.deepEqual(afterGap.settings?.availabilityWeekNames, ['Эта неделя', 'Неделя 2', 'Неделя 3']);
assert.deepEqual(afterGap.settings?.availabilityWeekDescriptions, ['', '', '']);
assert.deepEqual(sanitizeSimulationState(afterGap, '2030-02-11').settings?.availabilityWeekMetadata, {}, 'empty metadata must never revive legacy labels');
const defaultLabels = sanitizeSimulationState({ ...fixture, settings: {
  availabilityWeekCount: 3, availabilityWeekNames: ['Эта неделя', 'Неделя 2', 'Неделя 3'],
} }, '2030-01-07');
assert.deepEqual(sanitizeSimulationState(defaultLabels, '2030-01-14').settings?.availabilityWeekNames,
  ['Эта неделя', 'Неделя 2', 'Неделя 3'], 'default labels describe positions and must not be migrated as custom names');

const legacy = { ...fixture.availabilities.u1, weekStart: undefined };
assert.deepEqual(alignAvailabilityToWeek(legacy, '2030-01-14', 3).slots, { 0: [18], 7: [19] }, 'legacy slots use their update date');
assert.deepEqual(alignAvailabilityToWeek({ slots: { 0: [17] } }, '2030-01-14', 3).slots, {}, 'undated slots must not be assigned to a new week');
assert.deepEqual(alignAvailabilityToWeek({ ...legacy, slots: { 21: [20] } }, '2030-01-14', 3).slots, {}, 'hidden slots outside the horizon must not appear in the appended week');
assert.deepEqual(alignAvailabilityToWeek({ weekStart: '2029-12-31', slots: { 0: [17], 7: [18] } }, '2030-01-07', 3).slots, { 0: [18] });

const imported = { userId: 'u1', weekStart: '2030-01-14', updatedAt: '2030-01-13T21:00:01Z', slots: { 0: [20] } };
const merged = mergePrimarySheetAvailability(before.availabilities.u1, imported, '2030-01-14');
assert.deepEqual(merged.slots, { 0: [20], 7: [19] }, 'import must align existing future weeks before merging');
assert.deepEqual(merged.outWeekIndexes, [1]);
const lateImport = mergePrimarySheetAvailability(after.availabilities.u1, { ...imported, weekStart: '2030-01-07' }, '2030-01-14');
assert.deepEqual(lateImport.slots, after.availabilities.u1.slots, 'in-flight import from last week must not overwrite the new week');

console.log('Availability rollover passed: Moscow midnight, three-week horizon, legacy metadata, slots, unavailable flags, restart, skipped weeks and delayed Sheets imports.');
