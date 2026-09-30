import { normalizeAvailabilityConfig } from './availabilityConfig.js';
import { normalizeMeetingKind } from './meetingKind.js';
import { parseProjectLocalDate, projectDateTimeInstant, projectLocalWeekday } from './projectTime.js';
import type { Meeting, SimulationState } from './types.js';

export function meetingScheduleError(
  dateValue: string,
  timeValue: string,
  duration: number,
  settings: SimulationState['settings'],
  kind: Meeting['kind'] = 'meeting',
  now = new Date(),
) {
  const date = parseProjectLocalDate(dateValue);
  const timeMatch = String(timeValue || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!date || !timeMatch) return 'Проверь дату и время собрания';
  if (Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) return 'Проверь время собрания';
  const instant = projectDateTimeInstant(dateValue, timeValue, now);
  if (!instant || instant.getTime() <= now.getTime()) return 'Нельзя создать событие в прошлом';
  if (normalizeMeetingKind(kind) === 'vibe') return '';
  const config = normalizeAvailabilityConfig(settings);
  const weekday = projectLocalWeekday(date);
  const dayIndex = weekday === 0 ? 6 : weekday - 1;
  if (!config.activeDays.includes(dayIndex)) return 'В этот день встречи отключены в настройках слотов';
  const startMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  const allowedStart = config.startHour * 60;
  const allowedEnd = (config.endHour + 1) * 60;
  if (startMinutes < allowedStart || startMinutes + duration * 60 > allowedEnd) {
    return `Встреча должна полностью помещаться в диапазон ${String(config.startHour).padStart(2, '0')}:00–${String(config.endHour).padStart(2, '0')}:59`;
  }
  return '';
}
