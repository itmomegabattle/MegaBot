import { projectDateTimeInstant } from './projectTime.js';

export interface TimerChannel {
  id: string;
  title: string;
  username?: string;
  canPost: boolean;
  seenAt: number;
}

export const timerFields = ['days', 'hours', 'minutes', 'seconds', 'clock', 'totalHours'] as const;
export const timerIntervals = [1, 5, 15, 30, 60, 300] as const;

export interface ChannelTimerDraft {
  date: string;
  time: string;
  template: string;
  finalText: string;
  interval: number;
  emojiDigits?: boolean;
}

export interface ChannelTimer extends ChannelTimerDraft {
  id: string;
  channelId: string;
  deadline: number;
  createdAt: number;
  status: 'publishing' | 'running' | 'paused' | 'finished' | 'failed' | 'unknown' | 'deleting' | 'deleted';
  messageId?: number;
  error?: string;
  version?: number;
  pausedAt?: number;
  pendingEdit?: boolean;
}

function asEmojiDigits(value: string) {
  return value.replace(/[0-9]/g, digit => digit + '\uFE0F\u20E3');
}

export function renderChannelTimer(template: string, deadline: number, now = Date.now(), emojiDigits = false) {
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  const days = Math.floor(remaining / 86400);
  const totalHours = Math.floor(remaining / 3600);
  const hours = totalHours % 24;
  const minutes = Math.floor(remaining / 60) % 60;
  const seconds = remaining % 60;
  const clock = [totalHours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  const values = { days, hours, minutes, seconds, clock, totalHours };
  return template.replace(/\{(days|hours|minutes|seconds|clock|totalHours)\}/g,
    (_, key: keyof typeof values) => emojiDigits ? asEmojiDigits(String(values[key])) : String(values[key]));
}

export function readChannelTimerDraft(input: Record<string, unknown>, now = Date.now(), existing?: ChannelTimerDraft) {
  const { date, time, interval } = input;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) return;
  const instant = projectDateTimeInstant(date, time);
  if (!instant || (instant.getTime() <= now && !(existing?.date === date && existing.time === time))
      || instant.getTime() - now > 366 * 86400000) return;
  if (!timerIntervals.some(value => value === interval)) return;
  const template = typeof input.template === 'string' ? input.template.trim() : '';
  const finalText = typeof input.finalText === 'string' ? input.finalText.trim() : '';
  const emojiDigits = input.emojiDigits === true;
  const longestValue = emojiDigits ? asEmojiDigits('0000:00:00') : '0000:00:00';
  if (!template || template.length > 3800 || finalText.length > 4096
      || !timerFields.some(field => template.includes('{' + field + '}'))
      || template.replace(/\{(?:days|hours|minutes|seconds|clock|totalHours)\}/g, longestValue).length > 4096) return;
  return { date, time, template, finalText, interval: Number(interval), deadline: instant.getTime(), emojiDigits };
}

export function channelFromMembership(update: Record<string, any>): TimerChannel | undefined {
  const event = update.my_chat_member;
  if (event?.chat?.type !== 'channel' || !Number.isSafeInteger(event.chat.id)
      || typeof event.chat.title !== 'string' || !Number.isSafeInteger(event.date)) return;
  return {
    id: String(event.chat.id), title: event.chat.title, username: event.chat.username,
    canPost: event.new_chat_member?.status === 'creator'
      || (event.new_chat_member?.status === 'administrator' && event.new_chat_member.can_post_messages === true),
    seenAt: event.date * 1000,
  };
}

export function knownTimerChannels(channels: TimerChannel[], inbox: { payload: Record<string, any> }[]) {
  const result = new Map(channels.map(channel => [channel.id, channel]));
  for (const item of inbox) {
    const channel = channelFromMembership(item.payload);
    if (channel && channel.seenAt >= (result.get(channel.id)?.seenAt ?? -1)) result.set(channel.id, channel);
  }
  return [...result.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

export function channelTimerLink(channelId: string, messageId: number) {
  return 'https://t.me/c/' + channelId.replace(/^-100/, '') + '/' + messageId;
}
