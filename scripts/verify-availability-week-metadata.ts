import assert from 'node:assert/strict';
import { addAvailabilityWeeks, normalizeAvailabilityConfig } from '../src/availabilityConfig.js';

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

console.log('Availability week metadata remains bound to calendar dates across rollover.');
