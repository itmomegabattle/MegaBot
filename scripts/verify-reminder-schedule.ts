import assert from 'node:assert/strict';
import {
  isAvailabilityReminderTime,
  millisecondsUntilNextWholeHour,
  moscowClock,
} from '../src/reminderSchedule.js';

const sundayBefore = new Date('2026-08-09T14:59:59.000Z');
const sundayAtSix = new Date('2026-08-09T15:00:00.000Z');
const sundayAfter = new Date('2026-08-09T15:01:00.000Z');
const mondayAfterMidnight = new Date('2026-08-09T21:44:00.000Z');

assert.equal(isAvailabilityReminderTime(sundayBefore), false);
assert.equal(isAvailabilityReminderTime(sundayAtSix), true);
assert.equal(isAvailabilityReminderTime(sundayAfter), false);
assert.equal(isAvailabilityReminderTime(mondayAfterMidnight), false);
assert.deepEqual(moscowClock(mondayAfterMidnight), {
  dateKey: '2026-08-10',
  weekday: 1,
  hour: 0,
  minute: 44,
});
assert.equal(millisecondsUntilNextWholeHour(new Date('2026-08-09T15:37:12.250Z')), 1_367_750);
assert.equal(millisecondsUntilNextWholeHour(new Date('2026-08-09T15:00:00.000Z')), 3_600_000);

console.log('Reminder schedule verification passed: Sunday 18:00 Europe/Moscow only.');
