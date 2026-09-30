import assert from 'node:assert/strict';
import { alignAvailabilityToWeek } from '../src/availabilityConfig.js';
import { AvailabilityWeekConflictError, mergeAvailabilityDraft, replaceAvailabilityWeek } from '../src/availabilityWeekMutation.js';
import type { Availability } from '../src/types.js';

const settings = {
  availabilityWeekCount: 3,
  availabilityActiveDays: [0, 1, 2, 3, 4],
  availabilityStartHour: 17,
  availabilityEndHour: 23,
};
const baseWeekStart = '2030-01-07';
const weekA = '2030-01-07';
const weekB = '2030-01-14';
const initial: Availability = {
  userId: 'u1',
  weekStart: baseWeekStart,
  slots: { 0: [17], 7: [18], 14: [19] },
  hardUnavailableDays: [1, 8],
  outWeekIndexes: [],
  weekVersions: { [weekA]: 3, [weekB]: 7, '2030-01-21': 2 },
  updatedAt: '2030-01-07T09:00:00.000Z',
};

const savedB = replaceAvailabilityWeek(initial, 'u1', baseWeekStart, settings, {
  weekStart: weekB,
  days: { 0: [20], 2: [21] },
  hardUnavailableDays: [4],
  out: false,
  expectedVersion: 7,
}, '2030-01-08T09:00:00.000Z').availability;
assert.deepEqual(savedB.slots[0], [17], 'saving B must preserve A');
assert.deepEqual(savedB.slots[7], [20]);
assert.deepEqual(savedB.slots[9], [21]);
assert.equal(savedB.weekVersions?.[weekB], 8);

const savedAAfterB = replaceAvailabilityWeek(savedB, 'u1', baseWeekStart, settings, {
  weekStart: weekA,
  days: { 0: [22] },
  hardUnavailableDays: [3],
  out: false,
  expectedVersion: 3,
}, '2030-01-08T09:01:00.000Z').availability;
assert.deepEqual(savedAAfterB.slots[0], [22]);
assert.deepEqual(savedAAfterB.slots[7], [20], 'saving A after another device saved B must preserve B');
assert.deepEqual(savedAAfterB.slots[9], [21]);
assert.equal(savedAAfterB.weekVersions?.[weekA], 4);
assert.equal(savedAAfterB.weekVersions?.[weekB], 8);

const localWithDirtyB = mergeAvailabilityDraft(
  { slots: { 0: [22], 7: [20] }, hardUnavailableDays: [3], outWeekIndexes: [] },
  { slots: { 0: [17], 7: [23] }, hardUnavailableDays: [8], outWeekIndexes: [] },
  [weekB],
  [weekA, weekB, '2030-01-21'],
);
assert.deepEqual(localWithDirtyB.slots[0], [22], 'a refreshed saved week must use the server baseline');
assert.deepEqual(localWithDirtyB.slots[7], [23], 'an unsaved draft in another week must survive refresh');
assert.deepEqual(localWithDirtyB.hardUnavailableDays, [3, 8]);

assert.throws(() => replaceAvailabilityWeek(savedAAfterB, 'u1', baseWeekStart, settings, {
  weekStart: weekB,
  days: { 0: [17] },
  expectedVersion: 7,
}), AvailabilityWeekConflictError, 'a stale client must not overwrite the same week');

const rolled = alignAvailabilityToWeek(savedAAfterB, '2030-01-14', 3);
assert.deepEqual(rolled.slots[0], [20], 'week B becomes the first week after Monday rollover');
assert.equal(rolled.slots[14], undefined, 'the new last week starts empty');

console.log('Availability week mutation verification passed.');
