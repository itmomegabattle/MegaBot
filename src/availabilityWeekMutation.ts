import { Availability } from './types.js';
import { AvailabilitySettings, alignAvailabilityToWeek, normalizeAvailabilityConfig } from './availabilityConfig.js';

export class AvailabilityWeekConflictError extends Error {}
export class AvailabilityWeekRangeError extends Error {}

export type AvailabilityWeekDraft = {
  weekStart: string;
  days: Record<number, number[]>;
  hardUnavailableDays?: number[];
  out?: boolean;
  expectedVersion: number;
};

export function mergeAvailabilityDraft(
  saved: { slots: Record<number, number[]>; hardUnavailableDays: number[]; outWeekIndexes: number[] },
  local: { slots: Record<number, number[]>; hardUnavailableDays: number[]; outWeekIndexes: number[] },
  dirtyWeekStarts: string[],
  visibleWeekStarts: string[],
) {
  const dirtyIndexes = new Set(dirtyWeekStarts.map((weekStart) => visibleWeekStarts.indexOf(weekStart)).filter((index) => index >= 0));
  const slots: Record<number, number[]> = {};
  for (let day = 0; day < visibleWeekStarts.length * 7; day += 1) {
    const source = dirtyIndexes.has(Math.floor(day / 7)) ? local.slots : saved.slots;
    slots[day] = [...(source[day] || [])];
  }
  return {
    slots,
    hardUnavailableDays: [
      ...saved.hardUnavailableDays.filter((day) => !dirtyIndexes.has(Math.floor(day / 7))),
      ...local.hardUnavailableDays.filter((day) => dirtyIndexes.has(Math.floor(day / 7))),
    ].sort((a, b) => a - b),
    outWeekIndexes: [
      ...saved.outWeekIndexes.filter((week) => !dirtyIndexes.has(week)),
      ...local.outWeekIndexes.filter((week) => dirtyIndexes.has(week)),
    ].sort((a, b) => a - b),
  };
}

export function availabilityWeekVersion(availability: Availability | undefined, weekStart: string) {
  const value = Number(availability?.weekVersions?.[weekStart] || 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function replaceAvailabilityWeek(
  current: Availability | undefined,
  userId: string,
  baseWeekStart: string,
  settings: AvailabilitySettings | undefined,
  draft: AvailabilityWeekDraft,
  now = new Date().toISOString(),
) {
  const config = normalizeAvailabilityConfig(settings, baseWeekStart);
  const weekIndex = config.weekStarts.indexOf(draft.weekStart);
  if (weekIndex < 0) throw new AvailabilityWeekRangeError('Неделя больше не входит в доступный период. Обнови слоты.');

  const currentVersion = availabilityWeekVersion(current, draft.weekStart);
  if (!Number.isInteger(draft.expectedVersion) || draft.expectedVersion !== currentVersion) {
    throw new AvailabilityWeekConflictError('Эта неделя уже изменилась на другом устройстве. Обнови данные и проверь черновик.');
  }

  const aligned = alignAvailabilityToWeek(current, baseWeekStart, config.weekCount);
  const slots = Object.fromEntries(Object.entries(aligned.slots).map(([day, hours]) => [Number(day), [...hours]]));
  const unavailable = new Set(aligned.hardUnavailableDays);
  const outWeeks = new Set(aligned.outWeekIndexes);
  const firstDay = weekIndex * 7;
  for (let day = firstDay; day < firstDay + 7; day += 1) {
    delete slots[day];
    unavailable.delete(day);
  }
  outWeeks.delete(weekIndex);

  if (draft.out) {
    outWeeks.add(weekIndex);
  } else {
    const allowedDays = new Set(config.activeDays);
    const allowedHours = new Set(config.hours);
    for (const [relativeDayValue, hours] of Object.entries(draft.days || {})) {
      const relativeDay = Number(relativeDayValue);
      if (!Number.isInteger(relativeDay) || relativeDay < 0 || relativeDay > 6 || !allowedDays.has(relativeDay)) continue;
      const cleanHours = [...new Set((Array.isArray(hours) ? hours : []).map(Number).filter((hour) => allowedHours.has(hour)))].sort((a, b) => a - b);
      if (cleanHours.length) slots[firstDay + relativeDay] = cleanHours;
    }
    for (const relativeDayValue of draft.hardUnavailableDays || []) {
      const relativeDay = Number(relativeDayValue);
      if (!Number.isInteger(relativeDay) || relativeDay < 0 || relativeDay > 6 || !allowedDays.has(relativeDay)) continue;
      const absoluteDay = firstDay + relativeDay;
      if (!(slots[absoluteDay] || []).length) unavailable.add(absoluteDay);
    }
  }

  const weekVersions = Object.fromEntries(config.weekStarts.map((weekStart) => [
    weekStart,
    weekStart === draft.weekStart ? currentVersion + 1 : availabilityWeekVersion(current, weekStart),
  ]));
  return {
    availability: {
      userId,
      slots,
      hardUnavailableDays: [...unavailable].sort((a, b) => a - b),
      outWeekIndexes: [...outWeeks].sort((a, b) => a - b),
      weekVersions,
      weekStart: baseWeekStart,
      updatedAt: now,
    } satisfies Availability,
    version: currentVersion + 1,
  };
}
