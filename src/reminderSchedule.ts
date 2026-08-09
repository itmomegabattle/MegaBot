export const MOSCOW_TIME_ZONE = 'Europe/Moscow';
export const AVAILABILITY_REMINDER_WEEKDAY = 0;
export const AVAILABILITY_REMINDER_HOUR = 18;

export type MoscowClock = {
  dateKey: string;
  weekday: number;
  hour: number;
  minute: number;
};

export function moscowClock(date = new Date()): MoscowClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateKey = `${values.year}-${values.month}-${values.day}`;
  const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return {
    dateKey,
    weekday,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function isAvailabilityReminderTime(date = new Date()) {
  const clock = moscowClock(date);
  return (
    clock.weekday === AVAILABILITY_REMINDER_WEEKDAY
    && clock.hour === AVAILABILITY_REMINDER_HOUR
    && clock.minute === 0
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
