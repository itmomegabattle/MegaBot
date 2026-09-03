export type AvailabilitySettings = {
  availabilityWeekCount?: number;
  availabilityActiveDays?: number[];
  availabilityStartHour?: number;
  availabilityEndHour?: number;
  availabilityWeekNames?: string[];
  availabilityWeekDescriptions?: string[];
  availabilityWeekMetadata?: Record<string, { name?: string; description?: string }>;
  availabilityWeekStart?: string;
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
  const sourceMetadata = { ...settings?.availabilityWeekMetadata };
  // Migrate positional labels once, then use dates even when the map is empty.
  if (!Object.keys(sourceMetadata).length && !settings?.availabilityWeekStart) {
    weekStarts.forEach((weekStart, index) => {
      const legacyName = settings?.availabilityWeekNames?.[index];
      const name = legacyName === (index === 0 ? 'Эта неделя' : `Неделя ${index + 1}`) ? undefined : legacyName;
      const description = settings?.availabilityWeekDescriptions?.[index];
      if (name || description) sourceMetadata[weekStart] = { name, description };
    });
  }
  const metadata = Object.fromEntries(Object.entries(sourceMetadata)
    .filter(([weekStart]) => weekStarts.includes(weekStart))
    .slice(-260)
    .map(([weekStart, value]) => [weekStart, {
      name: String(value?.name || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      description: String(value?.description || '').replace(/\r\n?/g, '\n').trim().slice(0, 600),
    }]));
  return {
    weekCount,
    activeDays: activeDays.length ? activeDays : [...DEFAULT_AVAILABILITY_ACTIVE_DAYS],
    startHour,
    endHour,
    hours: Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index),
    weekStarts,
    weekMetadata: metadata,
    weekNames: Array.from({ length: weekCount }, (_, index) => {
      const name = metadata[weekStarts[index]]?.name;
      return name || (index === 0 ? 'Эта неделя' : `Неделя ${index + 1}`);
    }),
    weekDescriptions: Array.from({ length: weekCount }, (_, index) => (
      metadata[weekStarts[index]]?.description || ''
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
    .filter(([day, hours]) => Number.isInteger(day) && day >= 0 && day < config.weekCount * 7 && allowedDays.has(day % 7) && hours.length > 0));
}

type DatedAvailability = {
  slots?: Record<number, number[]>;
  hardUnavailableDays?: number[];
  outWeekIndexes?: number[];
  weekStart?: string;
  updatedAt?: string;
};

export function alignAvailabilityToWeek(
  availability: DatedAvailability | undefined,
  baseWeekStart = currentAvailabilityWeekStart(),
  weekCount = 5,
) {
  const updatedAt = new Date(availability?.updatedAt || '');
  const savedWeekStart = ISO_DATE_PATTERN.test(availability?.weekStart || '')
    ? availability!.weekStart!
    : Number.isFinite(updatedAt.getTime()) ? currentAvailabilityWeekStart(updatedAt) : undefined;
  const offset = savedWeekStart
    ? (Date.parse(baseWeekStart) - Date.parse(savedWeekStart)) / (7 * 86_400_000)
    : NaN;
  const validDay = (day: number) => Number.isInteger(day) && day >= 0 && day < weekCount * 7;
  if (!Number.isInteger(offset)) {
    return { slots: {} as Record<number, number[]>, hardUnavailableDays: [], outWeekIndexes: [], weekStart: baseWeekStart };
  }
  return {
    slots: Object.fromEntries(Object.entries(availability?.slots || {})
      .filter(([day]) => validDay(Number(day)))
      .map(([day, hours]): [number, number[]] => [Number(day) - offset * 7, Array.isArray(hours) ? [...hours] : []])
      .filter(([day]) => validDay(day))),
    hardUnavailableDays: (availability?.hardUnavailableDays || [])
      .filter((day) => validDay(Number(day)))
      .map((day) => Number(day) - offset * 7).filter(validDay),
    outWeekIndexes: (availability?.outWeekIndexes || [])
      .filter((index) => Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < weekCount)
      .map((index) => Number(index) - offset)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < weekCount),
    weekStart: baseWeekStart,
  };
}
