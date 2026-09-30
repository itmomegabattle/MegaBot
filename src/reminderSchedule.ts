import { PROJECT_TIME_ZONE, projectClock } from './projectTime.js';

export const MOSCOW_TIME_ZONE = PROJECT_TIME_ZONE;
export const AVAILABILITY_REMINDER_WEEKDAY = 0;
export const AVAILABILITY_REMINDER_HOUR = 18;
export const AVAILABILITY_REMINDER_GRACE_END_HOUR = 21;

export type MoscowClock = {
  dateKey: string;
  weekday: number;
  hour: number;
  minute: number;
};

export function moscowClock(date = new Date()): MoscowClock {
  const clock = projectClock(date);
  const dateKey = clock.dateKey;
  const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return {
    dateKey,
    weekday,
    hour: clock.hour,
    minute: clock.minute,
  };
}

export function isAvailabilityReminderTime(date = new Date()) {
  const clock = moscowClock(date);
  return (
    clock.weekday === AVAILABILITY_REMINDER_WEEKDAY
    && clock.hour >= AVAILABILITY_REMINDER_HOUR
    && clock.hour < AVAILABILITY_REMINDER_GRACE_END_HOUR
  );
}

export function millisecondsUntilNextWholeHour(date = new Date()) {
  const elapsed = (
    date.getUTCMinutes() * 60_000
    + date.getUTCSeconds() * 1_000
    + date.getUTCMilliseconds()
  );
  return 60 * 60_000 - elapsed;
}
