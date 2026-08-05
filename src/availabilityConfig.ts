export type AvailabilitySettings = {
  availabilityWeekCount?: number;
  availabilityActiveDays?: number[];
  availabilityStartHour?: number;
  availabilityEndHour?: number;
};

export const DEFAULT_AVAILABILITY_ACTIVE_DAYS = [0, 1, 2, 3, 4];
export const DEFAULT_AVAILABILITY_START_HOUR = 17;
export const DEFAULT_AVAILABILITY_END_HOUR = 23;

export function normalizeAvailabilityConfig(settings?: AvailabilitySettings) {
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
  return {
    activeDays: activeDays.length ? activeDays : [...DEFAULT_AVAILABILITY_ACTIVE_DAYS],
    startHour,
    endHour,
    hours: Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index),
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
