export const PROJECT_TIME_ZONE = 'Europe/Moscow';
export const PROJECT_UTC_OFFSET_MINUTES = 3 * 60;

export type ProjectLocalDate = {
  year: number;
  month: number;
  day: number;
};

const pad = (value: number) => String(value).padStart(2, '0');

export function projectClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PROJECT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

export function parseProjectLocalDate(value?: string, now = new Date()): ProjectLocalDate | null {
  const input = String(value || '').trim();
  const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const short = input.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/);
  if (!iso && !short) return null;
  const year = iso
    ? Number(iso[1])
    : short![3]
      ? Number(short![3].length === 2 ? `20${short![3]}` : short![3])
      : projectClock(now).year;
  const month = Number(iso ? iso[2] : short![2]);
  const day = Number(iso ? iso[3] : short![1]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function projectLocalDateKey(value: ProjectLocalDate) {
  return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
}

export function projectDateTimeInstant(dateValue: string, timeValue = '00:00', now = new Date()) {
  const date = parseProjectLocalDate(dateValue, now);
  const time = String(timeValue).match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!date || !time) return null;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const second = Number(time[3] || 0);
  const millisecond = Number(String(time[4] || '0').padEnd(3, '0'));
  if (hour > 23 || minute > 59 || second > 59) return null;
  return new Date(Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute - PROJECT_UTC_OFFSET_MINUTES,
    second,
    millisecond,
  ));
}

export function projectDateDeadlineInstant(value?: string, now = new Date()) {
  if (!value) return null;
  return projectDateTimeInstant(value, '23:59:59.999', now);
}

export function projectLocalWeekday(value: ProjectLocalDate) {
  return new Date(Date.UTC(value.year, value.month - 1, value.day, 12)).getUTCDay();
}
