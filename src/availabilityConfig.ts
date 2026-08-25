export type AvailabilitySettings = {
  availabilityWeekCount?: number;
  availabilityActiveDays?: number[];
  availabilityStartHour?: number;
  availabilityEndHour?: number;
  availabilityWeekNames?: string[];
  availabilityWeekDescriptions?: string[];
  availabilityWeekMetadata?: Record<string, { name?: string; description?: string }>;
};

export const DEFAULT_AVAILABILITY_ACTIVE_DAYS = [0, 1, 2, 3, 4];
export const DEFAULT_AVAILABILITY_START_HOUR = 17;
export const DEFAULT_AVAILABILITY_END_HOUR = 23;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function currentAvailabilityWeekStart(reference = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(reference);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = new Date(`${value.year}-${value.month}-${value.day}T12:00:00Z`);
  const mondayOffset = date.getUTCDay() === 0 ? 6 : date.getUTCDay() - 1;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return date.toISOString().slice(0, 10);
}

export function addAvailabilityWeeks(weekStart: string, weeks: number) {
  const validStart = ISO_DATE_PATTERN.test(weekStart) ? weekStart : currentAvailabilityWeekStart();
  const date = new Date(`${validStart}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

export function normalizeAvailabilityConfig(settings?: AvailabilitySettings, baseWeekStart = currentAvailabilityWeekStart()) {
  const requestedWeekCount = Number(settings?.availabilityWeekCount);
  const weekCount = Number.isInteger(requestedWeekCount) && requestedWeekCount >= 2 && requestedWeekCount <= 5
    ? requestedWeekCount
    : 2;
  const requestedDays = Array.isArray(settings?.availabilityActiveDays)
    ? settings.availabilityActiveDays
    : DEFAULT_AVAILABILITY_ACTIVE_DAYS;
  const activeDays = [...new Set(requestedDays
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  const hour = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
  };
  const startHour = hour(settings?.availabilityStartHour, DEFAULT_AVAILABILITY_START_HOUR);
  const requestedEndHour = hour(settings?.availabilityEndHour, DEFAULT_AVAILABILITY_END_HOUR);
  const endHour = Math.max(startHour, requestedEndHour);
  const weekStarts = Array.from({ length: weekCount }, (_, index) => addAvailabilityWeeks(baseWeekStart, index));
  const metadata = Object.fromEntries(Object.entries(settings?.availabilityWeekMetadata || {})
    .filter(([weekStart]) => ISO_DATE_PATTERN.test(weekStart))
    .slice(-260)
    .map(([weekStart, value]) => [weekStart, {
      name: String(value?.name || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      description: String(value?.description || '').replace(/\r\n?/g, '\n').trim().slice(0, 600),
    }]));
  const hasDateBoundMetadata = Object.keys(metadata).length > 0;
  return {
    weekCount,
    activeDays: activeDays.length ? activeDays : [...DEFAULT_AVAILABILITY_ACTIVE_DAYS],
    startHour,
    endHour,
    hours: Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index),
    weekStarts,
    weekMetadata: metadata,
    weekNames: Array.from({ length: weekCount }, (_, index) => {
      const name = String(metadata[weekStarts[index]]?.name || (!hasDateBoundMetadata ? settings?.availabilityWeekNames?.[index] : '') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return name || (index === 0 ? 'Эта неделя' : `Неделя ${index + 1}`);
    }),
    weekDescriptions: Array.from({ length: weekCount }, (_, index) => (
      String(metadata[weekStarts[index]]?.description || (!hasDateBoundMetadata ? settings?.availabilityWeekDescriptions?.[index] : '') || '').replace(/\r\n?/g, '\n').trim().slice(0, 600)
    )),
  };
}

export function filterSlotsByAvailabilityConfig(slots: Record<number, number[]> | undefined, settings?: AvailabilitySettings) {
  const config = normalizeAvailabilityConfig(settings);
  const allowedDays = new Set(config.activeDays);
  const allowedHours = new Set(config.hours);
  return Object.fromEntries(Object.entries(slots || {})
    .map(([dayValue, hours]) => [Number(dayValue), [...new Set((hours || []).map(Number)
      .filter((hour) => allowedHours.has(hour)))].sort((a, b) => a - b)] as const)
    .filter(([day, hours]) => Number.isInteger(day) && day >= 0 && day < 35 && allowedDays.has(day % 7) && hours.length > 0));
}
