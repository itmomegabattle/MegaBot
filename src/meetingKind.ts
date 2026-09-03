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
