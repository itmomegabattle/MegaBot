import { parseProjectLocalDate, projectDateTimeInstant } from './projectTime.js';
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
  return '';
}
