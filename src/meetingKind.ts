import type { MeetingKind } from './types.js';

export const MEETING_KIND_TEXT = {
  meeting: { label: 'Собрание', genitive: 'собрания', accusative: 'собрание', created: 'Новая встреча запланирована!', updated: 'Встреча изменена', cancelled: 'Встреча отменена.' },
  setup: { label: 'Монтаж', genitive: 'монтажа', accusative: 'монтаж', created: 'Новый монтаж запланирован!', updated: 'Монтаж изменён', cancelled: 'Монтаж отменён.' },
  vibe: { label: 'Вайбик', genitive: 'вайбика', accusative: 'вайбик', created: 'Новый вайбик запланирован!', updated: 'Вайбик изменён', cancelled: 'Вайбик отменён.' },
} as const;

export function normalizeMeetingKind(value: unknown): MeetingKind {
  return value === 'setup' || value === 'vibe' ? value : 'meeting';
}

export function meetingKindText(value: unknown) {
  return MEETING_KIND_TEXT[normalizeMeetingKind(value)];
}

export function meetingDurationError(kind: unknown, duration: number) {
  if (normalizeMeetingKind(kind) === 'setup') {
    return Number.isInteger(duration) && duration >= 1 && duration <= 12 ? '' : 'Длительность монтажа: целое число часов от 1 до 12';
  }
  return Number.isFinite(duration) && duration >= 0.5 && duration <= 6 && Number.isInteger(duration * 2)
    ? '' : 'От 30 минут до 6 часов с шагом 30 минут';
}
