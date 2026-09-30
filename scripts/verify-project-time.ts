import assert from 'node:assert/strict';
import {
  PROJECT_TIME_ZONE,
  parseProjectLocalDate,
  projectClock,
  projectDateDeadlineInstant,
  projectDateTimeInstant,
  projectLocalWeekday,
} from '../src/projectTime.js';

assert.equal(PROJECT_TIME_ZONE, 'Europe/Moscow');
assert.deepEqual(parseProjectLocalDate('29.02.2028'), { year: 2028, month: 2, day: 29 });
assert.equal(parseProjectLocalDate('29.02.2027'), null);
assert.equal(parseProjectLocalDate('31.02.27'), null);
assert.equal(parseProjectLocalDate('32.13.27'), null);
assert.deepEqual(
  parseProjectLocalDate('01.01', new Date('2026-12-31T21:30:00.000Z')),
  { year: 2027, month: 1, day: 1 },
  'yearless dates must use the Moscow year',
);
assert.equal(projectDateTimeInstant('01.01.27', '00:00')?.toISOString(), '2026-12-31T21:00:00.000Z');
assert.equal(projectDateDeadlineInstant('01.01.27')?.toISOString(), '2027-01-01T20:59:59.999Z');
assert.equal(projectDateTimeInstant('31.12.27', '23:59')?.toISOString(), '2027-12-31T20:59:00.000Z');
assert.equal(projectDateTimeInstant('01.01.27', '24:00'), null);
assert.equal(projectLocalWeekday({ year: 2026, month: 8, day: 9 }), 0);
assert.equal(projectClock(new Date('2026-12-31T21:00:00.000Z')).dateKey, '2027-01-01');

const originalTimeZone = process.env.TZ;
const instants = ['UTC', 'Europe/Moscow', 'Asia/Vladivostok'].map((timeZone) => {
  process.env.TZ = timeZone;
  return projectDateDeadlineInstant('15.04.27')?.toISOString();
});
if (originalTimeZone === undefined) delete process.env.TZ;
else process.env.TZ = originalTimeZone;
assert.deepEqual(new Set(instants).size, 1, 'OS timezone must not change a project instant');

console.log('Project time verification passed: strict dates, Moscow instants, leap day, year boundary, and OS timezone independence.');
