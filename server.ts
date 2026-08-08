import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { ProxyAgent } from 'undici';
import { SimulationState, User, Availability, Meeting, Task, BotMessage, Faculty, TaskReminder, WorkEvent } from './src/types.js';
import {
  buildUserMappingReport,
  currentMoscowWeekStart,
  ensureTemplateSheet,
  ensurePrimaryWeekSheet,
  exportAvailabilitiesToSheet,
  exportAvailabilityToSheet,
  googleSheetsConfigFromEnv,
  importAvailabilitiesFromSheet,
  verifySheetsWebhook,
} from './src/googleSheetsSync.js';
import {
  exportStateToGoogleSheetsDatabase,
  googleSheetsDatabaseSheetUrl,
  googleSheetsDatabaseConfigFromEnv,
  importStateFromGoogleSheetsDatabase,
} from './src/googleSheetsDatabase.js';
import { sanitizeSimulationState } from './src/stateMaintenance.js';
import { filterSlotsByAvailabilityConfig, normalizeAvailabilityConfig } from './src/availabilityConfig.js';
import { birthdayGiftCollectionText } from './src/birthdayGift.js';
import {
  googleCalendarConfigFromEnv,
  reconcileGoogleCalendar,
  syncMeetingToGoogleCalendar,
} from './src/googleCalendarSync.js';

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const telegramProxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

function telegramFetch(input: string, init: RequestInit = {}) {
  const url = String(input);
  const isLongPoll = url.includes('/getUpdates');
  const timeoutMs = isLongPoll ? 40000 : 10000;
  const attempts = isLongPoll ? 1 : 2;

  const run = async (attempt = 1): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, telegramProxyAgent ? ({
        ...init,
        signal: init.signal || controller.signal,
        dispatcher: telegramProxyAgent,
      } as RequestInit) : {
        ...init,
        signal: init.signal || controller.signal,
      });
    } catch (err) {
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
        return run(attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };

  return run();
}

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(process.cwd(), 'database.json');
const DATABASE_SHEETS_CONFIG = googleSheetsDatabaseConfigFromEnv();
const CHAT_PANEL_FILE = process.env.CHAT_PANEL_FILE
  ? path.resolve(process.env.CHAT_PANEL_FILE)
  : DATABASE_SHEETS_CONFIG?.enabled
    ? path.join(process.cwd(), 'chat-panels.json')
    : `${DB_FILE}.chat-panels.json`;
let databaseStateCache: SimulationState | null = null;
let pendingDatabaseSheetsState: SimulationState | null = null;
let databaseSheetsFlushTimer: NodeJS.Timeout | null = null;
let databaseSheetsFlushPromise: Promise<void> | null = null;

const PRODUCTION_WEBAPP_URL = 'https://megaorgiabot.ru';
const TEMPORARY_TUNNEL_HOST = /(?:^|\.)(?:loca\.lt|localtunnel\.me|lhr\.life|ngrok(?:-free)?\.(?:app|io)|trycloudflare\.com)$/i;
let resolvedWebAppUrl: string | undefined;

function revisionedWebAppUrl(value: string) {
  const revision = String(process.env.APP_REVISION || '').trim().slice(0, 12);
  if (!value || !revision || process.env.NODE_ENV !== 'production') return value;
  const url = new URL(value);
  url.searchParams.set('v', revision);
  return url.toString();
}

function configuredWebAppUrl() {
  if (resolvedWebAppUrl !== undefined) return resolvedWebAppUrl;
  const configured = String(process.env.WEBAPP_URL || '').trim().replace(/\/$/, '');
  if (!configured) {
    resolvedWebAppUrl = revisionedWebAppUrl(process.env.NODE_ENV === 'production' ? PRODUCTION_WEBAPP_URL : '');
    return resolvedWebAppUrl;
  }
  try {
    const url = new URL(configured);
    if (process.env.NODE_ENV === 'production' && TEMPORARY_TUNNEL_HOST.test(url.hostname)) {
      console.warn(`Temporary WEBAPP_URL ${url.hostname} is not allowed in production; using ${PRODUCTION_WEBAPP_URL}.`);
      resolvedWebAppUrl = revisionedWebAppUrl(PRODUCTION_WEBAPP_URL);
      return resolvedWebAppUrl;
    }
  } catch {
    console.warn('WEBAPP_URL is invalid; Mini App button was disabled.');
    resolvedWebAppUrl = '';
    return resolvedWebAppUrl;
  }
  resolvedWebAppUrl = revisionedWebAppUrl(configured);
  return resolvedWebAppUrl;
}

const DEFAULT_FACULTIES: Faculty[] = ['КТУ', 'НОЖ', 'ТИНТ', 'ФТМФ', 'ФТМИ'].map((name) => ({
  id: 'fac_' + name.toLowerCase(),
  name,
}));

function createEmptyState(): SimulationState {
  return {
    users: [],
    faculties: [...DEFAULT_FACULTIES],
    facultyCompetencies: [],
    competencies: [],
    availabilities: {},
    meetings: [],
    events: [],
    tasks: [],
    messages: {},
    settings: { availabilityWeekCount: 2 },
  };
}

function getAdminTelegramIds() {
  return (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAdminUsernames() {
  return (process.env.ADMIN_USERNAMES || '@wonkersone')
    .split(',')
    .map((item) => item.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}

function getRoleForTelegramUser(telegramId: string | number, username?: string): User['role'] {
  const id = String(telegramId);
  const normalizedUsername = (username || '').replace(/^@/, '').toLowerCase();
  if (getAdminTelegramIds().includes(id) || getAdminUsernames().includes(normalizedUsername)) {
    return 'admin';
  }
  return 'organizer';
}

function isEnvAdmin(telegramId: string | number, username?: string) {
  const id = String(telegramId);
  const normalizedUsername = (username || '').replace(/^@/, '').toLowerCase();
  return getAdminTelegramIds().includes(id) || getAdminUsernames().includes(normalizedUsername);
}

function isFacultyUser(user?: User) {
  return user?.role === 'faculty_responsible' || user?.role === 'faculty_helper';
}

function findUserByTelegramIdentity(state: SimulationState, telegramId: string | number, username?: string) {
  const id = String(telegramId);
  const normalizedUsername = (username || '').replace(/^@/, '').toLowerCase();
  const userByTelegramId = state.users.find((user) => user.telegramId === id);
  if (userByTelegramId) return userByTelegramId;
  if (!normalizedUsername) return undefined;
  return state.users.find((user) => (
    !user.telegramId
    && user.username.replace(/^@/, '').toLowerCase() === normalizedUsername
  ));
}

function ensureEnvAdminUser(state: SimulationState, telegramId: string | number, username?: string, realName?: string) {
  if (!isEnvAdmin(telegramId, username)) return undefined;
  const id = String(telegramId);
  const normalizedUsername = username ? `@${username.replace(/^@/, '')}` : `@tg${id}`;
  let user = findUserByTelegramIdentity(state, id, username);

  if (!user) {
    user = {
      id: 'u_' + Date.now(),
      username: normalizedUsername,
      realName: realName || username || `Telegram ${id}`,
      role: 'admin',
      avatarSeed: username || id,
      birthday: '',
      telegramId: id,
      registered: true,
      competencies: [],
      primaryCompetency: '',
      facultyId: '',
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    state.users.push(user);
    return user;
  }

  user.telegramId = id;
  user.username = normalizedUsername;
  user.role = 'admin';
  user.registered = true;
  if (!user.realName && realName) user.realName = realName;
  return user;
}

function verifyTelegramInitData(initData: string, botToken?: string) {
  if (!botToken || !initData) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

function createSessionToken(userId: string) {
  const secret = process.env.SESSION_SECRET || process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!secret) return '';
  const payload = Buffer.from(JSON.stringify({
    userId,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionToken(token?: string) {
  const secret = process.env.SESSION_SECRET || process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!secret || !token) return '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return '';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return '';
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.expiresAt > Date.now() && typeof data.userId === 'string' ? data.userId : '';
  } catch {
    return '';
  }
}

function cookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return '';
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function formatShortDate(value?: string) {
  if (!value) return '';
  if (/^\d{2}\.\d{2}(?:\.\d{2}|\.\d{4})?$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}.${match[2]}.${match[1].slice(2)}`;
  return value;
}

function birthdayParts(value?: string) {
  const rawValue = String(value || '').trim();
  const isoMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const normalizedValue = isoMatch
    ? `${isoMatch[3]}.${isoMatch[2]}.${isoMatch[1]}`
    : rawValue;
  const match = normalizedValue.match(/^(\d{2})\.(\d{2})(?:\.(\d{2}|\d{4}))?$/);
  if (!match) return null;
  const rawYear = match[3];
  const year = rawYear
    ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
    : undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const validationYear = year || 2000;
  const candidate = new Date(validationYear, month - 1, day);
  if (candidate.getFullYear() !== validationYear || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return null;
  return { day, month, year };
}

function ageOnBirthday(value: string | undefined, year = new Date().getFullYear()) {
  const parts = birthdayParts(value);
  return parts?.year ? year - parts.year : null;
}

function formatBirthday(value?: string) {
  const parts = birthdayParts(value);
  if (!parts) return 'не указана';
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}${parts.year ? `.${parts.year}` : ''}`;
}

function daysUntilBirthday(value?: string, from = new Date()) {
  const parts = birthdayParts(value);
  if (!parts) return null;
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let target = new Date(from.getFullYear(), parts.month - 1, parts.day);
  if (target < today) target = new Date(from.getFullYear() + 1, parts.month - 1, parts.day);
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function parseShortDate(value?: string) {
  if (!value) return null;
  const normalized = formatShortDate(value);
  const match = normalized.match(/^(\d{2})\.(\d{2})(?:\.(\d{2}))?$/);
  if (!match) return null;
  const year = match[3] ? Number(`20${match[3]}`) : new Date().getFullYear();
  return new Date(year, Number(match[2]) - 1, Number(match[1]), 18, 0, 0, 0);
}

function meetingDateTime(meeting: Pick<Meeting, 'date' | 'time'>) {
  const normalized = formatShortDate(meeting.date);
  const dateMatch = normalized.match(/^(\d{2})\.(\d{2})(?:\.(\d{2}|\d{4}))?$/);
  const timeMatch = String(meeting.time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch) return Number.POSITIVE_INFINITY;
  const year = dateMatch[3]
    ? Number(dateMatch[3].length === 4 ? dateMatch[3] : `20${dateMatch[3]}`)
    : new Date().getFullYear();
  return new Date(
    year,
    Number(dateMatch[2]) - 1,
    Number(dateMatch[1]),
    Number(timeMatch?.[1] || 0),
    Number(timeMatch?.[2] || 0),
  ).getTime();
}

function isRegistrationPrompt(text: string) {
  const normalized = text.trim().toLowerCase();
  return normalized.startsWith('/register') || normalized === 'регистрация' || normalized === 'профиль';
}

function isOpenAppText(text: string) {
  const normalized = text.trim().toLowerCase();
  return normalized === 'открыть приложение' || normalized === 'mini app' || normalized === 'мини-приложение';
}

function assignedIds(task: Task) {
  return task.assignedTo || [];
}

function taskCompetencyNames(task: Task) {
  return task.competencies?.length ? task.competencies : task.competency ? [task.competency] : [];
}

function meetingScheduleError(dateValue: string, timeValue: string, duration: number, settings: SimulationState['settings']) {
  const date = parseShortDate(dateValue);
  const timeMatch = String(timeValue || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!date || !timeMatch) return 'Проверь дату и время собрания';
  if (Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) return 'Проверь время собрания';
  const config = normalizeAvailabilityConfig(settings);
  const dayIndex = date.getDay() === 0 ? 6 : date.getDay() - 1;
  if (!config.activeDays.includes(dayIndex)) return 'В этот день встречи отключены в настройках слотов';
  const startMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  const allowedStart = config.startHour * 60;
  const allowedEnd = (config.endHour + 1) * 60;
  if (startMinutes < allowedStart || startMinutes + duration * 60 > allowedEnd) {
    return `Встреча должна полностью помещаться в диапазон ${String(config.startHour).padStart(2, '0')}:00–${String(config.endHour).padStart(2, '0')}:59`;
  }
  return '';
}

function userMention(user?: User) {
  if (!user) return 'не указан';
  return `${user.realName} (${user.username})`;
}

function taskPriorityLabel(priority?: Task['priority']) {
  if (priority === 'critical') return 'очень важная';
  if (priority === 'important') return 'важная';
  return 'обычная';
}

function taskDurationLabel(minutes?: number) {
  if (!minutes) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} ч` : '', rest ? `${rest} мин` : ''].filter(Boolean).join(' ');
}

function taskDetailsText(task: Task, state: SimulationState) {
  const creator = state.users.find((user) => user.id === task.creatorId);
  const workEvent = state.events?.find((item) => item.id === task.eventId);
  const executors = assignedIds(task)
    .map((id) => state.users.find((user) => user.id === id))
    .filter(Boolean) as User[];
  const executorText = task.status === 'open'
    ? 'открытая задача'
    : executors.length
      ? executors.map(userMention).join(', ')
      : 'не указан';

  const progressNotes = assignedIds(task)
    .map((id) => {
      const assignee = state.users.find((user) => user.id === id);
      const note = task.assigneeNotes?.[id];
      if (!note?.executor && !note?.coordinator) return '';
      return `• ${assignee?.realName || 'Исполнитель'}${note.executor ? `: ${note.executor}` : ''}${note.coordinator ? `\n  Координатор: ${note.coordinator}` : ''}`;
    })
    .filter(Boolean);
  const completionNotes = Object.entries(task.completionComments || {})
    .filter(([, comment]) => String(comment || '').trim())
    .map(([id, comment]) => `• ${state.users.find((user) => user.id === id)?.realName || 'Исполнитель'}: ${comment}`);
  return `*${task.title}*\n\n${task.description}\n\n*Мероприятие:* ${workEvent?.name || 'без мероприятия'}\n*Блоки:* ${taskCompetencyNames(task).join(', ') || 'не указаны'}\n*Приоритет:* ${taskPriorityLabel(task.priority)}\n*Автор:* ${userMention(creator)}\n*Срок:* ${formatShortDate(task.deadline)}\n*Исполнитель:* ${executorText}${task.timeSpentMinutes ? `\n*Затрачено:* ${taskDurationLabel(task.timeSpentMinutes)}` : ''}${task.sow ? `\n\n*ТЗ:* ${task.sow}` : ''}${progressNotes.length ? `\n\n*Комментарии по работе:*\n${progressNotes.join('\n')}` : ''}${completionNotes.length ? `\n\n*Комментарий при завершении:*\n${completionNotes.join('\n')}` : ''}${task.tips?.length ? `\n\n*Подсказки:*\n${task.tips.map((tip) => `• ${tip}`).join('\n')}` : ''}`;
}

function meetingDetailsText(meeting: Meeting, state: SimulationState) {
  const host = state.users.find((user) => user.id === meeting.hostId);
  const attendeeNames = (meeting.attendeeIds || [])
    .map((id) => state.users.find((user) => user.id === id)?.realName)
    .filter(Boolean);
  const durationMinutes = Math.round(Number(meeting.duration || 1) * 60);
  return `*${meeting.title}*\n\n*Дата:* ${formatShortDate(meeting.date)}\n*Время:* ${meeting.time}\n*Длительность:* ${taskDurationLabel(durationMinutes)}\n*Организатор:* ${userMention(host)}${meeting.competency ? `\n*Блок:* ${meeting.competency}` : ''}${meeting.topic ? `\n*Тема:* ${meeting.topic}` : ''}${meeting.description ? `\n*Описание:* ${meeting.description}` : ''}\n*Придут:* ${attendeeNames.length}${attendeeNames.length ? ` — ${attendeeNames.join(', ')}` : ''}`;
}

function roleLabel(role: User['role']) {
  if (role === 'admin') return 'администратор';
  if (role === 'organizer') return 'организатор';
  if (role === 'faculty_responsible') return 'ответственный факультета';
  return 'помощник факультета';
}

function profileSummaryText(user: User, state: SimulationState) {
  const activeTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && task.status !== 'completed');
  const completedTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && task.status === 'completed');
  const upcomingMeetings = state.meetings
    .filter((meeting) => (
      meeting.status === 'scheduled'
      && (meeting.participants === 'all' || meeting.participants.includes(user.id) || meeting.hostId === user.id)
      && meetingDateTime(meeting) >= Date.now()
    ))
    .slice()
    .sort((a, b) => meetingDateTime(a) - meetingDateTime(b));
  const availability = alignedAvailabilitySlots(state.availabilities[user.id]);
  const availableHours = Array.from({ length: 7 }, (_, dayIndex) => availability[dayIndex] || [])
    .reduce((sum, hours) => sum + hours.length, 0);
  const nextMeeting = upcomingMeetings[0];
  const birthdayCountdown = daysUntilBirthday(user.birthday);
  const birthdayAge = ageOnBirthday(user.birthday);

  return `*${user.realName}*\n${user.username} · ${roleLabel(user.role)}`
    + `\n\n*Главный блок:* ${user.primaryCompetency || 'не выбран'}`
    + `\n*Дата рождения:* ${formatBirthday(user.birthday)}${birthdayAge !== null ? ` · ${birthdayAge} лет` : ''}`
    + `${birthdayCountdown !== null ? `\n*До дня рождения:* ${birthdayCountdown === 0 ? 'сегодня' : `${birthdayCountdown} дн.`}` : ''}`
    + `\n\n*Сейчас:*`
    + `\n• активных задач — ${activeTasks.length}`
    + `\n• выполнено задач — ${completedTasks.length}`
    + `\n• ближайших встреч — ${upcomingMeetings.length}`
    + `\n• свободных часов отмечено — ${availableHours}`
    + `${nextMeeting ? `\n\n*Следующая встреча:* ${formatShortDate(nextMeeting.date)}, ${nextMeeting.time} — ${nextMeeting.title}` : ''}`;
}

function slotsSummaryText(user: User, state: SimulationState, overrideSlots?: Record<number, number[]>) {
  const availability = overrideSlots || alignedAvailabilitySlots(state.availabilities[user.id]);
  const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const { activeDays } = normalizeAvailabilityConfig(state.settings);
  const rows = activeDays.map((index) => {
    const hours = availability[index] || [];
    return `${dayNames[index]}: ${hours.length ? hours.map((hour) => `${hour}:00`).join(', ') : '—'}`;
  });
  return `*Мои слоты на эту неделю*\n\n${rows.join('\n')}`;
}

function meetingsSummaryText(user: User, state: SimulationState) {
  const meetings = state.meetings
    .filter((meeting) => (
      meeting.status === 'scheduled'
      && meetingDateTime(meeting) >= Date.now()
    ))
    .slice()
    .sort((a, b) => meetingDateTime(a) - meetingDateTime(b))
    .slice(0, 8);
  if (!meetings.length) return '*Встречи*\n\nБлижайших встреч нет.';
  return `*Ближайшие встречи*\n\n${meetings.map((meeting, index) => (
    `${index + 1}. *${meeting.title}*\n${formatShortDate(meeting.date)}, ${meeting.time}`
      + `${meeting.topic ? `\n${meeting.topic}` : ''}`
  )).join('\n\n')}`;
}

function tasksSummaryText(user: User, state: SimulationState) {
  const myTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && task.status !== 'completed');
  const openTasks = state.tasks.filter((task) => task.status === 'open');
  const personal = myTasks.length
    ? myTasks.slice(0, 8).map((task, index) => (
        `${index + 1}. *${task.title}* · ${taskStatusLabel(task.status)}\nДедлайн: ${formatShortDate(task.deadline) || 'не указан'}`
      )).join('\n\n')
    : 'Активных задач нет.';
  return `*Мои задачи*\n\n${personal}\n\n*Свободных задач на доске:* ${openTasks.length}`;
}

function teamSummaryText(state: SimulationState) {
  const users = state.users.filter((user) => !isFacultyUser(user));
  const registered = users.filter((user) => user.registered).length;
  return `*Команда · ${users.length}*\nВ боте: ${registered}/${users.length}\n\n`
    + users.slice(0, 12).map((user) => `• ${user.realName} · ${user.primaryCompetency || 'без блока'} · ${user.username}`).join('\n');
}

function facultiesSummaryText(state: SimulationState) {
  const faculties = state.faculties || [];
  const activeTasks = state.tasks.filter((task) => task.facultyId && task.status !== 'completed');
  return `*МФ · факультеты*\n\n${faculties.map((faculty) => {
    const people = state.users.filter((user) => user.facultyId === faculty.id).length;
    const tasks = activeTasks.filter((task) => task.facultyId === faculty.id).length;
    return `• ${faculty.name}: ${people} чел., ${tasks} активных задач`;
  }).join('\n') || 'Факультеты ещё не добавлены.'}`;
}

function nextShortDate(daysAhead = 1) {
  const target = new Date();
  target.setDate(target.getDate() + daysAhead);
  return `${String(target.getDate()).padStart(2, '0')}.${String(target.getMonth() + 1).padStart(2, '0')}.${String(target.getFullYear()).slice(2)}`;
}

function currentWeekStartIso() {
  return currentMoscowWeekStart();
}

function alignedAvailabilitySlots(availability?: Availability) {
  const result: Record<number, number[]> = {};
  if (!availability?.slots) return result;
  const savedWeekStart = availability.weekStart || currentWeekStartIso();
  const weekOffset = Math.floor((new Date(currentWeekStartIso()).getTime() - new Date(savedWeekStart).getTime()) / (7 * 24 * 60 * 60 * 1000));
  for (const [key, value] of Object.entries(availability.slots)) {
    const nextKey = Number(key) - weekOffset * 7;
    if (nextKey >= 0 && nextKey < 35) result[nextKey] = Array.isArray(value) ? value : [];
  }
  return result;
}

function alignedHardUnavailableDays(availability?: Availability) {
  if (!availability?.hardUnavailableDays) return [];
  const savedWeekStart = availability.weekStart || currentWeekStartIso();
  const weekOffset = Math.floor((new Date(currentWeekStartIso()).getTime() - new Date(savedWeekStart).getTime()) / (7 * 24 * 60 * 60 * 1000));
  return availability.hardUnavailableDays
    .map((day) => Number(day) - weekOffset * 7)
    .filter((day) => Number.isFinite(day) && day >= 0 && day < 35);
}

function hasSubmittedAvailabilityForWeek(availability: Availability | undefined, settings: SimulationState['settings'], weekIndex = 0) {
  if (!availability) return false;
  const slots = alignedAvailabilitySlots(availability);
  const unavailableDays = new Set(alignedHardUnavailableDays(availability));
  const firstDay = weekIndex * 7;
  return normalizeAvailabilityConfig(settings).activeDays.map((dayOffset) => firstDay + dayOffset).some((dayIndex) => (
    (slots[dayIndex] || []).length > 0 || unavailableDays.has(dayIndex)
  ));
}

function formatDateTimeShort(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getFullYear()).slice(2)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTelegramHtml(text: string) {
  return escapeHtml(text)
    .replace(/\[\[tg:(\d+)\|([^\]\n]+)\]\]/g, '<a href="tg://user?id=$1">$2</a>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

function telegramCommandSlug(value: string) {
  const normalized = value.trim().toLowerCase();
  const knownAliases: Array<[RegExp, string]> = [
    [/^(?:partners?|партн[её]ры|партн[её]рка|партн[её]рство)$/i, 'partners'],
    [/^(?:sound|audio|звук)$/i, 'sound'],
    [/^(?:design|дизайн)$/i, 'design'],
    [/^(?:production|продакшн)$/i, 'production'],
    [/^(?:smm|смм)$/i, 'smm'],
  ];
  const known = knownAliases.find(([pattern]) => pattern.test(normalized));
  if (known) return known[1];
  const transliteration: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return [...normalized]
    .map((character) => transliteration[character] ?? character)
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 27) || 'block';
}

function taskStatusLabel(status: Task['status']) {
  if (status === 'completed') return 'Выполнена';
  if (status === 'in_progress') return 'В работе';
  if (status === 'waiting') return 'Ждет';
  if (status === 'assigned') return 'В работе';
  return 'Открытая';
}

function parseFacultyTaskStatus(text: string): Task['status'] | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'ждет' || normalized === 'ждёт') return 'waiting';
  if (normalized === 'в работе') return 'in_progress';
  if (normalized === 'выполнено' || normalized === 'выполнена') return 'completed';
  return null;
}

function loadDatabase(): SimulationState {
  if (databaseStateCache) return structuredClone(databaseStateCache);
  if (DATABASE_SHEETS_CONFIG?.enabled) throw new Error('Google Sheets database has not finished loading');
  let state: SimulationState;
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      state = JSON.parse(data);
    } else {
      state = createEmptyState();
    }
  } catch (error) {
    console.error('Error reading database file, using defaults:', error);
    state = createEmptyState();
  }

  const cleanState = sanitizeSimulationState(state);
  DEFAULT_FACULTIES.forEach((faculty) => {
    if (!cleanState.faculties!.some((item) => item.id === faculty.id || item.name === faculty.name)) {
      cleanState.faculties!.push(faculty);
    }
  });
  databaseStateCache = cleanState;
  return structuredClone(databaseStateCache);
}

function saveDatabase(state: SimulationState) {
  const cleanState = sanitizeSimulationState(state);
  if (DATABASE_SHEETS_CONFIG?.enabled) {
    cleanState.settings ||= {};
    cleanState.settings.databaseRevision = Math.max(0, Number(cleanState.settings.databaseRevision || 0)) + 1;
  }
  Object.keys(state).forEach((key) => delete (state as unknown as Record<string, unknown>)[key]);
  Object.assign(state, cleanState);
  databaseStateCache = structuredClone(state);
  if (DATABASE_SHEETS_CONFIG?.enabled) {
    scheduleDatabaseSheetsSnapshot(state);
    return true;
  }
  return writeDatabaseFile(state);
}

function writeDatabaseFile(state: SimulationState) {
  const temporaryFile = `${DB_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(temporaryFile, DB_FILE);
    return true;
  } catch (error) {
    console.error('Error writing database file:', error);
    try {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch {
      // The original write error is the useful one.
    }
    return false;
  }
}

function scheduleDatabaseSheetsSnapshot(state: SimulationState, delayMs = 500) {
  if (!DATABASE_SHEETS_CONFIG?.enabled) return;
  pendingDatabaseSheetsState = structuredClone(state);
  if (databaseSheetsFlushTimer || databaseSheetsFlushPromise) return;
  databaseSheetsFlushTimer = setTimeout(() => {
    databaseSheetsFlushTimer = null;
    void flushDatabaseSheetsSnapshots();
  }, delayMs);
}

async function flushDatabaseSheetsSnapshots() {
  if (!DATABASE_SHEETS_CONFIG?.enabled) return;
  if (databaseSheetsFlushPromise) return databaseSheetsFlushPromise;
  databaseSheetsFlushPromise = (async () => {
    while (pendingDatabaseSheetsState) {
      const snapshot = pendingDatabaseSheetsState;
      pendingDatabaseSheetsState = null;
      try {
        await exportStateToGoogleSheetsDatabase(DATABASE_SHEETS_CONFIG, snapshot, 'runtime_snapshot');
      } catch (error) {
        console.error('Google Sheets database snapshot failed; local JSON remains authoritative until retry:', error);
        pendingDatabaseSheetsState ||= snapshot;
        if (!databaseSheetsFlushTimer) {
          databaseSheetsFlushTimer = setTimeout(() => {
            databaseSheetsFlushTimer = null;
            void flushDatabaseSheetsSnapshots();
          }, 5_000);
        }
        break;
      }
    }
  })().finally(() => {
    databaseSheetsFlushPromise = null;
    if (pendingDatabaseSheetsState && !databaseSheetsFlushTimer) scheduleDatabaseSheetsSnapshot(pendingDatabaseSheetsState);
  });
  return databaseSheetsFlushPromise;
}

async function hydrateDatabaseFromGoogleSheets() {
  if (!DATABASE_SHEETS_CONFIG?.enabled) return;
  const remote = await importStateFromGoogleSheetsDatabase(DATABASE_SHEETS_CONFIG);
  if (!remote.initialized || !remote.state) throw new Error('Google Sheets database has no complete snapshot');
  databaseStateCache = sanitizeSimulationState(remote.state);
  console.log(`Google Sheets database loaded at revision ${remote.revision}.`);
}

function normalizeTaskReminders(value: unknown): TaskReminder[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item: any) => Number(item?.value) > 0)
    .slice(0, 3)
    .map((item: any, index) => ({
      id: String(item.id || `rem_${Date.now()}_${index}`),
      type: item.type === 'repeat' ? 'repeat' : 'before_deadline',
      value: Math.max(1, Number(item.value) || 1),
      unit: item.unit === 'hours' ? 'hours' : 'days',
      sentAt: item.sentAt,
      lastSentAt: item.lastSentAt,
    }));
}

function pruneExpiredAvailabilityWeeks() {
  const state = loadDatabase();
  const weekStart = currentWeekStartIso();
  let changed = false;
  Object.entries(state.availabilities).forEach(([userId, availability]) => {
    if ((availability.weekStart || weekStart) === weekStart) return;
    state.availabilities[userId] = {
      ...availability,
      slots: alignedAvailabilitySlots(availability),
      hardUnavailableDays: alignedHardUnavailableDays(availability),
      weekStart,
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  });
  if (changed) saveDatabase(state);
  return changed;
}

async function startServer() {
  await hydrateDatabaseFromGoogleSheets();
  pruneExpiredAvailabilityWeeks();
  const app = express();
  const sheetsConfig = googleSheetsConfigFromEnv();
  const calendarConfig = googleCalendarConfigFromEnv();
  const pendingCalendarMeetingIds = new Set<string>();
  let calendarReconciliationRunning = false;
  const processedSheetsEvents = new Set<string>();
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buffer) => {
      if (req.url.startsWith('/api/integrations/google-sheets/webhook')) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      }
    },
  }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'megabot',
      revision: process.env.APP_REVISION || 'unknown',
      uptimeSeconds: Math.floor(process.uptime()),
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN),
      webAppConfigured: Boolean(configuredWebAppUrl()),
      googleSheetsConfigured: Boolean(sheetsConfig),
      googleSheetsDatabaseConfigured: Boolean(DATABASE_SHEETS_CONFIG),
      googleSheetsDatabaseEnabled: Boolean(DATABASE_SHEETS_CONFIG?.enabled),
      googleCalendarConfigured: Boolean(calendarConfig),
      googleCalendarEnabled: Boolean(calendarConfig?.enabled),
    });
  });
  app.use('/api', (req, res, next) => {
    const publicPaths = new Set([
      '/user/get-or-create',
      '/telegram-webhook',
      '/setup-webhook',
      '/integrations/google-sheets/webhook',
    ]);
    if (publicPaths.has(req.path)) return next();

    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(req.hostname);
    if (process.env.NODE_ENV !== 'production' || (isLocalHost && process.env.ALLOW_LOCAL_PREVIEW === 'true')) {
      return next();
    }

    const state = loadDatabase();
    const sessionUserId = verifySessionToken(cookieValue(req.headers.cookie, 'megabot_session'));
    const authUser = state.users.find((user) => user.id === sessionUserId && user.registered);
    if (!authUser) {
      return res.status(401).json({ error: 'Открой Mini App кнопкой в Telegram, чтобы подтвердить доступ.' });
    }
    (req as express.Request & { authUserId?: string }).authUserId = authUser.id;

    const identityFieldByPath: Record<string, string> = {
      '/availability': 'userId',
      '/availability/weeks': 'requesterId',
      '/meeting': 'hostId',
      '/meeting/update': 'requesterId',
      '/meeting/delete': 'requesterId',
      '/meeting/rsvp': 'requesterId',
      '/event/create': 'requesterId',
      '/event/update': 'requesterId',
      '/task/create': 'creatorId',
      '/task/update': 'requesterId',
      '/task/comment': 'requesterId',
      '/task/notify': 'requesterId',
      '/task/claim': 'userId',
      '/task/release': 'userId',
      '/task/status': 'requesterId',
      '/task/log/clear': 'requesterId',
      '/team/broadcast': 'requesterId',
      '/user/add': 'requesterId',
      '/user/delete': 'requesterId',
      '/user/update': 'requesterId',
      '/competency/add': 'requesterId',
      '/competency/delete': 'requesterId',
      '/faculty/competency/add': 'requesterId',
      '/faculty/competency/delete': 'requesterId',
      '/faculty/user/add': 'requesterId',
      '/faculty/user/delete': 'requesterId',
      '/faculty/user/update': 'requesterId',
      '/faculty/task/create': 'requesterId',
      '/faculty/task/update': 'requesterId',
    };
    const identityField = identityFieldByPath[req.path];
    if (identityField && req.body && typeof req.body === 'object') {
      req.body[identityField] = authUser.id;
    }
    return next();
  });
  app.get('/api/integrations/google-sheets/availability', (_req, res) => {
    if (!sheetsConfig) return res.status(503).json({ error: 'Google Sheets availability is not configured' });
    const gid = sheetsConfig.primarySheetId === undefined ? '' : `#gid=${sheetsConfig.primarySheetId}`;
    return res.redirect(`https://docs.google.com/spreadsheets/d/${sheetsConfig.spreadsheetId}/edit${gid}`);
  });
  app.get('/api/integrations/google-sheets/task-log', async (_req, res) => {
    if (!DATABASE_SHEETS_CONFIG) return res.status(503).json({ error: 'Google Sheets database is not configured' });
    try {
      return res.redirect(await googleSheetsDatabaseSheetUrl(DATABASE_SHEETS_CONFIG, 'task_log'));
    } catch (error: any) {
      return res.status(502).json({ error: error.message || 'Не удалось открыть лог задач' });
    }
  });
  const chatSessions = new Map<string, {
    flow: string;
    meetingKind?: 'general' | 'competency';
    competency?: string;
    participantIds?: string[];
    topic?: string;
    description?: string;
    taskIds?: string[];
    selectedTaskId?: string;
    selectedStatus?: Task['status'];
    slotDay?: number;
    pendingSlots?: Record<number, number[]>;
    draftName?: string;
    draftUsername?: string;
    draftBirthday?: string;
    draftRole?: User['role'];
    taskTitle?: string;
    taskDescription?: string;
    taskDeadline?: string;
    taskCompetency?: string;
    taskPriority?: Task['priority'];
    taskEventId?: string;
    completionTaskId?: string;
    completionTimeMinutes?: number;
  }>();
  type StoredChatUiState = {
    version: 2;
    panels: Record<string, { current?: number; known: number[] }>;
    pendingSheetExports: string[];
    groupMembers?: Record<string, Record<string, {
      telegramId: string;
      username?: string;
      displayName: string;
      active: boolean;
      updatedAt: string;
    }>>;
    slotDrafts: Record<string, {
      userId: string;
      weekStart: string;
      slots: Record<number, number[]>;
    }>;
  };
  const loadChatUiState = (): StoredChatUiState => {
    try {
      if (!fs.existsSync(CHAT_PANEL_FILE)) return { version: 2, panels: {}, pendingSheetExports: [], slotDrafts: {} };
      const saved = JSON.parse(fs.readFileSync(CHAT_PANEL_FILE, 'utf8')) as StoredChatUiState | Record<string, number>;
      if ((saved as StoredChatUiState).version === 2 && (saved as StoredChatUiState).panels) {
        return { ...(saved as StoredChatUiState), pendingSheetExports: (saved as StoredChatUiState).pendingSheetExports || [] };
      }
      const panels = Object.fromEntries(
        Object.entries(saved)
          .filter(([, value]) => Number.isInteger(value))
          .map(([chatId, value]) => [chatId, { current: value, known: [value as number] }]),
      );
      return { version: 2, panels, pendingSheetExports: [], slotDrafts: {} };
    } catch (error) {
      console.error('Error reading chat panel state:', error);
      return { version: 2, panels: {}, pendingSheetExports: [], slotDrafts: {} };
    }
  };
  const chatUiState = loadChatUiState();
  const chatPanelMessageIds = new Map(
    Object.entries(chatUiState.panels)
      .filter(([, panel]) => Number.isInteger(panel.current))
      .map(([chatId, panel]) => [chatId, panel.current!]),
  );
  const chatPanelKnownIds = new Map(
    Object.entries(chatUiState.panels)
      .map(([chatId, panel]) => [chatId, new Set(panel.known.filter(Number.isInteger))]),
  );
  const chatSlotDrafts = new Map(Object.entries(chatUiState.slotDrafts || {}));
  const pendingSheetAvailabilityExports = new Set(chatUiState.pendingSheetExports || []);
  const groupMembers = new Map(Object.entries(chatUiState.groupMembers || {}).map(([chatId, members]) => [
    chatId,
    new Map(Object.entries(members)),
  ]));
  const pendingGroupMentions = new Map<string, { competency?: string; expiresAt: number; promptMessageId?: number }>();
  const pendingGroupCheckins = new Map<string, { expiresAt: number; promptMessageId?: number }>();
  const processedCallbackIds = new Set<string>();
  const telegramChatUpdateQueues = new Map<string, Promise<void>>();
  const persistChatPanelMessageIds = () => {
    const temporaryFile = `${CHAT_PANEL_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const panels = Object.fromEntries([...chatPanelKnownIds.entries()].map(([chatId, known]) => [chatId, {
        current: chatPanelMessageIds.get(chatId),
        known: [...known],
      }]));
      fs.writeFileSync(temporaryFile, JSON.stringify({
        version: 2,
        panels,
        pendingSheetExports: [...pendingSheetAvailabilityExports],
        groupMembers: Object.fromEntries([...groupMembers.entries()].map(([chatId, members]) => [
          chatId,
          Object.fromEntries(members),
        ])),
        slotDrafts: Object.fromEntries(chatSlotDrafts),
      }, null, 2), 'utf8');
      fs.renameSync(temporaryFile, CHAT_PANEL_FILE);
      return true;
    } catch (error) {
      console.error('Error writing chat panel state:', error);
      try {
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      } catch {
        // The original write error is the useful one.
      }
      return false;
    }
  };
  const rememberGroupMember = (chatId: string | number, telegramUser: any, active = true) => {
    if (!telegramUser?.id || telegramUser.is_bot) return;
    const chatKey = String(chatId);
    const telegramId = String(telegramUser.id);
    const members = groupMembers.get(chatKey) || new Map();
    const previous = members.get(telegramId);
    const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').trim()
      || previous?.displayName
      || telegramUser.username
      || `Участник ${telegramId}`;
    members.set(telegramId, {
      telegramId,
      username: telegramUser.username ? `@${String(telegramUser.username).replace(/^@/, '')}` : previous?.username,
      displayName,
      active,
      updatedAt: new Date().toISOString(),
    });
    groupMembers.set(chatKey, members);
    persistChatPanelMessageIds();
  };
  const rememberChatPanelMessage = (chatId: string | number, messageId?: number) => {
    const chatKey = String(chatId);
    if (messageId) {
      chatPanelMessageIds.set(chatKey, messageId);
      const known = chatPanelKnownIds.get(chatKey) || new Set<number>();
      known.add(messageId);
      chatPanelKnownIds.set(chatKey, known);
    } else chatPanelMessageIds.delete(chatKey);
    persistChatPanelMessageIds();
  };
  const forgetChatPanelMessage = (chatId: string | number, messageId: number) => {
    const chatKey = String(chatId);
    const known = chatPanelKnownIds.get(chatKey);
    known?.delete(messageId);
    if (known && known.size === 0) chatPanelKnownIds.delete(chatKey);
    if (chatPanelMessageIds.get(chatKey) === messageId) chatPanelMessageIds.delete(chatKey);
  };
  const flushPendingSheetAvailabilityExports = async () => {
    if (!sheetsConfig || pendingSheetAvailabilityExports.size === 0) return;
    const state = loadDatabase();
    for (const userId of [...pendingSheetAvailabilityExports]) {
      const availability = state.availabilities[userId];
      if (!availability) {
        pendingSheetAvailabilityExports.delete(userId);
        continue;
      }
      try {
        await exportAvailabilityToSheet(sheetsConfig, state.users, availability);
        pendingSheetAvailabilityExports.delete(userId);
      } catch (error: any) {
        console.error(`Google Sheets queued availability export failed for ${userId}:`, error.message || error);
      }
    }
    persistChatPanelMessageIds();
  };
  const groupCheckins = new Map<string, { title: string; userIds: Set<string> }>();
  let lastSheetAvailabilityPullAt = 0;
  let sheetAvailabilityPull: Promise<void> | null = null;
  const mergePrimarySheetAvailability = (previous: Availability | undefined, imported: Availability): Availability => ({
    ...previous,
    ...imported,
    slots: {
      ...Object.fromEntries(Object.entries(previous?.slots || {}).filter(([day]) => Number(day) >= 7)),
      ...Object.fromEntries(Object.entries(imported.slots || {}).filter(([day]) => Number(day) >= 0 && Number(day) < 7)),
    },
    hardUnavailableDays: previous?.hardUnavailableDays || [],
  });
  const reconcileAvailabilityFromPrimarySheet = async (maxAgeMs = 0) => {
    if (!sheetsConfig || Date.now() - lastSheetAvailabilityPullAt < maxAgeMs) return;
    if (sheetAvailabilityPull) return sheetAvailabilityPull;
    sheetAvailabilityPull = (async () => {
      const state = loadDatabase();
      const result = await importAvailabilitiesFromSheet(sheetsConfig, state.users);
      let changed = false;
      for (const availability of result.imported) {
        const previous = state.availabilities[availability.userId];
        const merged = mergePrimarySheetAvailability(previous, availability);
        if (JSON.stringify(previous?.slots || {}) === JSON.stringify(merged.slots || {})) continue;
        state.availabilities[availability.userId] = merged;
        changed = true;
      }
      if (changed) saveDatabase(state);
      lastSheetAvailabilityPullAt = Date.now();
    })().finally(() => { sheetAvailabilityPull = null; });
    return sheetAvailabilityPull;
  };

  // API Routes

  // Get entire simulation state
  app.get('/api/state', async (req, res) => {
    if (sheetsConfig) {
      try { await reconcileAvailabilityFromPrimarySheet(3_000); }
      catch (error: any) { console.error('Google Sheets on-read reconciliation failed:', error.message || error); }
    }
    const state = loadDatabase();
    res.json(state);
  });

  function isAdminUser(state: SimulationState, userId?: string) {
    return Boolean(userId && state.users.find((user) => user.id === userId && user.role === 'admin'));
  }

  function isRegisteredUser(state: SimulationState, userId?: string) {
    return Boolean(userId && state.users.find((user) => user.id === userId && user.registered));
  }

  app.post('/api/integrations/google-sheets/webhook', async (req, res) => {
    if (!sheetsConfig) return res.status(503).json({ error: 'Google Sheets integration is not configured' });
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const timestamp = String(req.headers['x-megabot-timestamp'] || '');
    const signature = String(req.headers['x-megabot-signature'] || '');
    if (!verifySheetsWebhook(sheetsConfig.webhookSecret, timestamp, rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid Google Sheets webhook signature' });
    }
    const eventId = String(req.body?.eventId || '');
    if (!eventId) return res.status(400).json({ error: 'eventId is required' });
    if (processedSheetsEvents.has(eventId)) return res.json({ success: true, duplicate: true });
    processedSheetsEvents.add(eventId);
    if (processedSheetsEvents.size > 2_000) processedSheetsEvents.delete(processedSheetsEvents.values().next().value as string);
    if (String(req.body?.spreadsheetId || '') !== sheetsConfig.spreadsheetId) {
      return res.status(403).json({ error: 'Unexpected spreadsheet' });
    }
    const isPrimarySheet = sheetsConfig.primarySheetId !== undefined
      ? Number(req.body?.sheetId) === sheetsConfig.primarySheetId
      : String(req.body?.sheetTitle || '') === sheetsConfig.primarySheetTitle;
    if (!isPrimarySheet) {
      return res.json({ success: true, ignored: 'not_primary_sheet' });
    }
    try {
      const state = loadDatabase();
      const row = Number(req.body?.row);
      const rows = Number(req.body?.rows || 1);
      const changedUserRow = rows === 1 && Number.isInteger(row) && row >= 5 && row <= 200 ? row : undefined;
      const result = await importAvailabilitiesFromSheet(
        sheetsConfig,
        state.users,
        changedUserRow,
        String(req.body?.sheetTitle || ''),
      );
      let changed = false;
      result.imported.forEach((availability) => {
        const previous = state.availabilities[availability.userId];
        const merged = mergePrimarySheetAvailability(previous, availability);
        if (JSON.stringify(previous?.slots || {}) !== JSON.stringify(merged.slots || {})) {
          state.availabilities[availability.userId] = merged;
          changed = true;
        }
      });
      if (changed) saveDatabase(state);
      lastSheetAvailabilityPullAt = Date.now();
      return res.json({ success: true, importedUsers: result.imported.length });
    } catch (error: any) {
      console.error('Google Sheets webhook import failed:', error);
      return res.status(500).json({ error: error.message || 'Google Sheets import failed' });
    }
  });

  app.get('/api/integrations/google-sheets/mapping', async (req, res) => {
    if (!sheetsConfig) return res.status(503).json({ error: 'Google Sheets integration is not configured' });
    const state = loadDatabase();
    const requesterId = (req as express.Request & { authUserId?: string }).authUserId || String(req.query.requesterId || '');
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Admin access required' });
    try { return res.json(await buildUserMappingReport(sheetsConfig, state.users)); }
    catch (error: any) { return res.status(500).json({ error: error.message || 'Mapping failed' }); }
  });

  app.post('/api/integrations/google-sheets/template', async (req, res) => {
    if (!sheetsConfig) return res.status(503).json({ error: 'Google Sheets integration is not configured' });
    const state = loadDatabase();
    const requesterId = (req as express.Request & { authUserId?: string }).authUserId || String(req.body?.requesterId || '');
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Admin access required' });
    try { return res.json({ success: true, ...(await ensureTemplateSheet(sheetsConfig, state.users)) }); }
    catch (error: any) { return res.status(500).json({ error: error.message || 'Template creation failed' }); }
  });

  // Helper to send message to Telegram
  function buildChatKeyboard(_includeWebApp = false, user?: User) {
    if (isFacultyUser(user)) {
      return {
        keyboard: [[{ text: 'Профиль' }, { text: 'Мои задачи' }], [{ text: 'Помощь' }]],
        resize_keyboard: true,
        is_persistent: true,
      };
    }
    const keyboard: any[] = [];

    keyboard.push(
      [{ text: 'Профиль' }, { text: 'Слоты' }],
      [{ text: 'Встречи' }, { text: 'Задачи' }],
    );
    keyboard.push(user?.role === 'admin'
      ? [{ text: 'МФ' }, { text: 'Помощь' }]
      : [{ text: 'Помощь' }]);

    return {
      keyboard,
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  function buildKeyboard(rows: string[][], _includeWebApp = false, user?: User) {
    const keyboard: any[] = [];
    rows.forEach((row) => keyboard.push(row.map((text) => ({ text }))));
    return { keyboard, resize_keyboard: true, is_persistent: true };
  }

  async function deleteTelegramMessage(chatId: string | number, messageId?: number) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken || !messageId) return false;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function deleteOldChatPanels(chatId: string | number, currentMessageId: number) {
    const chatKey = String(chatId);
    const oldMessageIds = [...(chatPanelKnownIds.get(chatKey) || [])]
      .filter((messageId) => messageId !== currentMessageId);
    if (!oldMessageIds.length) return;
    await Promise.all(oldMessageIds.map(async (messageId) => {
      await deleteTelegramMessage(chatId, messageId);
      forgetChatPanelMessage(chatId, messageId);
    }));
    persistChatPanelMessageIds();
  }

  async function editTelegramPanel(
    chatId: string | number,
    messageId: number,
    text: string,
    inlineKeyboard?: { text: string; callback_data: string }[][],
  ) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return false;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
        }),
      });
      if (response.ok) {
        rememberChatPanelMessage(chatId, messageId);
        return true;
      }
      const errorBody = await response.text();
      if (response.status === 400 && errorBody.toLowerCase().includes('message is not modified')) {
        rememberChatPanelMessage(chatId, messageId);
        return true;
      }
      console.error('Telegram panel edit failed:', response.status, errorBody);
      return false;
    } catch (error) {
      console.error('Telegram panel edit failed:', error);
      return false;
    }
  }

  async function sendTelegramKeyboard(chatId: string | number, text: string, rows: string[][], includeWebApp = false, user?: User) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          reply_markup: buildKeyboard(rows, includeWebApp, user),
        }),
      });
      if (!response.ok) {
        console.error('Telegram keyboard send failed:', response.status, await response.text());
        return;
      }
      const data = await response.json() as { result?: { message_id?: number } };
      if (data.result?.message_id) {
        rememberChatPanelMessage(chatId, data.result.message_id);
        await deleteOldChatPanels(chatId, data.result.message_id);
        return data.result.message_id;
      }
    } catch (err) {
      console.error('Telegram keyboard send failed:', err);
    }
  }

  async function sendInlinePanel(
    chatId: string | number,
    text: string,
    inlineKeyboard: { text: string; callback_data: string }[][],
  ) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined,
        }),
      });
      if (!response.ok) return;
      const data = await response.json() as { result?: { message_id?: number } };
      if (data.result?.message_id) {
        rememberChatPanelMessage(chatId, data.result.message_id);
        await deleteOldChatPanels(chatId, data.result.message_id);
        return data.result.message_id;
      }
    } catch (err) {
      console.error('Telegram panel send failed:', err);
    }
  }

  async function updateInlinePanel(
    chatId: string | number,
    messageId: number | undefined,
    text: string,
    inlineKeyboard: { text: string; callback_data: string }[][],
  ) {
    if (messageId && await editTelegramPanel(chatId, messageId, text, inlineKeyboard)) return true;
    await sendInlinePanel(chatId, text, inlineKeyboard);
    return false;
  }

  async function sendGroupMessage(chatId: string | number, text: string): Promise<number | undefined> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;
      if (!response.ok || data?.ok === false) {
        console.error('Telegram group message failed:', response.status, data?.description || 'Unknown Telegram response');
        return;
      }
      return data?.result?.message_id;
    } catch (err) {
      console.error('Telegram group message failed:', err);
    }
  }

  let telegramBotIdPromise: Promise<string | null> | null = null;
  async function telegramBotId() {
    if (telegramBotIdPromise) return telegramBotIdPromise;
    telegramBotIdPromise = (async () => {
      const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
      if (!botToken) return null;
      const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/getMe`);
      const data = await response.json().catch(() => null) as { ok?: boolean; result?: { id?: string | number } } | null;
      return data?.ok && data.result?.id ? String(data.result.id) : null;
    })().catch((error) => {
      console.error('Telegram getMe failed:', error);
      telegramBotIdPromise = null;
      return null;
    });
    return telegramBotIdPromise;
  }

  async function botCanReceiveOrdinaryGroupMessages(chatId: string | number) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    const botId = await telegramBotId();
    if (!botToken || !botId) return null;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(botId)}`);
      const data = await response.json().catch(() => null) as { ok?: boolean; result?: { status?: string } } | null;
      if (!response.ok || !data?.ok) return null;
      return data.result?.status === 'administrator' || data.result?.status === 'creator';
    } catch (error) {
      console.error('Telegram getChatMember failed:', error);
      return null;
    }
  }

  async function clearPendingGroupMention(pendingKey: string, chatId: string | number) {
    const pending = pendingGroupMentions.get(pendingKey);
    pendingGroupMentions.delete(pendingKey);
    if (pending?.promptMessageId) await deleteTelegramMessage(chatId, pending.promptMessageId);
    return pending;
  }

  async function clearPendingGroupCheckin(pendingKey: string, chatId: string | number) {
    const pending = pendingGroupCheckins.get(pendingKey);
    pendingGroupCheckins.delete(pendingKey);
    if (pending?.promptMessageId) await deleteTelegramMessage(chatId, pending.promptMessageId);
    return pending;
  }

  async function startGroupCheckin(chatId: string | number, title: string) {
    const panelId = await sendInlinePanel(chatId, `*${title}*\n\nОтметились: 0\nПока никто`, [[
      { text: 'Я здесь · 0', callback_data: 'group_checkin' },
    ]]);
    if (panelId) groupCheckins.set(`${chatId}:${panelId}`, { title, userIds: new Set() });
    return Boolean(panelId);
  }

  function scheduleTemporaryGroupMessageDeletion(chatId: string | number, messageId: number | undefined, delayMs = 8_000) {
    if (!messageId) return;
    setTimeout(() => { void deleteTelegramMessage(chatId, messageId); }, delayMs);
  }

  function groupBotCommands(state = loadDatabase()) {
    const used = new Set<string>();
    const blockCommands = (state.competencies || []).slice(0, 92).map((competency) => {
      const base = `all_${telegramCommandSlug(competency)}`.slice(0, 32);
      let command = base;
      let suffix = 2;
      while (used.has(command)) {
        const addition = `_${suffix++}`;
        command = `${base.slice(0, 32 - addition.length)}${addition}`;
      }
      used.add(command);
      return { command, description: `Уведомить блок «${competency}»`, competency };
    });
    return [
    { command: 'all', description: 'Уведомить всех участников беседы' },
    ...blockCommands,
    { command: 'meeting', description: 'Показать ближайшую встречу' },
    { command: 'deadlines', description: 'Показать ближайшие дедлайны' },
    { command: 'slots', description: 'Показать, кто не отметил слоты' },
    { command: 'birthdays', description: 'Показать ближайшие дни рождения' },
    { command: 'checkin', description: 'Название — запустить перекличку' },
    { command: 'help', description: 'Показать команды MegaBot' },
    ];
  }

  function groupCommandCompetencies(state = loadDatabase()) {
    return new Map(groupBotCommands(state)
      .filter((item): item is { command: string; description: string; competency: string } => 'competency' in item)
      .map((item) => [item.command, item.competency]));
  }

  function refreshGroupCommandMenus() {
    const state = loadDatabase();
    const scopes: Record<string, string | number>[] = [
      { type: 'all_group_chats' },
      { type: 'all_chat_administrators' },
    ];
    if (state.settings?.teamChatId) scopes.push({ type: 'chat', chat_id: state.settings.teamChatId });
    void Promise.allSettled(scopes.map((scope) => configureGroupCommandMenu(scope)));
  }

  async function configureGroupCommandMenu(scope: Record<string, string | number> = { type: 'all_group_chats' }) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return false;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          commands: groupBotCommands().map(({ command, description }) => ({ command, description })),
        }),
      });
      if (!response.ok) {
        console.error('Telegram group command menu configuration failed:', response.status, await response.text());
        return false;
      }
      return true;
    } catch (err) {
      console.error('Telegram group command menu configuration failed:', err);
      return false;
    }
  }

  async function configureChatMenuButton(chatId: string | number, user?: User) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    const webAppUrl = configuredWebAppUrl();
    const menuButton = user && !isFacultyUser(user) && webAppUrl
      ? {
          type: 'web_app',
          text: 'Начать',
          web_app: { url: webAppUrl },
        }
      : { type: 'commands' };

    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/setChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          menu_button: menuButton,
        }),
      });
      if (!response.ok) {
        console.error('Telegram setChatMenuButton failed:', response.status, await response.text());
      }
    } catch (err) {
      console.error('Telegram setChatMenuButton failed:', err);
    }
  }

  async function answerCallback(callbackQueryId: string, text?: string) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
      if (!response.ok) {
        console.error('Telegram answerCallback failed:', response.status, await response.text());
      }
    } catch (err) {
      console.error('Telegram answerCallback failed:', err);
    }
  }

  function meetingRecipientIds(state: SimulationState, participants: string[] | 'all', hostId: string) {
    const ids = new Set<string>();
    if (participants === 'all') {
      state.users
        .filter((user) => !isFacultyUser(user))
        .forEach((user) => ids.add(user.id));
    } else {
      participants.forEach((id) => ids.add(id));
      ids.add(hostId);
    }
    return ids;
  }

  async function notifyMeetingRecipients(
    state: SimulationState,
    recipientIds: Iterable<string>,
    text: string,
    notificationPrefix: string,
    buttons: { text: string; action: string }[] = [{ text: 'Открыть встречи', action: 'open_tma' }],
  ) {
    const sendJobs: Promise<boolean>[] = [];
    for (const userId of recipientIds) {
      const target = state.users.find((user) => user.id === userId);
      if (!target) continue;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      state.messages[target.id].push({
        id: `${notificationPrefix}_${Date.now()}_${target.id}`,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
        buttons,
      });
      if (target.telegramId) {
        sendJobs.push(sendTelegramMessage(target.telegramId, text, buttons, false, target));
      }
    }
    return Promise.allSettled(sendJobs);
  }

  async function syncMeetingCalendar(state: SimulationState, meeting: Meeting) {
    if (!calendarConfig?.enabled) return true;
    try {
      const result = await syncMeetingToGoogleCalendar(calendarConfig, meeting, state);
      if (!('skipped' in result)) meeting.googleCalendarEventId = result.eventId;
      pendingCalendarMeetingIds.delete(meeting.id);
      return true;
    } catch (error: any) {
      pendingCalendarMeetingIds.add(meeting.id);
      console.error(`Google Calendar sync failed for meeting ${meeting.id}:`, error.message || error);
      return false;
    }
  }

  function groupMentionToken(target: { telegramId?: string; username?: string; displayName: string }) {
    if (target.username) return `@${target.username.replace(/^@/, '')}`;
    if (!target.telegramId) return target.displayName;
    const safeName = target.displayName.replace(/[\]\n]/g, ' ').trim() || 'Участник';
    return `[[tg:${target.telegramId}|${safeName}]]`;
  }

  function resolveGroupMentionTargets(state: SimulationState, chatId: string | number, competency?: string) {
    const knownMembers = groupMembers.get(String(chatId)) || new Map();
    const targets = new Map<string, { telegramId?: string; username?: string; displayName: string }>();
    const addTarget = (target: { telegramId?: string; username?: string; displayName: string }) => {
      const key = target.telegramId || target.username?.toLowerCase();
      if (key && !targets.has(key)) targets.set(key, target);
    };

    state.users
      .filter((member) => !isFacultyUser(member))
      .filter((member) => !competency || member.primaryCompetency === competency || member.competencies?.includes(competency))
      .forEach((member) => {
        const observed = member.telegramId ? knownMembers.get(String(member.telegramId)) : undefined;
        if (observed?.active === false) return;
        addTarget({
          telegramId: member.telegramId,
          username: member.username,
          displayName: member.realName || observed?.displayName || member.username || 'Участник',
        });
      });

    if (!competency) {
      knownMembers.forEach((member) => {
        if (!member.active) return;
        addTarget(member);
      });
    }

    return [...targets.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
  }

  async function sendGroupMentionNotification(chatId: string | number, note: string, competency?: string, author?: User) {
    const state = loadDatabase();
    const targets = resolveGroupMentionTargets(state, chatId, competency);
    if (targets.length === 0) {
      const messageId = await sendGroupMessage(chatId, competency
        ? `В блоке «${competency}» пока нет участников с привязанным Telegram.`
        : 'Бот пока не знает ни одного участника этой беседы.');
      return Boolean(messageId);
    }
    const heading = competency ? `*Уведомление для блока «${competency}»*` : '*Уведомление для всех*';
    const cleanNote = note.trim().slice(0, 3000);
    const authorLine = author ? `\n\n*Автор:* ${groupMentionToken({
      telegramId: author.telegramId,
      username: author.username,
      displayName: author.realName || author.username || 'Участник',
    })}` : '';
    const prefix = `${heading}${cleanNote ? `\n\n${cleanNote}` : ''}${authorLine}\n\n`;
    const chunks: string[] = [];
    let current = prefix;
    for (const target of targets) {
      const mention = groupMentionToken(target);
      if (current.length + mention.length + 1 > 3900) {
        chunks.push(current.trim());
        current = '*Продолжение списка*\n\n';
      }
      current += `${mention} `;
    }
    if (current.trim()) chunks.push(current.trim());
    for (const chunk of chunks) {
      if (!await sendGroupMessage(chatId, chunk)) return false;
    }
    return true;
  }

  async function reconcileMeetingCalendar() {
    if (!calendarConfig?.enabled || calendarReconciliationRunning) return;
    calendarReconciliationRunning = true;
    try {
      const state = loadDatabase();
      const previousEventIds = state.meetings.map((meeting) => meeting.googleCalendarEventId || '').join('|');
      const result = await reconcileGoogleCalendar(calendarConfig, state);
      pendingCalendarMeetingIds.clear();
      result.failed.forEach((failure) => pendingCalendarMeetingIds.add(failure.meetingId));
      const nextEventIds = state.meetings.map((meeting) => meeting.googleCalendarEventId || '').join('|');
      if (nextEventIds !== previousEventIds) saveDatabase(state);
      if (!result.passed) console.error('Google Calendar reconciliation incomplete:', result.failed);
      else console.log(`Google Calendar synchronized: created=${result.created}, updated=${result.updated}, deleted=${result.deleted}.`);
    } finally {
      calendarReconciliationRunning = false;
    }
  }

  async function retryPendingMeetingCalendar() {
    if (!calendarConfig?.enabled || calendarReconciliationRunning || pendingCalendarMeetingIds.size === 0) return;
    calendarReconciliationRunning = true;
    try {
      const state = loadDatabase();
      let changed = false;
      for (const meetingId of [...pendingCalendarMeetingIds]) {
        const meeting = state.meetings.find((item) => item.id === meetingId);
        if (!meeting) {
          pendingCalendarMeetingIds.delete(meetingId);
          continue;
        }
        const previousEventId = meeting.googleCalendarEventId;
        const synced = await syncMeetingCalendar(state, meeting);
        if (synced && meeting.googleCalendarEventId !== previousEventId) changed = true;
      }
      if (changed) saveDatabase(state);
    } finally {
      calendarReconciliationRunning = false;
    }
  }

  async function createMeetingAndNotify(state: SimulationState, data: {
    title: string;
    type: Meeting['type'];
    date: string;
    time: string;
    duration?: number;
    hostId: string;
    participants: string[] | 'all';
    topic?: string;
    description?: string;
    competency?: string;
  }) {
    const meeting: Meeting = {
      id: 'm_' + Date.now(),
      title: data.title,
      type: data.type,
      date: data.date,
      time: data.time,
      duration: data.duration || 1,
      hostId: data.hostId,
      participants: data.participants,
      attendeeIds: [data.hostId],
      topic: data.topic || '',
      description: data.description || '',
      status: 'scheduled',
      competency: data.competency || '',
    };

    state.meetings.push(meeting);
    const text = `Новая встреча запланирована!\n\n${meetingDetailsText(meeting, state)}\n\nПожалуйста, освободите это время.`;
    await notifyMeetingRecipients(
      state,
      meetingRecipientIds(state, data.participants, data.hostId),
      text,
      'meeting_created',
      [
        { text: 'Я приду', action: `meeting_rsvp:${meeting.id}` },
        { text: 'Открыть встречи', action: 'open_tma' },
      ],
    );
    await syncMeetingCalendar(state, meeting);

    return meeting;
  }

  async function configureBotProfile() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    const description = 'Нажми синюю кнопку «Начать» внизу слева — откроется MegaBot. Если кнопки нет, отправь /start. Здесь можно отмечать свободные слоты, смотреть встречи и работать с задачами команды.';
    const shortDescription = 'Слоты, встречи и задачи команды ITMO MEGABATTLE.';
    const calls = [
      ['setMyDescription', { description }],
      ['setMyShortDescription', { short_description: shortDescription }],
    ] as const;
    const results = await Promise.allSettled(calls.map(([method, body]) => telegramFetch(
      `${tgApiBase}/bot${botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )));
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.error(`Telegram ${calls[index][0]} failed:`, result.reason);
    });
  }

  function updateMeetingAttendance(meeting: Meeting, userId: string, attending: boolean) {
    const attendees = new Set(meeting.attendeeIds || []);
    const wasAttending = attendees.has(userId);
    if (attending) {
      attendees.add(userId);
      if (meeting.participants !== 'all' && !meeting.participants.includes(userId)) {
        meeting.participants = [...meeting.participants, userId];
      }
    } else {
      attendees.delete(userId);
    }
    meeting.attendeeIds = [...attendees];
    return { changed: wasAttending !== attending, attending };
  }

  async function sendTelegramMessage(chatId: string | number, text: string, buttons?: { text: string; action: string }[], keyboardOnly = false, recipient?: User): Promise<boolean> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) {
      console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram message was not sent.');
      return false;
    }
    const webAppUrl = configuredWebAppUrl();

    let replyMarkup: any = buildChatKeyboard(false, recipient);
    if (keyboardOnly) {
      replyMarkup = buildChatKeyboard(false, recipient);
    } else if (buttons && buttons.length > 0) {
      replyMarkup = {};
      replyMarkup.inline_keyboard = buttons.map(b => {
        if (b.action === 'open_tma' || b.action === 'open_tasks') {
          if (!webAppUrl) {
            return [{
              text: b.text,
              callback_data: b.action,
            }];
          }
          return [{
            text: b.text,
            web_app: { url: webAppUrl }
          }];
        }
        return [{
          text: b.text,
          callback_data: b.action
        }];
      });
    }

    try {
      const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          reply_markup: Object.keys(replyMarkup).length > 0 ? replyMarkup : undefined
        })
      });
      const responseText = await response.text();
      let responseData: { ok?: boolean; description?: string } | null = null;
      try { responseData = responseText ? JSON.parse(responseText) : null; }
      catch { responseData = null; }
      if (!response.ok || responseData?.ok === false) {
        console.error('Telegram sendMessage failed:', response.status, responseData?.description || responseText);
        return false;
      }
      return true;
    } catch (err) {
      console.error('Telegram sendMessage failed:', err);
      return false;
    }
  }

  async function showProfilePanel(chatId: string | number, user: User, state: SimulationState) {
    chatSessions.delete(String(chatId));
    const rows = isFacultyUser(user)
      ? [['Профиль', 'Мои задачи'], ['Помощь']]
      : [
          ['Профиль', 'Слоты'],
          ['Встречи', 'Задачи'],
          ...(user.role === 'admin' ? [['МФ', 'Помощь']] : [['Помощь']]),
        ];
    await sendTelegramKeyboard(chatId, profileSummaryText(user, state), rows, false, user);
  }

  async function showWelcomePanel(chatId: string | number, user: User) {
    const facultyText = isFacultyUser(user)
      ? 'Здесь можно посмотреть профиль и работать со своими задачами.'
      : 'Здесь можно отметить свободные слоты, посмотреть встречи и работать с задачами. Mini App открывается синей кнопкой «Начать» внизу слева.';
    await sendTelegramKeyboard(
      chatId,
      `*Привет, ${user.realName || 'участник'}!*\n\nЯ MegaBot команды ITMO MEGABATTLE. ${facultyText}\n\nВыбери нужный раздел кнопками под строкой ввода.`,
      buildChatKeyboard(false, user).keyboard.map((row: any[]) => row.map((item) => item.text)),
      false,
      user,
    );
  }

  function cloneValidSlotSelection(state: SimulationState, source?: Record<number, number[]>) {
    return filterSlotsByAvailabilityConfig(source, state.settings);
  }

  function currentSlotDraft(chatKey: string, user: User, state: SimulationState) {
    const savedDraft = chatSlotDrafts.get(chatKey);
    if (savedDraft?.userId === user.id && savedDraft.weekStart === currentWeekStartIso()) {
      return cloneValidSlotSelection(state, savedDraft.slots);
    }
    return cloneValidSlotSelection(state, alignedAvailabilitySlots(state.availabilities[user.id]));
  }

  function storeSlotDraft(chatKey: string, user: User, state: SimulationState, slots: Record<number, number[]>, slotDay?: number) {
    const safeSlots = cloneValidSlotSelection(state, slots);
    chatSessions.set(chatKey, { flow: 'slots_edit', slotDay, pendingSlots: safeSlots });
    chatSlotDrafts.set(chatKey, { userId: user.id, weekStart: currentWeekStartIso(), slots: safeSlots });
    persistChatPanelMessageIds();
    return safeSlots;
  }

  function slotDayPanel(user: User, state: SimulationState, dayIndex: number, pendingSlots: Record<number, number[]>) {
    const dayNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    const { hours } = normalizeAvailabilityConfig(state.settings);
    const selected = pendingSlots[dayIndex] || [];
    const keyboard = hours.reduce<{ text: string; callback_data: string }[][]>((rows, hour, index) => {
      if (index % 2 === 0) rows.push([]);
      rows[rows.length - 1].push({
        text: `${selected.includes(hour) ? '✓ ' : ''}${hour}:00`,
        callback_data: `slot_toggle:${dayIndex}:${hour}`,
      });
      return rows;
    }, []);
    keyboard.push([{
      text: selected.length === hours.length ? 'Снять весь день' : 'Выбрать весь день',
      callback_data: `slot_toggle_day:${dayIndex}`,
    }]);
    keyboard.push([
      { text: 'Сохранить', callback_data: 'slot_save' },
      { text: 'К дням', callback_data: 'nav_slots' },
    ]);
    return {
      text: `${slotsSummaryText(user, state, pendingSlots)}\n\n*${dayNames[dayIndex]}:* выбери свободные часы.`,
      keyboard,
    };
  }

  async function showSlotsPanel(
    chatId: string | number,
    user: User,
    state: SimulationState,
    overrideSlots?: Record<number, number[]>,
    messageId?: number,
  ) {
    const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const { activeDays, hours } = normalizeAvailabilityConfig(state.settings);
    const chatKey = String(chatId);
    const savedDraft = chatSlotDrafts.get(chatKey);
    const availability = cloneValidSlotSelection(state, overrideSlots
      || (savedDraft?.userId === user.id && savedDraft.weekStart === currentWeekStartIso() ? savedDraft.slots : undefined)
      || alignedAvailabilitySlots(state.availabilities[user.id]));
    storeSlotDraft(chatKey, user, state, availability);
    const wholeWeekSelected = activeDays.every((dayIndex) => (
      (availability[dayIndex] || []).length === hours.length
    ));
    const dayButtons = activeDays.map((dayIndex) => ({
      text: `${dayNames[dayIndex]} · ${(availability[dayIndex] || []).length}/${hours.length}`,
      callback_data: `slots_day:${dayIndex}`,
    }));
    const keyboard = [
      ...dayButtons.reduce<{ text: string; callback_data: string }[][]>((rows, button, index) => {
        if (index % 3 === 0) rows.push([]);
        rows[rows.length - 1].push(button);
        return rows;
      }, []),
      [{
        text: wholeWeekSelected ? 'Снять все слоты' : 'Выбрать все слоты',
        callback_data: 'slot_toggle_week',
      }],
      [{ text: 'Сохранить', callback_data: 'slot_save' }],
    ];
    const text = `${slotsSummaryText(user, state, availability)}\n\nВыбери день. Внутри можно отметить отдельные часы или нажать «Выбрать весь день».`;
    if (messageId) await updateInlinePanel(chatId, messageId, text, keyboard);
    else await sendInlinePanel(chatId, text, keyboard);
  }

  async function showMeetingsPanel(chatId: string | number, user: User, state: SimulationState) {
    chatSessions.set(String(chatId), { flow: 'meetings_root' });
    await sendTelegramKeyboard(chatId, meetingsSummaryText(user, state), [
      ['Назначить собрание'],
      ['Назад'],
    ], false, user);
  }

  async function showTasksPanel(chatId: string | number, user: User, state: SimulationState) {
    chatSessions.set(String(chatId), { flow: 'tasks_root' });
    await sendTelegramKeyboard(chatId, tasksSummaryText(user, state), [
      ['Управлять задачами', 'Создать задачу'],
      ['Свободные задачи', 'Выполненные задачи'],
      ['Назад'],
    ], false, user);
  }

  async function showTeamPanel(chatId: string | number, user: User, state: SimulationState) {
    if (user.role !== 'admin') {
      await sendTelegramKeyboard(chatId, 'Раздел команды доступен администратору.', [['Назад']], false, user);
      return;
    }
    chatSessions.set(String(chatId), { flow: 'team_root' });
    await sendTelegramKeyboard(chatId, teamSummaryText(state), [
      ['Найти участника', 'Добавить участника'],
      ['Назад'],
    ], false, user);
  }

  async function showFacultiesPanel(chatId: string | number, user: User, state: SimulationState) {
    if (user.role !== 'admin') {
      await sendTelegramKeyboard(chatId, 'Раздел факультетов доступен администратору.', [['Назад']], false, user);
      return;
    }
    chatSessions.set(String(chatId), { flow: 'faculties_root' });
    await sendTelegramKeyboard(chatId, facultiesSummaryText(state), [
      ['Задачи факультетов'],
      ['Назад'],
    ], false, user);
  }

  async function completeTaskFromChat(state: SimulationState, task: Task, user: User, timeSpentMinutes?: number, completionComment = '') {
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.timeSpentMinutes = timeSpentMinutes;
    task.completionComments = task.completionComments || {};
    const cleanComment = completionComment.trim();
    if (cleanComment) task.completionComments[user.id] = cleanComment;
    else delete task.completionComments[user.id];
    saveDatabase(state);
    const sendJobs = state.users
      .filter((member) => member.role === 'admin' && member.telegramId && member.id !== user.id)
      .map((admin) => sendTelegramMessage(
        admin.telegramId!,
        `Задача выполнена!\n\n${task.title}\nИсполнитель: ${userMention(user)}${timeSpentMinutes ? `\nЗатрачено: ${taskDurationLabel(timeSpentMinutes)}` : ''}${cleanComment ? `\nКомментарий: ${cleanComment}` : ''}`,
        undefined,
        false,
        admin,
      ));
    await Promise.allSettled(sendJobs);
  }

  async function sendDueBirthdayReminders() {
    const state = loadDatabase();
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1);
    const targetBday = `${String(targetDate.getDate()).padStart(2, '0')}.${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
    const markerYear = targetDate.getFullYear();
    let changed = false;

    for (const birthdayUser of state.users) {
      const parts = birthdayParts(birthdayUser.birthday);
      if (!parts || `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}` !== targetBday) continue;
      const nextAge = ageOnBirthday(birthdayUser.birthday, targetDate.getFullYear());

      for (const recipient of state.users) {
        if (recipient.id === birthdayUser.id) continue;
        const notificationId = `bday_notify_${markerYear}_${birthdayUser.id}_${recipient.id}`;
        if (!state.messages[recipient.id]) state.messages[recipient.id] = [];
        if (state.messages[recipient.id].some((message) => message.id === notificationId)) continue;

        const paymentText = `\n\n${birthdayGiftCollectionText()}`;
        const text = `🎂 Завтра день рождения у ${birthdayUser.realName}!`
          + `${nextAge !== null ? ` Исполняется ${nextAge} лет.` : ''}`
          + `\n\nНе забудьте поздравить 🎉${paymentText}`;
        state.messages[recipient.id].push({
          id: notificationId,
          userId: recipient.id,
          sender: 'bot',
          text,
          timestamp: new Date().toISOString(),
        });
        changed = true;

        if (recipient.telegramId) {
          await sendTelegramMessage(recipient.telegramId, text);
        }
      }
    }

    if (changed) {
      saveDatabase(state);
    }
  }

  async function sendSundayAvailabilityReminders() {
    const today = new Date();
    if (today.getDay() !== 0) return;

    const state = loadDatabase();
    const dateKey = today.toISOString().split('T')[0];
    let changed = false;

    for (const user of state.users) {
      if (hasSubmittedAvailabilityForWeek(state.availabilities[user.id], state.settings, 1)) continue;
      const notificationId = `sunday_slots_${dateKey}_${user.id}`;
      if (!state.messages[user.id]) state.messages[user.id] = [];
      if (state.messages[user.id].some((message) => message.id === notificationId)) continue;

      const text = '🔔 Сегодня воскресенье. Отметь, пожалуйста, свободные слоты на следующую неделю в Mini App. Это займёт меньше минуты.';
      state.messages[user.id].push({
        id: notificationId,
        userId: user.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
        buttons: [{ text: 'Открыть Mini App', action: 'open_tma' }],
      });
      changed = true;

      if (user.telegramId) {
        await sendTelegramMessage(user.telegramId, text, [{ text: 'Открыть Mini App', action: 'open_tma' }]);
      }
    }

    if (changed) {
      saveDatabase(state);
    }
  }

  async function sendTaskReminders() {
    const state = loadDatabase();
    const now = new Date();
    let changed = false;
    for (const task of state.tasks) {
      if (task.status === 'completed' || !task.reminders?.length) continue;
      const deadline = parseShortDate(task.deadline);
      if (!deadline) continue;
      for (const reminder of task.reminders) {
        const intervalMs = reminder.value * (reminder.unit === 'hours' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
        let shouldSend = false;
        if (reminder.type === 'before_deadline') {
          const remindAt = new Date(deadline.getTime() - intervalMs);
          shouldSend = now >= remindAt && !reminder.sentAt;
        } else {
          const last = reminder.lastSentAt ? new Date(reminder.lastSentAt) : new Date(task.createdAt || now);
          shouldSend = now.getTime() - last.getTime() >= intervalMs;
        }
        if (!shouldSend) continue;
        for (const id of assignedIds(task)) {
          const target = state.users.find((user) => user.id === id);
          if (!target) continue;
          const text = `Напоминание по задаче:\n\n${taskDetailsText(task, state)}\n\nТекущий статус: ${taskStatusLabel(task.status)}`;
          if (!state.messages[target.id]) state.messages[target.id] = [];
          state.messages[target.id].push({
            id: `task_reminder_${task.id}_${reminder.id}_${Date.now()}_${target.id}`,
            userId: target.id,
            sender: 'bot',
            text,
            timestamp: new Date().toISOString(),
          });
          if (target?.telegramId) {
            await sendTelegramMessage(target.telegramId, text, undefined, false, target);
          }
        }
        if (reminder.type === 'before_deadline') reminder.sentAt = now.toISOString();
        else reminder.lastSentAt = now.toISOString();
        changed = true;
      }
    }
    if (changed) saveDatabase(state);
  }

  // Resolve an already allowed user inside Telegram WebApp.
  app.post('/api/user/get-or-create', (req, res) => {
    const { telegramId, username, initData } = req.body;
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!verifyTelegramInitData(String(initData || ''), botToken)) {
      return res.status(403).json({ success: false, error: 'Не удалось подтвердить Telegram-аккаунт. Открой приложение кнопкой в боте.' });
    }

    const state = loadDatabase();
    const user = findUserByTelegramIdentity(state, telegramId, username)
      || ensureEnvAdminUser(state, telegramId, username, username ? `@${username}` : undefined);

    if (!user) {
      return res.status(403).json({ success: false, error: 'Вас нет в списке участников. Попросите админа добавить ваш Telegram в раздел «Команда».' });
    }

    let changed = false;
    if (!user.telegramId) {
      user.telegramId = String(telegramId);
      changed = true;
    }
    if (username && user.username !== `@${username}`) {
      user.username = `@${username}`;
      changed = true;
    }
    if (isEnvAdmin(telegramId, username) && user.role !== 'admin') {
      user.role = 'admin';
      changed = true;
    }
    if (!user.registered) {
      user.registered = true;
      changed = true;
    }
    if (!user.joinedAt) {
      user.joinedAt = new Date().toISOString();
      changed = true;
    }
    user.lastSeenAt = new Date().toISOString();
    changed = true;
    if (changed) saveDatabase(state);
    const sessionToken = createSessionToken(user.id);
    if (sessionToken) {
      res.setHeader(
        'Set-Cookie',
        `megabot_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Secure`,
      );
    }

    if (isFacultyUser(user)) {
      user.registered = true;
      saveDatabase(state);
      return res.json({ success: false, externalOnly: true, user, error: 'Для вашей роли Mini App закрыт. Пользуйтесь задачами в чате с ботом.' });
    }

    res.json({ success: true, user });
  });

  // Self-register Telegram Bot webhook
  app.get('/api/setup-webhook', async (req, res) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    const webAppUrl = configuredWebAppUrl();

    if (!botToken) {
      return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN or BOT_TOKEN is not set.' });
    }
    if (!webAppUrl) {
      return res.status(400).json({ error: 'WEBAPP_URL is not set.' });
    }

    const webhookUrl = `${webAppUrl}/api/telegram-webhook`;
    try {
      const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'callback_query', 'chat_member', 'my_chat_member']));
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}&allowed_updates=${allowedUpdates}`);
      const data = await response.json();
      return res.json({
        success: true,
        message: 'Telegram webhook setup attempted',
        webhookUrl,
        telegramResponse: data
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'Webhook setup failed', details: err.message });
    }
  });

  // Telegram webhook router
  app.post('/api/telegram-webhook', async (req, res, next) => {
    const update = req.body || {};
    const chatKey = String(
      update.callback_query?.message?.chat?.id
      || update.callback_query?.from?.id
      || update.message?.chat?.id
      || update.chat_member?.chat?.id
      || update.my_chat_member?.chat?.id
      || 'unknown',
    );
    const previous = telegramChatUpdateQueues.get(chatKey) || Promise.resolve();
    let releaseQueue!: () => void;
    const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    telegramChatUpdateQueues.set(chatKey, tail);
    await previous.catch(() => undefined);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseQueue();
      void tail.finally(() => {
        if (telegramChatUpdateQueues.get(chatKey) === tail) telegramChatUpdateQueues.delete(chatKey);
      });
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  }, async (req, res) => {
    const update = req.body;

    const membershipUpdate = update.chat_member || update.my_chat_member;
    if (membershipUpdate?.chat && membershipUpdate?.new_chat_member?.user) {
      const status = String(membershipUpdate.new_chat_member.status || '');
      rememberGroupMember(
        membershipUpdate.chat.id,
        membershipUpdate.new_chat_member.user,
        status !== 'left' && status !== 'kicked',
      );
      return res.json({ ok: true });
    }

    if (update.message?.chat) {
      const messageChatType = String(update.message.chat.type || 'private');
      if (messageChatType === 'group' || messageChatType === 'supergroup') {
        rememberGroupMember(update.message.chat.id, update.message.from, true);
        (update.message.new_chat_members || []).forEach((member: any) => rememberGroupMember(update.message.chat.id, member, true));
        if (update.message.left_chat_member) rememberGroupMember(update.message.chat.id, update.message.left_chat_member, false);
        if (!update.message.text) return res.json({ ok: true });
      }
    }

    if (update.callback_query?.message?.chat && update.callback_query?.from) {
      const callbackChatType = String(update.callback_query.message.chat.type || 'private');
      if (callbackChatType === 'group' || callbackChatType === 'supergroup') {
        rememberGroupMember(update.callback_query.message.chat.id, update.callback_query.from, true);
      }
    }

    if (update.callback_query) {
      const callback = update.callback_query;
      const action = String(callback.data || '');
      const fromUser = callback.from;
      const chatId = callback.message?.chat?.id || fromUser.id;
      const state = loadDatabase();
      const user = state.users.find(u => u.telegramId === String(fromUser.id));

      if (!user) {
        await answerCallback(callback.id, 'Сначала напиши /start');
        return res.json({ ok: true });
      }

      if (processedCallbackIds.has(callback.id)) {
        await answerCallback(callback.id, 'Это нажатие уже обработано');
        return res.json({ ok: true });
      }
      processedCallbackIds.add(callback.id);
      if (processedCallbackIds.size > 2_000) {
        processedCallbackIds.delete(processedCallbackIds.values().next().value as string);
      }

      const callbackMessageId = Number(callback.message?.message_id);
      const currentPanelId = chatPanelMessageIds.get(String(chatId));
      const isSlotPanelAction = action === 'nav_slots'
        || action === 'slot_save'
        || action.startsWith('slots_day:')
        || action.startsWith('slot_toggle:')
        || action.startsWith('slot_toggle_day:')
        || action === 'slot_toggle_week';
      if (isSlotPanelAction && currentPanelId && callbackMessageId !== currentPanelId) {
        await deleteTelegramMessage(chatId, callbackMessageId);
        await answerCallback(callback.id, 'Эта панель устарела. Открой «Слоты» ещё раз.');
        return res.json({ ok: true });
      }

      if (action === 'nav_profile') {
        await answerCallback(callback.id);
        await showProfilePanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (action === 'nav_slots') {
        await answerCallback(callback.id);
        const pendingSlots = currentSlotDraft(String(chatId), user, state);
        await showSlotsPanel(chatId, user, state, pendingSlots, callbackMessageId);
        return res.json({ ok: true });
      }

      if (action === 'nav_tasks') {
        await answerCallback(callback.id);
        await showTasksPanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (action.startsWith('slots_day:')) {
        const dayIndex = Number(action.split(':')[1]);
        const { activeDays } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(dayIndex) || !activeDays.includes(dayIndex)) {
          await answerCallback(callback.id, 'Неизвестный день');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = storeSlotDraft(chatKey, user, state, currentSlotDraft(chatKey, user, state), dayIndex);
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots);
        await answerCallback(callback.id);
        await updateInlinePanel(chatId, callbackMessageId, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_toggle:')) {
        const [, dayValue, hourValue] = action.split(':');
        const dayIndex = Number(dayValue);
        const hour = Number(hourValue);
        const { activeDays, hours } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(dayIndex) || !activeDays.includes(dayIndex) || !hours.includes(hour)) {
          await answerCallback(callback.id, 'Неизвестный слот');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const selected = new Set(pendingSlots[dayIndex] || []);
        if (selected.has(hour)) selected.delete(hour);
        else selected.add(hour);
        pendingSlots[dayIndex] = [...selected].sort((a, b) => a - b);
        storeSlotDraft(chatKey, user, state, pendingSlots, dayIndex);
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots);
        await answerCallback(callback.id, selected.has(hour) ? `${hour}:00 добавлено` : `${hour}:00 снято`);
        await updateInlinePanel(chatId, callbackMessageId, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_toggle_day:')) {
        const dayIndex = Number(action.split(':')[1]);
        const { activeDays, hours } = normalizeAvailabilityConfig(state.settings);
        if (!Number.isInteger(dayIndex) || !activeDays.includes(dayIndex)) {
          await answerCallback(callback.id, 'Неизвестный день');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const fullDay = [...hours];
        const wasFull = (pendingSlots[dayIndex] || []).length === fullDay.length;
        pendingSlots[dayIndex] = wasFull ? [] : fullDay;
        storeSlotDraft(chatKey, user, state, pendingSlots, dayIndex);
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots);
        await answerCallback(callback.id, wasFull ? 'День очищен' : 'Выбран весь день');
        await updateInlinePanel(chatId, callbackMessageId, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action === 'slot_toggle_week') {
        const chatKey = String(chatId);
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        const { activeDays, hours } = normalizeAvailabilityConfig(state.settings);
        const wasFull = activeDays.every((dayIndex) => (pendingSlots[dayIndex] || []).length === hours.length);
        for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) delete pendingSlots[dayIndex];
        for (const dayIndex of activeDays) {
          if (!wasFull) pendingSlots[dayIndex] = [...hours];
        }
        storeSlotDraft(chatKey, user, state, pendingSlots);
        await answerCallback(callback.id, wasFull ? 'Все слоты сняты' : 'Выбраны все слоты недели');
        await showSlotsPanel(chatId, user, state, pendingSlots, callbackMessageId);
        return res.json({ ok: true });
      }

      if (action === 'slot_save') {
        const chatKey = String(chatId);
        const pendingSlots = currentSlotDraft(chatKey, user, state);
        state.availabilities[user.id] = {
          userId: user.id,
          slots: pendingSlots,
          hardUnavailableDays: state.availabilities[user.id]?.hardUnavailableDays || [],
          weekStart: currentWeekStartIso(),
          updatedAt: new Date().toISOString(),
        };
        if (!saveDatabase(state)) {
          await answerCallback(callback.id, 'Не удалось сохранить. Попробуй ещё раз.');
          await updateInlinePanel(
            chatId,
            callbackMessageId,
            `⚠️ *Слоты пока не сохранены*\n\n${slotsSummaryText(user, state, pendingSlots)}\n\nЧерновик сохранён. Нажми «Повторить сохранение».`,
            [
              [{ text: 'Повторить сохранение', callback_data: 'slot_save' }],
              [{ text: 'К дням', callback_data: 'nav_slots' }],
            ],
          );
          return res.json({ ok: true });
        }
        chatSessions.delete(chatKey);
        chatSlotDrafts.delete(chatKey);
        if (sheetsConfig) pendingSheetAvailabilityExports.add(user.id);
        persistChatPanelMessageIds();
        await answerCallback(callback.id, 'Слоты сохранены');
        await updateInlinePanel(
          chatId,
          callbackMessageId,
          `✅ *Слоты сохранены*\n\n${slotsSummaryText(user, state, pendingSlots)}`,
          [
            [{ text: 'Изменить слоты', callback_data: 'nav_slots' }],
            [{ text: 'Профиль', callback_data: 'nav_profile' }],
          ],
        );
        void flushPendingSheetAvailabilityExports();
        return res.json({ ok: true });
      }

      if (action === 'group_checkin') {
        const messageId = callback.message?.message_id;
        const pollKey = `${chatId}:${messageId}`;
        const poll = groupCheckins.get(pollKey);
        if (!poll) {
          await answerCallback(callback.id, 'Перекличка уже завершена');
          return res.json({ ok: true });
        }
        poll.userIds.add(user.id);
        const participants = [...poll.userIds]
          .map((id) => state.users.find((member) => member.id === id)?.realName)
          .filter(Boolean);
        await answerCallback(callback.id, 'Отметил');
        await editTelegramPanel(
          chatId,
          messageId,
          `*${poll.title}*\n\nОтметились: ${participants.length}\n${participants.map((name) => `• ${name}`).join('\n') || 'Пока никто'}`,
          [[{ text: `Я здесь · ${participants.length}`, callback_data: 'group_checkin' }]],
        );
        return res.json({ ok: true });
      }

      if (action.startsWith('meeting_rsvp:')) {
        const meetingId = action.split(':')[1];
        const meeting = state.meetings.find((item) => item.id === meetingId && item.status === 'scheduled');
        if (!meeting) {
          await answerCallback(callback.id, 'Собрание больше неактуально');
          return res.json({ ok: true });
        }
        const result = updateMeetingAttendance(meeting, user.id, true);
        saveDatabase(state);
        await answerCallback(callback.id, result.changed ? 'Отлично, записал: вы придёте' : 'Вы уже отметили, что придёте');
        if (result.changed && meeting.hostId !== user.id) {
          const host = state.users.find((member) => member.id === meeting.hostId);
          if (host?.telegramId) {
            void sendTelegramMessage(host.telegramId, `${userMention(user)} присоединится к собранию «${meeting.title}».`, undefined, false, host);
          }
        }
        return res.json({ ok: true });
      }

      if (action.startsWith('task_view:')) {
        const taskId = action.split(':')[1];
        const task = state.tasks.find(t => t.id === taskId);
        if (!task) {
          await answerCallback(callback.id, 'Задача не найдена');
          return res.json({ ok: true });
        }
        await answerCallback(callback.id);
        const buttons = task.status === 'open'
          ? [
              [{ text: 'Взять задачу', callback_data: `task_claim:${task.id}` }],
              [{ text: 'Назад', callback_data: 'nav_tasks' }],
            ]
          : [[{ text: 'Назад', callback_data: 'nav_tasks' }]];
        await sendInlinePanel(chatId, taskDetailsText(task, state), buttons);
        return res.json({ ok: true });
      }

      if (action.startsWith('task_claim:')) {
        const taskId = action.split(':')[1];
        const task = state.tasks.find(t => t.id === taskId);
        if (!task) {
          await answerCallback(callback.id, 'Задача не найдена');
          return res.json({ ok: true });
        }
        if (task.status !== 'open') {
          await answerCallback(callback.id, 'Задача уже занята');
          await sendTelegramMessage(chatId, 'Эту задачу уже взяли. Открой приложение, чтобы увидеть актуальный список.', [{ text: 'Открыть задачи', action: 'open_tasks' }]);
          return res.json({ ok: true });
        }
        task.assignedTo = [user.id];
        task.status = 'assigned';
        saveDatabase(state);
        await answerCallback(callback.id, 'Задача закреплена за тобой');
        await sendGroupMessage(chatId, `Ты взял задачу:\n\n${taskDetailsText(task, state)}`);
        await showTasksPanel(chatId, user, state);
        const creator = state.users.find(u => u.id === task.creatorId);
        const notifyClaimText = `Задачу "${task.title}" подхватил ${userMention(user)}.\n\nСвязаться: ${user.username}`;
        if (creator?.telegramId && creator.id !== user.id) {
          await sendTelegramMessage(creator.telegramId, notifyClaimText);
        }
        for (const admin of state.users.filter(u => u.role === 'admin' && u.telegramId && u.id !== user.id && u.id !== creator?.id)) {
          await sendTelegramMessage(admin.telegramId!, notifyClaimText);
        }
        return res.json({ ok: true });
      }

      if (action.startsWith('task_release:')) {
        const taskId = action.split(':')[1];
        const task = state.tasks.find(t => t.id === taskId);
        if (!task) {
          await answerCallback(callback.id, 'Задача не найдена');
          return res.json({ ok: true });
        }
        const currentAssignees = assignedIds(task);
        if (!currentAssignees.includes(user.id)) {
          await answerCallback(callback.id, 'Эта задача не на тебе');
          return res.json({ ok: true });
        }
        task.assignedTo = null;
        task.status = 'open';
        task.completedAt = '';
        task.timeSpentMinutes = undefined;
        saveDatabase(state);
        await answerCallback(callback.id, 'Задача возвращена на биржу');
        await sendGroupMessage(chatId, `Ты отказался от задачи *"${task.title}"*. Она снова открыта.`);
        await showTasksPanel(chatId, user, state);
        const creator = state.users.find(u => u.id === task.creatorId);
        if (creator?.telegramId && creator.id !== user.id) {
          await sendTelegramMessage(creator.telegramId, `${userMention(user)} отказался от задачи *"${task.title}"*. Она снова на бирже.`);
        }
        for (const target of state.users.filter(u => u.telegramId && u.id !== user.id)) {
          await sendTelegramMessage(target.telegramId!, `Задача снова свободна:\n\n${taskDetailsText(task, state)}`, [{ text: 'Посмотреть задачу', action: `task_view:${task.id}` }]);
        }
        return res.json({ ok: true });
      }

      if (action.startsWith('task_complete:')) {
        const taskId = action.split(':')[1];
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task || !assignedIds(task).includes(user.id)) {
          await answerCallback(callback.id, 'Задача не найдена');
          return res.json({ ok: true });
        }
        chatSessions.set(String(chatId), { flow: 'task_complete_time', completionTaskId: task.id });
        await answerCallback(callback.id);
        await sendTelegramKeyboard(
          chatId,
          `Задача *"${task.title}"* готова.\n\nСколько времени ушло на выполнение? Это необязательно, но поможет планировать нагрузку.`,
          [['15 минут', '30 минут'], ['1 час', '2 часа'], ['Указать вручную'], ['Не указывать', 'Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      }

      if (action === 'task_skip') {
        await answerCallback(callback.id, 'Ок');
        await showProfilePanel(chatId, user, state);
        return res.json({ ok: true });
      }

      await answerCallback(callback.id);
      return res.json({ ok: true });
    }

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const fromUser = update.message.from;
      const text = update.message.text.trim();

      const state = loadDatabase();

      const displayName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ').trim();
      let user = findUserByTelegramIdentity(state, fromUser.id, fromUser.username)
        || ensureEnvAdminUser(state, fromUser.id, fromUser.username, displayName);
      const chatType = String(update.message.chat.type || 'private');
      const isGroupChat = chatType === 'group' || chatType === 'supergroup';

      if (isGroupChat) {
        const commandMatch = text.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
        const commandName = commandMatch?.[1]?.toLowerCase() || '';
        const commandText = commandMatch?.[2]?.trim() || '';
        const blockCommands = groupCommandCompetencies(state);
        const pendingKey = `${chatId}:${fromUser.id}`;
        const pendingMention = pendingGroupMentions.get(pendingKey);
        const pendingCheckin = pendingGroupCheckins.get(pendingKey);

        if (pendingMention && pendingMention.expiresAt <= Date.now()) await clearPendingGroupMention(pendingKey, chatId);
        if (pendingCheckin && pendingCheckin.expiresAt <= Date.now()) await clearPendingGroupCheckin(pendingKey, chatId);
        if (pendingMention && pendingMention.expiresAt > Date.now() && !commandMatch) {
          if (!user?.registered) {
            await deleteTelegramMessage(chatId, update.message.message_id);
            await clearPendingGroupMention(pendingKey, chatId);
            const warningId = await sendGroupMessage(chatId, 'Эта команда доступна участникам, привязанным к MegaBot.');
            scheduleTemporaryGroupMessageDeletion(chatId, warningId);
            return res.json({ ok: true });
          }
          console.log(`[Group Mention] Received notification text in chat=${chatId} from=${fromUser.id}.`);
          const sent = await sendGroupMentionNotification(chatId, text, pendingMention.competency, user);
          if (sent) {
            await deleteTelegramMessage(chatId, update.message.message_id);
            await clearPendingGroupMention(pendingKey, chatId);
          } else {
            const warningId = await sendGroupMessage(chatId, 'Не удалось отправить уведомление. Твой текст сохранён в чате — повтори отправку или используй /cancel.');
            scheduleTemporaryGroupMessageDeletion(chatId, warningId);
          }
          return res.json({ ok: true });
        }
        if (pendingCheckin && pendingCheckin.expiresAt > Date.now() && !commandMatch) {
          if (!user?.registered) {
            await deleteTelegramMessage(chatId, update.message.message_id);
            await clearPendingGroupCheckin(pendingKey, chatId);
            const warningId = await sendGroupMessage(chatId, 'Эта команда доступна участникам, привязанным к MegaBot.');
            scheduleTemporaryGroupMessageDeletion(chatId, warningId);
            return res.json({ ok: true });
          }
          const title = text.slice(0, 200).trim();
          const started = title ? await startGroupCheckin(chatId, title) : false;
          if (started) {
            await deleteTelegramMessage(chatId, update.message.message_id);
            await clearPendingGroupCheckin(pendingKey, chatId);
          } else {
            const warningId = await sendGroupMessage(chatId, 'Не удалось начать перекличку. Название сохранено в чате — попробуй ещё раз или используй /cancel.');
            scheduleTemporaryGroupMessageDeletion(chatId, warningId);
          }
          return res.json({ ok: true });
        }

        const supportedGroupCommand = new Set([
          'all', 'meeting', 'deadlines', 'slots', 'birthdays', 'checkin', 'bindteamchat', 'help', 'cancel',
          ...blockCommands.keys(),
        ]).has(commandName);
        if (!supportedGroupCommand) return res.json({ ok: true });
        await deleteTelegramMessage(chatId, update.message.message_id);
        if (!user?.registered) {
          await sendGroupMessage(chatId, 'Эта команда доступна участникам, привязанным к MegaBot.');
          return res.json({ ok: true });
        }
        user.lastSeenAt = new Date().toISOString();
        saveDatabase(state);

        if (commandName === 'bindteamchat') {
          if (user.role !== 'admin') {
            await sendGroupMessage(chatId, 'Привязать командный чат может только администратор.');
          } else {
            state.settings = { ...(state.settings || {}), teamChatId: String(chatId) };
            saveDatabase(state);
            await configureGroupCommandMenu({ type: 'chat', chat_id: chatId });
            const canReceiveMessages = await botCanReceiveOrdinaryGroupMessages(chatId);
            await sendGroupMessage(chatId, canReceiveMessages === false
              ? 'Чат привязан к MegaBot, но двухшаговые команды пока не заработают. Назначь бота администратором с правом удаления сообщений.'
              : 'Чат привязан к MegaBot. Командные функции активны.');
          }
          return res.json({ ok: true });
        }

        const configuredChatId = state.settings?.teamChatId;
        if (configuredChatId && configuredChatId !== String(chatId)) {
          await sendGroupMessage(chatId, 'Командные команды доступны только в привязанном чате.');
          return res.json({ ok: true });
        }

        const selectedCompetency = blockCommands.get(commandName);
        if (commandName !== 'cancel' && commandName !== 'all' && !selectedCompetency && pendingGroupMentions.has(pendingKey)) {
          await clearPendingGroupMention(pendingKey, chatId);
        }
        if (commandName !== 'cancel' && commandName !== 'checkin' && pendingGroupCheckins.has(pendingKey)) {
          await clearPendingGroupCheckin(pendingKey, chatId);
        }

        if (commandName === 'cancel') {
          const [hadMention, hadCheckin] = await Promise.all([
            clearPendingGroupMention(pendingKey, chatId),
            clearPendingGroupCheckin(pendingKey, chatId),
          ]);
          const confirmationId = await sendGroupMessage(chatId, hadMention || hadCheckin ? 'Действие отменено.' : 'Нет ожидающего действия.');
          scheduleTemporaryGroupMessageDeletion(chatId, confirmationId);
          return res.json({ ok: true });
        }

        if (commandName === 'all' || selectedCompetency) {
          if (pendingGroupMentions.has(pendingKey)) await clearPendingGroupMention(pendingKey, chatId);
          if (!commandText) {
            const canReceiveMessages = await botCanReceiveOrdinaryGroupMessages(chatId);
            if (canReceiveMessages === false) {
              const warningId = await sendGroupMessage(
                chatId,
                'Бот видит команды, но Telegram не передаёт ему обычные сообщения. Назначь @megaorgi_bot администратором беседы с правом удаления сообщений и повтори /all.',
              );
              scheduleTemporaryGroupMessageDeletion(chatId, warningId, 15_000);
              return res.json({ ok: true });
            }
            const expiresAt = Date.now() + 10 * 60 * 1000;
            const promptMessageId = await sendGroupMessage(
              chatId,
              `${selectedCompetency ? `Выбран блок «${selectedCompetency}». ` : ''}Напиши текст уведомления следующим сообщением. Бот добавит актуальные упоминания автоматически.\n\nДля отмены: /cancel`,
            );
            pendingGroupMentions.set(pendingKey, {
              competency: selectedCompetency,
              expiresAt,
              promptMessageId,
            });
            console.log(`[Group Mention] Waiting for notification text in chat=${chatId} from=${fromUser.id}.`);
            setTimeout(() => {
              const current = pendingGroupMentions.get(pendingKey);
              if (current?.expiresAt !== expiresAt) return;
              void clearPendingGroupMention(pendingKey, chatId);
            }, 10 * 60 * 1000);
            return res.json({ ok: true });
          }
          await sendGroupMentionNotification(chatId, commandText, selectedCompetency, user);
          return res.json({ ok: true });
        }

        if (commandName === 'meeting') {
          const nextMeeting = state.meetings
            .filter((meeting) => meeting.status === 'scheduled' && meetingDateTime(meeting) >= Date.now())
            .slice()
            .sort((a, b) => meetingDateTime(a) - meetingDateTime(b))[0];
          await sendGroupMessage(chatId, nextMeeting
            ? `*Ближайшая встреча*\n\n${meetingDetailsText(nextMeeting, state)}`
            : 'Ближайших встреч нет.');
          return res.json({ ok: true });
        }

        if (commandName === 'deadlines') {
          const tasks = state.tasks
            .filter((task) => task.status !== 'completed')
            .slice()
            .sort((a, b) => (
              (parseShortDate(a.deadline)?.getTime() ?? Number.POSITIVE_INFINITY)
              - (parseShortDate(b.deadline)?.getTime() ?? Number.POSITIVE_INFINITY)
            ))
            .slice(0, 10);
          await sendGroupMessage(chatId, tasks.length
            ? `*Ближайшие дедлайны*\n\n${tasks.map((task) => `• ${formatShortDate(task.deadline) || 'без даты'} — ${task.title}`).join('\n')}`
            : 'Активных задач нет.');
          return res.json({ ok: true });
        }

        if (commandName === 'slots') {
          const team = state.users.filter((member) => !isFacultyUser(member));
          const missing = team.filter((member) => !hasSubmittedAvailabilityForWeek(state.availabilities[member.id], state.settings));
          await sendGroupMessage(chatId, missing.length
            ? `*Ещё не отметили слоты (${missing.length}):*\n${missing.map((member) => member.username).join(' ')}`
            : 'Все участники отметили слоты на неделю.');
          return res.json({ ok: true });
        }

        if (commandName === 'birthdays') {
          const upcoming = state.users
            .map((member) => ({ member, days: daysUntilBirthday(member.birthday) }))
            .filter((item): item is { member: User; days: number } => item.days !== null)
            .sort((a, b) => a.days - b.days)
            .slice(0, 5);
          await sendGroupMessage(chatId, upcoming.length
            ? `*Ближайшие дни рождения*\n\n${upcoming.map(({ member, days }) => (
                `• ${formatBirthday(member.birthday)} — ${member.realName}${days === 0 ? ' · сегодня' : ` · через ${days} дн.`}`
              )).join('\n')}`
            : 'Даты рождения пока не заполнены.');
          return res.json({ ok: true });
        }

        if (commandName === 'checkin') {
          if (commandText) {
            await startGroupCheckin(chatId, commandText.slice(0, 200));
            return res.json({ ok: true });
          }
          if (pendingGroupCheckins.has(pendingKey)) await clearPendingGroupCheckin(pendingKey, chatId);
          const canReceiveMessages = await botCanReceiveOrdinaryGroupMessages(chatId);
          if (canReceiveMessages === false) {
            const warningId = await sendGroupMessage(chatId, 'Бот видит команду, но Telegram не передаёт ему обычные сообщения. Назначь @megaorgi_bot администратором беседы и повтори /checkin.');
            scheduleTemporaryGroupMessageDeletion(chatId, warningId, 15_000);
            return res.json({ ok: true });
          }
          const expiresAt = Date.now() + 10 * 60 * 1000;
          const promptMessageId = await sendGroupMessage(chatId, 'Напиши название переклички следующим сообщением.\n\nДля отмены: /cancel');
          pendingGroupCheckins.set(pendingKey, { expiresAt, promptMessageId });
          setTimeout(() => {
            const current = pendingGroupCheckins.get(pendingKey);
            if (current?.expiresAt !== expiresAt) return;
            void clearPendingGroupCheckin(pendingKey, chatId);
          }, 10 * 60 * 1000);
          return res.json({ ok: true });
        }

        await sendGroupMessage(
          chatId,
          '*Команды MegaBot*\n\n'
            + '/all — уведомить всех участников беседы\n'
            + `${[...blockCommands.entries()].map(([command, competency]) => `/${command} — уведомить блок «${competency}»`).join('\n')}\n`
            + '/meeting — ближайшая встреча\n'
            + '/deadlines — ближайшие дедлайны\n'
            + '/slots — кто не отметил слоты\n'
            + '/birthdays — ближайшие дни рождения\n'
            + '/checkin название — живая перекличка\n'
            + '/bindteamchat — привязать этот чат (админ)',
        );
        return res.json({ ok: true });
      }

      if (!user) {
        await deleteTelegramMessage(chatId, update.message.message_id);
        await configureChatMenuButton(chatId, undefined);
        await sendTelegramKeyboard(
          chatId,
          'Вас нет в списке участников. Попросите админа добавить ваш Telegram в раздел «Команда», а потом нажмите /start ещё раз.',
          [['Помощь']],
          false,
        );
        return res.json({ ok: true });
      } else {
        if (!user.telegramId) user.telegramId = String(fromUser.id);
        if (fromUser.username) user.username = `@${fromUser.username}`;
        user.registered = true;
        if (!user.joinedAt) user.joinedAt = new Date().toISOString();
        user.lastSeenAt = new Date().toISOString();
      }
      await deleteTelegramMessage(chatId, update.message.message_id);
      if (isEnvAdmin(fromUser.id, fromUser.username) && user.role !== 'admin') {
        user.role = 'admin';
      }
      if (text.toLowerCase().startsWith('/start') || isRegistrationPrompt(text)) {
        await configureChatMenuButton(chatId, user);
      }

      if (!state.messages[user.id]) state.messages[user.id] = [];
      state.messages[user.id].push({
        id: 'usr_' + Date.now(),
        userId: user.id,
        sender: 'user',
        text,
        timestamp: new Date().toISOString()
      });
      saveDatabase(state);

      let replyText = '';
      let buttons: { text: string; action: string }[] | undefined = undefined;
      const cmd = text.toLowerCase();
      const chatKey = String(chatId);
      const normalizedText = text.trim().toLowerCase();
      const session = chatSessions.get(chatKey);

      if (isFacultyUser(user)) {
        user.registered = true;
        if (isRegistrationPrompt(text)) {
          await showProfilePanel(chatId, user, state);
          saveDatabase(state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' || normalizedText === 'меню') {
          chatSessions.delete(chatKey);
          await sendTelegramKeyboard(chatId, 'Меню задач.', [['Мои задачи', 'Помощь']], false, user);
          return res.json({ ok: true });
        }

        const myTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && task.status !== 'completed');
        if (cmd.startsWith('/start')) {
          await sendTelegramKeyboard(chatId, `Привет, ${user.realName}! Здесь будут только задачи от команды MEGABATTLE.`, [['Мои задачи', 'Помощь']], false, user);
          saveDatabase(state);
          return res.json({ ok: true });
        }

        if (normalizedText === 'мои задачи' || cmd.startsWith('/tasks')) {
          if (myTasks.length === 0) {
            await sendTelegramKeyboard(chatId, 'Активных задач пока нет.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'faculty_task_pick', taskIds: myTasks.map((task) => task.id) });
          const list = myTasks.map((task, index) => {
            const creator = state.users.find((item) => item.id === task.creatorId);
            return `${index + 1}. ${task.title}\nСтатус: ${taskStatusLabel(task.status)}\nДедлайн: ${formatShortDate(task.deadline)}\nАвтор: ${userMention(creator)}\n${task.description}`;
          }).join('\n\n');
          await sendTelegramKeyboard(chatId, `Твои задачи:\n\n${list}`, [['Установить статус задачи'], ['Мои задачи', 'Помощь']], false, user);
          return res.json({ ok: true });
        }

        if (normalizedText === 'установить статус задачи') {
          if (myTasks.length === 0) {
            await sendTelegramKeyboard(chatId, 'Активных задач пока нет.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'faculty_task_pick', taskIds: myTasks.map((task) => task.id) });
          await sendTelegramKeyboard(chatId, 'Введи порядковый номер задачи из списка.', [['Назад']], false, user);
          return res.json({ ok: true });
        }

        if (session?.flow === 'faculty_task_pick') {
          const index = Number(normalizedText) - 1;
          const selectedTaskId = session.taskIds?.[index];
          const task = state.tasks.find((item) => item.id === selectedTaskId);
          if (!task) {
            await sendTelegramKeyboard(chatId, 'Не нашёл задачу с таким номером. Введи номер ещё раз.', [['Назад']], false, user);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'faculty_task_status', selectedTaskId: task.id });
          await sendTelegramKeyboard(chatId, `Задача: ${task.title}\nВыбери новый статус.`, [['Ждет', 'В работе'], ['Выполнено', 'Назад']], false, user);
          return res.json({ ok: true });
        }

        if (session?.flow === 'faculty_task_status') {
          const selectedStatus = parseFacultyTaskStatus(text);
          if (!selectedStatus) {
            await sendTelegramKeyboard(chatId, 'Выбери статус кнопкой: Ждет, В работе или Выполнено.', [['Ждет', 'В работе'], ['Выполнено', 'Назад']], false, user);
            return res.json({ ok: true });
          }
          const task = state.tasks.find((item) => item.id === session.selectedTaskId);
          if (!task) {
            chatSessions.delete(chatKey);
            await sendTelegramKeyboard(chatId, 'Задача не найдена. Открой список заново.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'faculty_task_confirm', selectedTaskId: task.id, selectedStatus });
          await sendTelegramKeyboard(chatId, `Подтвердить смену статуса?\n\n${task.title}\nНовый статус: ${taskStatusLabel(selectedStatus)}`, [['Подтвердить'], ['Назад']], false, user);
          return res.json({ ok: true });
        }

        if (session?.flow === 'faculty_task_confirm' && normalizedText === 'подтвердить') {
          const task = state.tasks.find((item) => item.id === session.selectedTaskId);
          if (!task || !session.selectedStatus) {
            chatSessions.delete(chatKey);
            await sendTelegramKeyboard(chatId, 'Задача не найдена. Открой список заново.', [['Мои задачи', 'Помощь']], false, user);
            return res.json({ ok: true });
          }
          task.status = session.selectedStatus;
          task.completedAt = session.selectedStatus === 'completed' ? new Date().toISOString() : '';
          const creator = state.users.find((item) => item.id === task.creatorId);
          if (creator?.telegramId) {
            await sendTelegramMessage(creator.telegramId, `Статус задачи изменён.\n\nЗадача: ${task.title}\nИсполнитель: ${userMention(user)}\nСтатус: ${taskStatusLabel(task.status)}`);
          }
          chatSessions.delete(chatKey);
          saveDatabase(state);
          await sendTelegramKeyboard(chatId, `Готово. Статус задачи "${task.title}" теперь: ${taskStatusLabel(task.status)}.`, [['Мои задачи', 'Помощь']], false, user);
          return res.json({ ok: true });
        }

        if (normalizedText === 'помощь' || cmd.startsWith('/help')) {
          await sendTelegramKeyboard(chatId, 'Здесь ты получаешь задачи от организаторов. В «Мои задачи» можно посмотреть дедлайны и поменять статус задачи. Если нужна помощь, напиши автору задачи из карточки.', [['Мои задачи', 'Помощь']], false, user);
          return res.json({ ok: true });
        }

        await sendTelegramKeyboard(chatId, 'Пользуйся кнопками: Мои задачи и Помощь.', [['Мои задачи', 'Помощь']], false, user);
        saveDatabase(state);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_complete_time' && normalizedText !== 'назад') {
        if (normalizedText === 'указать вручную') {
          chatSessions.set(chatKey, { ...session, flow: 'task_complete_custom' });
          await sendTelegramKeyboard(chatId, 'Введи количество минут числом, например 75.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        const presetMinutes: Record<string, number | undefined> = {
          '15 минут': 15,
          '30 минут': 30,
          '1 час': 60,
          '2 часа': 120,
          'не указывать': undefined,
        };
        if (!(normalizedText in presetMinutes)) {
          await sendTelegramKeyboard(chatId, 'Выбери вариант кнопкой или укажи время вручную.', [['15 минут', '30 минут'], ['1 час', '2 часа'], ['Указать вручную'], ['Не указывать', 'Назад']], false, user);
          return res.json({ ok: true });
        }
        const task = state.tasks.find((item) => item.id === session.completionTaskId && assignedIds(item).includes(user.id));
        if (!task) {
          await sendTelegramKeyboard(chatId, 'Задача больше недоступна.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_complete_comment', completionTimeMinutes: presetMinutes[normalizedText] });
        await sendTelegramKeyboard(
          chatId,
          `Оставь короткий комментарий по задаче *«${task.title}»*: что получилось, что тормозило или что важно знать автору.`,
          [['Без комментария'], ['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_complete_custom' && normalizedText !== 'назад') {
        const minutes = Number(normalizedText);
        if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 60000) {
          await sendTelegramKeyboard(chatId, 'Введи количество минут целым числом больше нуля.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        const task = state.tasks.find((item) => item.id === session.completionTaskId && assignedIds(item).includes(user.id));
        if (!task) {
          await sendTelegramKeyboard(chatId, 'Задача больше недоступна.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_complete_comment', completionTimeMinutes: minutes });
        await sendTelegramKeyboard(
          chatId,
          `Оставь короткий комментарий по задаче *«${task.title}»*: что получилось, что тормозило или что важно знать автору.`,
          [['Без комментария'], ['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_complete_comment' && normalizedText !== 'назад') {
        const task = state.tasks.find((item) => item.id === session.completionTaskId && assignedIds(item).includes(user.id));
        if (!task) {
          await sendTelegramKeyboard(chatId, 'Задача больше недоступна.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        const completionComment = normalizedText === 'без комментария' ? '' : text.trim();
        await completeTaskFromChat(state, task, user, session.completionTimeMinutes, completionComment);
        chatSessions.delete(chatKey);
        await showTasksPanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (normalizedText === 'назад' || normalizedText === 'меню') {
        const currentSession = chatSessions.get(chatKey);
        if (normalizedText === 'назад' && currentSession?.flow === 'tasks_root') {
          chatSessions.delete(chatKey);
          await showProfilePanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && (currentSession?.flow === 'tasks_submenu' || currentSession?.flow.startsWith('task_create_') || currentSession?.flow.startsWith('task_complete_'))) {
          await showTasksPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meetings_root') {
          await showProfilePanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'faculties_submenu') {
          await showFacultiesPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'faculties_root') {
          await showProfilePanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'team_submenu') {
          await showTeamPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'team_root') {
          await showProfilePanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow.startsWith('team_')) {
          await showTeamPanel(chatId, user, state);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_enter_description') {
          chatSessions.set(chatKey, { ...currentSession, flow: 'meeting_enter_topic', topic: '' });
          await sendTelegramKeyboard(chatId, 'Напиши тему собрания одним сообщением.', [['Назад']]);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_enter_topic') {
          if (currentSession.meetingKind === 'competency') {
            chatSessions.set(chatKey, { flow: 'meeting_confirm_competency', meetingKind: 'competency', competency: currentSession.competency, participantIds: currentSession.participantIds });
            await sendTelegramKeyboard(chatId, 'Вернулся к подтверждению блока.', [['Подтвердить'], ['Назад']]);
            return res.json({ ok: true });
          }
          chatSessions.set(chatKey, { flow: 'meeting_choose_type' });
          await sendTelegramKeyboard(chatId, 'Какое собрание назначаем?', [['Собрать всю команду'], ['Выбрать блок'], ['Назад']]);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_confirm_competency') {
          const freshState = loadDatabase();
          const competencies = freshState.competencies || [];
          chatSessions.set(chatKey, { flow: 'meeting_pick_competency' });
          await sendTelegramKeyboard(chatId, 'Выбери блок:', [...competencies.map((item) => [item]), ['Назад']]);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_pick_competency') {
          chatSessions.set(chatKey, { flow: 'meeting_choose_type' });
          await sendTelegramKeyboard(chatId, 'Какое собрание назначаем?', [['Собрать всю команду'], ['Выбрать блок'], ['Назад']]);
          return res.json({ ok: true });
        }
        if (normalizedText === 'назад' && currentSession?.flow === 'meeting_choose_type') {
          await sendTelegramKeyboard(chatId, 'Раздел встреч.', [['Назначить собрание'], ['Назад']]);
          chatSessions.delete(chatKey);
          return res.json({ ok: true });
        }
        chatSessions.delete(chatKey);
        await showProfilePanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (normalizedText === 'назначить собрание') {
        chatSessions.set(chatKey, { flow: 'meeting_choose_type' });
        await sendTelegramKeyboard(chatId, 'Какое собрание назначаем?', [['Собрать всю команду'], ['Выбрать блок'], ['Назад']]);
        return res.json({ ok: true });
      }

      if (normalizedText === 'собрать всю команду') {
        if (!user.registered) {
          await sendTelegramKeyboard(chatId, 'Доступ не активирован. Попроси администратора проверить Telegram username в твоём профиле.', [['Профиль'], ['Назад']]);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { flow: 'meeting_enter_topic', meetingKind: 'general', participantIds: [] });
        await sendTelegramKeyboard(chatId, 'Напиши тему собрания одним сообщением.', [['Назад']]);
        return res.json({ ok: true });
      }

      if (normalizedText === 'выбрать блок') {
        const freshState = loadDatabase();
        const competencies = freshState.competencies || [];
        if (competencies.length === 0) {
          await sendTelegramKeyboard(chatId, 'Пока нет ни одного блока. Админ может добавить блоки в разделе «Команда».', [['Назад']]);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { flow: 'meeting_pick_competency' });
        await sendTelegramKeyboard(chatId, 'Выбери блок:', [...competencies.map((item) => [item]), ['Назад']]);
        return res.json({ ok: true });
      }

      
      if (session?.flow === 'meeting_pick_competency') {
        const freshState = loadDatabase();
        const competency = (freshState.competencies || []).find((item) => item.toLowerCase() === normalizedText);
        if (competency) {
          const members = freshState.users.filter((member) => member.competencies?.includes(competency));
          const memberText = members.length
            ? members.map((member) => `• ${userMention(member)}`).join('\n')
            : 'В этом блоке пока никого нет.';
          chatSessions.set(chatKey, { flow: 'meeting_confirm_competency', meetingKind: 'competency', competency, participantIds: members.map((member) => member.id) });
          await sendTelegramKeyboard(chatId, `Выбран блок *${competency}*.\n\nУчастники:\n${memberText}`, [['Подтвердить'], ['Назад']]);
          return res.json({ ok: true });
        }
      }

      if (session?.flow === 'meeting_confirm_competency' && normalizedText === 'подтвердить') {
        const participantIds = session.participantIds || [];
        if (participantIds.length === 0) {
          await sendTelegramKeyboard(chatId, 'В этом блоке нет участников. Выбери другой блок.', [['Выбрать блок'], ['Назад']]);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'meeting_enter_topic' });
        await sendTelegramKeyboard(chatId, 'Напиши тему собрания блока одним сообщением.', [['Назад']]);
        return res.json({ ok: true });
      }

      if (session?.flow === 'meeting_enter_topic') {
        if (!text.trim()) {
          await sendTelegramKeyboard(chatId, 'Тема не должна быть пустой. Напиши тему собрания.', [['Назад']]);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'meeting_enter_description', topic: text.trim() });
        await sendTelegramKeyboard(chatId, 'Теперь напиши описание собрания или нажми «Пропустить».', [['Пропустить'], ['Назад']]);
        return res.json({ ok: true });
      }

      if (session?.flow === 'meeting_enter_description') {
        const freshState = loadDatabase();
        const description = normalizedText === 'пропустить' ? '' : text.trim();
        const topic = session.topic || 'Собрание';
        const isBlockMeeting = session.meetingKind === 'competency';
        const participantIds = session.participantIds || [];
        if (isBlockMeeting && participantIds.length === 0) {
          await sendTelegramKeyboard(chatId, 'В этом блоке нет участников. Выбери другой блок.', [['Выбрать блок'], ['Назад']]);
          return res.json({ ok: true });
        }
        const meeting = await createMeetingAndNotify(freshState, {
          title: isBlockMeeting ? `Собрание блока ${session.competency}` : 'Общее собрание',
          type: isBlockMeeting ? 'custom' : 'general',
          date: nextShortDate(1),
          time: '18:00',
          hostId: user.id,
          participants: isBlockMeeting ? participantIds : 'all',
          topic,
          description,
          competency: isBlockMeeting ? session.competency : '',
        });
        saveDatabase(freshState);
        chatSessions.delete(chatKey);
        await sendTelegramKeyboard(chatId, `Готово, назначил собрание:\n\n${meetingDetailsText(meeting, freshState)}`, [['Назначить собрание'], ['Назад']], true);
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_search') {
        const query = normalizedText.replace(/^@/, '');
        const matches = state.users.filter((member) => (
          !isFacultyUser(member)
          && `${member.realName} ${member.username}`.toLowerCase().includes(query)
        )).slice(0, 10);
        chatSessions.set(chatKey, { flow: 'team_submenu' });
        await sendTelegramKeyboard(
          chatId,
          matches.length
            ? `*Результаты поиска*\n\n${matches.map((member) => `• ${member.realName} · ${member.username} · ${member.primaryCompetency || 'без блока'}`).join('\n')}`
            : 'Никого не нашёл.',
          [['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_add_name') {
        chatSessions.set(chatKey, { ...session, flow: 'team_add_username', draftName: text.trim() });
        await sendTelegramKeyboard(chatId, 'Отправь Telegram username участника в формате @username.', [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_add_username') {
        const username = text.trim().startsWith('@') ? text.trim() : `@${text.trim()}`;
        if (!/^@[a-zA-Z0-9_]{5,}$/.test(username)) {
          await sendTelegramKeyboard(chatId, 'Проверь username. Нужен формат @username.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        if (state.users.some((member) => member.username.toLowerCase() === username.toLowerCase())) {
          await sendTelegramKeyboard(chatId, 'Такой Telegram username уже есть в команде.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'team_add_birthday', draftUsername: username });
        await sendTelegramKeyboard(chatId, 'Введи дату рождения полностью: ДД.ММ.ГГГГ.', [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_add_birthday') {
        const parts = birthdayParts(text.trim());
        if (!parts?.year || parts.year < 1940 || parts.year > new Date().getFullYear()) {
          await sendTelegramKeyboard(chatId, 'Нужна полная дата в формате ДД.ММ.ГГГГ.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'team_add_role', draftBirthday: formatBirthday(text.trim()) });
        await sendTelegramKeyboard(chatId, 'Выбери роль участника.', [['Организатор', 'Администратор'], ['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'team_add_role') {
        const role = normalizedText === 'администратор' ? 'admin' : normalizedText === 'организатор' ? 'organizer' : null;
        if (!role) {
          await sendTelegramKeyboard(chatId, 'Выбери роль кнопкой.', [['Организатор', 'Администратор'], ['Назад']], false, user);
          return res.json({ ok: true });
        }
        const newUser: User = {
          id: `u_${Date.now()}`,
          username: session.draftUsername || '',
          realName: session.draftName || session.draftUsername || 'Участник',
          role,
          avatarSeed: session.draftUsername || String(Date.now()),
          birthday: session.draftBirthday,
          registered: false,
          competencies: [],
          primaryCompetency: '',
          facultyId: '',
          joinedAt: new Date().toISOString(),
          lastSeenAt: '',
        };
        state.users.push(newUser);
        state.messages[newUser.id] = [];
        chatSessions.set(chatKey, { flow: 'team_submenu' });
        saveDatabase(state);
        await sendTelegramKeyboard(chatId, `Участник добавлен:\n\n*${newUser.realName}*\n${newUser.username}\n${formatBirthday(newUser.birthday)}\n${roleLabel(newUser.role)}`, [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_event') {
        const activeEvents = (state.events || []).filter((item) => item.status === 'active');
        const workEvent = activeEvents.find((item) => item.name.toLowerCase() === normalizedText);
        if (!workEvent && normalizedText !== 'без мероприятия') {
          await sendTelegramKeyboard(chatId, 'Выбери мероприятие кнопкой.', [
            ...activeEvents.map((item) => [item.name]),
            ['Без мероприятия'],
            ['Назад'],
          ], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_create_title', taskEventId: workEvent?.id || '' });
        await sendTelegramKeyboard(chatId, 'Напиши название задачи.', [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_title') {
        chatSessions.set(chatKey, { ...session, flow: 'task_create_description', taskTitle: text.trim() });
        await sendTelegramKeyboard(chatId, 'Напиши короткое описание задачи.', [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_description') {
        chatSessions.set(chatKey, { ...session, flow: 'task_create_deadline', taskDescription: text.trim() });
        await sendTelegramKeyboard(chatId, 'Введи дедлайн в формате ДД.ММ.ГГ.', [['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_deadline') {
        if (!parseShortDate(text.trim())) {
          await sendTelegramKeyboard(chatId, 'Не понял дату. Используй формат ДД.ММ.ГГ.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_create_competency', taskDeadline: formatShortDate(text.trim()) });
        await sendTelegramKeyboard(chatId, 'Выбери блок задачи.', [
          ...(state.competencies || []).map((competency) => [competency]),
          ['Без блока'],
          ['Назад'],
        ], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_competency') {
        const competency = normalizedText === 'без блока'
          ? ''
          : (state.competencies || []).find((item) => item.toLowerCase() === normalizedText);
        if (competency === undefined) {
          await sendTelegramKeyboard(chatId, 'Выбери блок кнопкой.', [[...(state.competencies || [])], ['Без блока'], ['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_create_priority', taskCompetency: competency });
        await sendTelegramKeyboard(chatId, 'Выбери приоритет задачи.', [['Обычная', 'Важная'], ['Очень важная'], ['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_priority') {
        const priority = normalizedText === 'обычная'
          ? 'normal'
          : normalizedText === 'важная'
            ? 'important'
            : normalizedText === 'очень важная'
              ? 'critical'
              : null;
        if (!priority) {
          await sendTelegramKeyboard(chatId, 'Выбери приоритет кнопкой.', [['Обычная', 'Важная'], ['Очень важная'], ['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { ...session, flow: 'task_create_scope', taskPriority: priority });
        await sendTelegramKeyboard(chatId, 'Кому назначить задачу?', [['Вся команда', 'Участники блока'], ['Открытая задача'], ['Назад']], false, user);
        return res.json({ ok: true });
      }

      if (session?.flow === 'task_create_scope') {
        const team = state.users.filter((member) => !isFacultyUser(member));
        let assigneeIds: string[] = [];
        if (normalizedText === 'вся команда') assigneeIds = team.map((member) => member.id);
        else if (normalizedText === 'участники блока') {
          assigneeIds = team
            .filter((member) => session.taskCompetency && member.competencies?.includes(session.taskCompetency))
            .map((member) => member.id);
        } else if (normalizedText !== 'открытая задача') {
          await sendTelegramKeyboard(chatId, 'Выбери вариант кнопкой.', [['Вся команда', 'Участники блока'], ['Открытая задача'], ['Назад']], false, user);
          return res.json({ ok: true });
        }
        const task: Task = {
          id: `t_${Date.now()}`,
          title: session.taskTitle || 'Без названия',
          description: session.taskDescription || '',
          deadline: session.taskDeadline || '',
          assignedTo: assigneeIds.length ? assigneeIds : null,
          creatorId: user.id,
          competency: session.taskCompetency || '',
          eventId: session.taskEventId || '',
          sow: '',
          tips: [],
          status: assigneeIds.length ? 'assigned' : 'open',
          priority: session.taskPriority || 'normal',
          createdAt: new Date().toISOString(),
          completedAt: '',
        };
        state.tasks.push(task);
        chatSessions.delete(chatKey);
        for (const target of (assigneeIds.length ? team.filter((member) => assigneeIds.includes(member.id)) : team)) {
          if (target.telegramId && target.id !== user.id) {
            await sendTelegramMessage(
              target.telegramId,
              assigneeIds.length ? `Тебе назначена задача:\n\n${taskDetailsText(task, state)}` : `Новая свободная задача:\n\n${taskDetailsText(task, state)}`,
              [{ text: 'Посмотреть задачу', action: `task_view:${task.id}` }],
              false,
              target,
            );
          }
        }
        saveDatabase(state);
        await sendGroupMessage(chatId, `Задача создана:\n\n${taskDetailsText(task, state)}`);
        await showTasksPanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (cmd.startsWith('/start')) {
        await showWelcomePanel(chatId, user);
        saveDatabase(state);
        return res.json({ ok: true });
      } else if (isRegistrationPrompt(text)) {
        await showProfilePanel(chatId, user, state);
        saveDatabase(state);
        return res.json({ ok: true });
      } else if (cmd.startsWith('/slots') || cmd === 'слоты') {
        await showSlotsPanel(chatId, user, state);
        saveDatabase(state);
        return res.json({ ok: true });
      } else if (isOpenAppText(text)) {
        replyText = 'Открывай приложение кнопкой снизу. Если Telegram не открыл его автоматически, нажми кнопку ещё раз.';
      } else if (cmd.startsWith('/meetings') || cmd === 'встречи') {
        if (!user.registered) {
          await sendTelegramKeyboard(chatId, 'Доступ не активирован. Попроси администратора проверить Telegram username в твоём профиле.', [['Профиль'], ['Назад']]);
          return res.json({ ok: true });
        } else {
          await showMeetingsPanel(chatId, user, state);
          return res.json({ ok: true });
        }
      } else if (cmd.startsWith('/tasks') || cmd === 'задачи') {
        if (!user.registered) {
          replyText = 'Доступ не активирован. Попроси администратора проверить Telegram username в твоём профиле.';
        } else {
          await showTasksPanel(chatId, user, state);
          return res.json({ ok: true });
        }
      } else if (normalizedText === 'свободные задачи') {
        const openTasks = state.tasks.filter((task) => task.status === 'open').slice(0, 10);
        await sendInlinePanel(
          chatId,
          openTasks.length
            ? `*Свободные задачи*\n\n${openTasks.map((task, index) => `${index + 1}. ${task.title} · ${formatShortDate(task.deadline) || 'без даты'}`).join('\n')}`
            : 'Свободных задач сейчас нет.',
          [
            ...openTasks.map((task) => [{ text: task.title.slice(0, 48), callback_data: `task_view:${task.id}` }]),
            [{ text: 'Назад', callback_data: 'nav_tasks' }],
          ],
        );
        return res.json({ ok: true });
      } else if (normalizedText === 'выполненные задачи') {
        const completed = state.tasks
          .filter((task) => assignedIds(task).includes(user.id) && task.status === 'completed')
          .slice(-10)
          .reverse();
        chatSessions.set(chatKey, { flow: 'tasks_submenu' });
        await sendTelegramKeyboard(
          chatId,
          completed.length
            ? `*Последние выполненные задачи*\n\n${completed.map((task) => `• ${task.title}`).join('\n')}`
            : 'Выполненных задач пока нет.',
          [['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      } else if (normalizedText === 'управлять задачами') {
        const myTasks = state.tasks.filter((task) => assignedIds(task).includes(user.id) && task.status !== 'completed').slice(0, 10);
        await sendInlinePanel(
          chatId,
          myTasks.length
            ? `*Управление задачами*\n\n${myTasks.map((task, index) => `${index + 1}. ${task.title} · ${taskStatusLabel(task.status)}`).join('\n')}`
            : 'Активных задач нет.',
          [
            ...myTasks.map((task) => [
              { text: `✓ ${task.title.slice(0, 30)}`, callback_data: `task_complete:${task.id}` },
              { text: 'Отказаться', callback_data: `task_release:${task.id}` },
            ]),
            [{ text: 'Назад', callback_data: 'nav_tasks' }],
          ],
        );
        return res.json({ ok: true });
      } else if (normalizedText === 'создать задачу') {
        const activeEvents = (state.events || []).filter((item) => item.status === 'active');
        if (activeEvents.length) {
          chatSessions.set(chatKey, { flow: 'task_create_event' });
          await sendTelegramKeyboard(chatId, 'Для какого мероприятия создаём задачу?', [
            ...activeEvents.map((item) => [item.name]),
            ['Без мероприятия'],
            ['Назад'],
          ], false, user);
        } else {
          chatSessions.set(chatKey, { flow: 'task_create_title', taskEventId: '' });
          await sendTelegramKeyboard(chatId, 'Напиши название задачи.', [['Назад']], false, user);
        }
        return res.json({ ok: true });
      } else if (cmd === 'команда') {
        await showTeamPanel(chatId, user, state);
        return res.json({ ok: true });
      } else if (normalizedText === 'найти участника') {
        chatSessions.set(chatKey, { flow: 'team_search' });
        await sendTelegramKeyboard(chatId, 'Введи имя, фамилию или Telegram username.', [['Назад']], false, user);
        return res.json({ ok: true });
      } else if (normalizedText === 'добавить участника') {
        if (user.role !== 'admin') {
          await sendTelegramKeyboard(chatId, 'Добавлять участников может только администратор.', [['Назад']], false, user);
          return res.json({ ok: true });
        }
        chatSessions.set(chatKey, { flow: 'team_add_name' });
        await sendTelegramKeyboard(chatId, 'Введи имя и фамилию участника.', [['Назад']], false, user);
        return res.json({ ok: true });
      } else if (cmd === 'мф') {
        await showFacultiesPanel(chatId, user, state);
        return res.json({ ok: true });
      } else if (normalizedText === 'задачи факультетов') {
        const facultyTasks = state.tasks.filter((task) => task.facultyId && task.status !== 'completed').slice(0, 12);
        chatSessions.set(chatKey, { flow: 'faculties_submenu' });
        await sendTelegramKeyboard(
          chatId,
          facultyTasks.length
            ? `*Активные задачи факультетов*\n\n${facultyTasks.map((task) => `• ${task.title} · ${formatShortDate(task.deadline)}`).join('\n')}`
            : 'Активных задач факультетов нет.',
          [['Назад']],
          false,
          user,
        );
        return res.json({ ok: true });
      } else if (cmd.startsWith('/help') || cmd === 'помощь') {
        replyText = '*Что умеет бот*\n\n'
          + '*Профиль* — личная сводка и статистика.\n'
          + '*Слоты* — отметить свободные часы кнопками.\n'
          + '*Встречи* — посмотреть и назначить собрание.\n'
          + '*Задачи* — личные, свободные и выполненные задачи.\n'
          + `${user.role === 'admin' ? '*МФ* — факультеты и их задачи.\n' : ''}`
          + '\nВ командном чате доступны /all, /meeting, /deadlines, /slots, /birthdays и /checkin.';
      } else {
        replyText = 'Выбери раздел кнопкой внизу.';
      }
      state.messages[user.id].push({
        id: 'bot_' + Date.now(),
        userId: user.id,
        sender: 'bot',
        text: replyText,
        timestamp: new Date().toISOString(),
        buttons
      });

      saveDatabase(state);

      await sendTelegramKeyboard(chatId, replyText, buildChatKeyboard(false, user).keyboard.map((row: any[]) => row.map((item) => item.text)), false, user);
    }

    res.json({ ok: true });
  });

  // Add a new user (Team member)
  app.post('/api/user/add', (req, res) => {
    const { requesterId, realName, username, role, birthday } = req.body;
    const state = loadDatabase();

    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Добавлять участников может только админ' });
    }

    if (!realName || !username) {
      return res.status(400).json({ error: 'Имя и Telegram username обязательны' });
    }
    if (birthday && !birthdayParts(birthday)?.year) {
      return res.status(400).json({ error: 'Укажи дату рождения полностью: ДД.ММ.ГГГГ' });
    }

    const sanitizedUsername = username.startsWith('@') ? username : '@' + username;

    // Check if username already exists
    const exists = state.users.some(u => u.username.toLowerCase() === sanitizedUsername.toLowerCase());
    if (exists) {
      return res.status(400).json({ error: 'Пользователь с таким Telegram username уже есть в команде' });
    }

    const newUserId = 'u_' + Date.now();
    const newUser: User = {
      id: newUserId,
      username: sanitizedUsername,
      realName,
      role: role || 'organizer',
      avatarSeed: realName.toLowerCase().replace(/[^a-z]/g, '') || 'user',
      birthday: birthday || '',
      registered: false,
      joinedAt: new Date().toISOString(),
      lastSeenAt: '',
    };

    state.users.push(newUser);

    // Initialize empty message history with a welcome message
    state.messages[newUserId] = [
      {
        id: 'msg_welcome_' + Date.now(),
        userId: newUserId,
        sender: 'bot',
        text: `Привет, ${realName}! Тебя добавили в команду как ${role === 'admin' ? 'админа' : 'организатора'}. Открой Mini App, чтобы отметить свободные слоты.`,
        timestamp: new Date().toISOString()
      }
    ];

    saveDatabase(state);
    res.json({ success: true, user: newUser });
  });

  // Delete a user (Team member)
  app.post('/api/user/delete', (req, res) => {
    const { requesterId, userId } = req.body;
    const state = loadDatabase();

    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Удалять участников может только админ' });
    }

    state.users = state.users.filter(u => u.id !== userId);

    // Clean up their availabilities
    delete state.availabilities[userId];
    delete state.messages[userId];

    saveDatabase(state);
    res.json({ success: true });
  });

  // Update user birthday or details
  app.post('/api/user/update', (req, res) => {
    const { requesterId, userId, realName, username, role, birthday, competencies, primaryCompetency, avatarDataUrl } = req.body;
    const state = loadDatabase();

    const selfEditOnly = requesterId === userId && role === undefined
      && (realName !== undefined || username !== undefined || birthday !== undefined || Array.isArray(competencies) || primaryCompetency !== undefined || avatarDataUrl !== undefined);
    if (!isAdminUser(state, requesterId) && !selfEditOnly) {
      return res.status(403).json({ error: 'Редактировать участников может только админ' });
    }

    const user = state.users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const cleanRealName = String(realName || '').trim();
    if (realName !== undefined && !cleanRealName) {
      return res.status(400).json({ error: 'Имя не должно быть пустым' });
    }
    if (cleanRealName) user.realName = cleanRealName;
    if (username !== undefined) {
      const cleanUsername = String(username || '').trim();
      const sanitizedUsername = cleanUsername.startsWith('@') ? cleanUsername : `@${cleanUsername}`;
      if (!/^@[a-zA-Z0-9_]{5,}$/.test(sanitizedUsername) && sanitizedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(400).json({ error: 'Проверь Telegram username: нужен формат @username' });
      }
      const usernameTaken = state.users.some((member) => member.id !== user.id && member.username.toLowerCase() === sanitizedUsername.toLowerCase());
      if (usernameTaken) return res.status(400).json({ error: 'Такой Telegram username уже используется' });
      user.username = sanitizedUsername;
    }
    if (role !== undefined) {
      if (role !== 'admin' && role !== 'organizer') return res.status(400).json({ error: 'Неизвестная роль участника' });
      user.role = role;
    }
    if (birthday !== undefined) {
      const parsedBirthday = birthdayParts(birthday);
      if (birthday && !parsedBirthday) {
        return res.status(400).json({ error: 'Проверь дату рождения' });
      }
      user.birthday = birthday;
    }
    if (Array.isArray(competencies)) {
      user.competencies = competencies.filter((item: string) => state.competencies?.includes(item));
    }
    if (primaryCompetency !== undefined) {
      const cleanPrimary = String(primaryCompetency || '').trim();
      user.primaryCompetency = state.competencies?.includes(cleanPrimary) ? cleanPrimary : '';
      if (user.primaryCompetency && !user.competencies?.includes(user.primaryCompetency)) {
        user.competencies = [user.primaryCompetency, ...(user.competencies || [])];
      }
    }
    if (avatarDataUrl !== undefined) {
      const cleanAvatar = String(avatarDataUrl || '');
      if (cleanAvatar && (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(cleanAvatar) || cleanAvatar.length > 300_000)) {
        return res.status(400).json({ error: 'Не удалось сохранить аватар: проверь формат изображения' });
      }
      user.avatarDataUrl = cleanAvatar || undefined;
    }

    saveDatabase(state);
    res.json({ success: true, user });
  });

  app.post('/api/competency/add', (req, res) => {
    const { requesterId, name } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Компетенции может менять только админ' });
    }
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Название блока обязательно' });
    if (!state.competencies) state.competencies = [];
    if (!state.competencies.some((item) => item.toLowerCase() === cleanName.toLowerCase())) {
      state.competencies.push(cleanName);
    }
    saveDatabase(state);
    refreshGroupCommandMenus();
    res.json({ success: true, competencies: state.competencies });
  });

  app.post('/api/competency/delete', (req, res) => {
    const { requesterId, name } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Компетенции может менять только админ' });
    }
    const cleanName = String(name || '').trim();
    state.competencies = (state.competencies || []).filter((item) => item !== cleanName);
    state.users.forEach((user) => {
      user.competencies = (user.competencies || []).filter((item) => item !== cleanName);
      if (user.primaryCompetency === cleanName) user.primaryCompetency = '';
    });
    saveDatabase(state);
    refreshGroupCommandMenus();
    res.json({ success: true, competencies: state.competencies });
  });

  app.post('/api/faculty/competency/add', (req, res) => {
    const { requesterId, name } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Компетенции факультетов может менять только админ' });
    }
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Название компетенции обязательно' });
    if (!state.facultyCompetencies) state.facultyCompetencies = [];
    if (!state.facultyCompetencies.some((item) => item.toLowerCase() === cleanName.toLowerCase())) {
      state.facultyCompetencies.push(cleanName);
    }
    saveDatabase(state);
    res.json({ success: true, facultyCompetencies: state.facultyCompetencies });
  });

  app.post('/api/faculty/competency/delete', (req, res) => {
    const { requesterId, name } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Компетенции факультетов может менять только админ' });
    }
    const cleanName = String(name || '').trim();
    state.facultyCompetencies = (state.facultyCompetencies || []).filter((item) => item !== cleanName);
    state.users.forEach((user) => {
      if (!isFacultyUser(user)) return;
      user.competencies = (user.competencies || []).filter((item) => item !== cleanName);
      if (user.primaryCompetency === cleanName) user.primaryCompetency = '';
    });
    saveDatabase(state);
    res.json({ success: true, facultyCompetencies: state.facultyCompetencies });
  });

  app.post('/api/faculty/user/add', (req, res) => {
    const { requesterId, realName, username, role, facultyId, competencies } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Добавлять ответственных может только админ' });
    }
    if (!realName || !username || !facultyId || !['faculty_responsible', 'faculty_helper'].includes(role)) {
      return res.status(400).json({ error: 'Заполни имя, Telegram, факультет и роль' });
    }
    const cleanCompetencies = Array.isArray(competencies)
      ? competencies.filter((item: string) => state.facultyCompetencies?.includes(item))
      : [];
    const sanitizedUsername = username.startsWith('@') ? username : '@' + username;
    let user = state.users.find((u) => u.username.toLowerCase() === sanitizedUsername.toLowerCase());
    if (user) {
      user.realName = realName;
      user.role = role;
      user.facultyId = facultyId;
      user.registered = Boolean(user.telegramId);
      user.competencies = cleanCompetencies;
      user.primaryCompetency = user.competencies[0] || '';
    } else {
      user = {
        id: 'u_' + Date.now(),
        username: sanitizedUsername,
        realName,
        role,
        facultyId,
        avatarSeed: sanitizedUsername.toLowerCase(),
        birthday: '',
        registered: false,
        competencies: cleanCompetencies,
        primaryCompetency: cleanCompetencies[0] || '',
        joinedAt: new Date().toISOString(),
        lastSeenAt: '',
      };
      state.users.push(user);
      state.messages[user.id] = [];
    }
    saveDatabase(state);
    res.json({ success: true, user });
  });

  app.post('/api/faculty/user/update', (req, res) => {
    const { requesterId, userId, realName, username, role, facultyId, competencies } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать ответственных может только админ' });
    }
    const user = state.users.find((u) => u.id === userId);
    if (!user || !isFacultyUser(user)) return res.status(404).json({ error: 'Ответственный не найден' });
    if (!realName || !username || !facultyId || !['faculty_responsible', 'faculty_helper'].includes(role)) {
      return res.status(400).json({ error: 'Заполни имя, Telegram, факультет и роль' });
    }
    const sanitizedUsername = username.startsWith('@') ? username : '@' + username;
    const duplicate = state.users.find((u) => u.id !== userId && u.username.toLowerCase() === sanitizedUsername.toLowerCase());
    if (duplicate) {
      return res.status(400).json({ error: 'Пользователь с таким Telegram username уже есть' });
    }
    const cleanCompetencies = Array.isArray(competencies)
      ? competencies.filter((item: string) => state.facultyCompetencies?.includes(item))
      : [];
    user.realName = realName;
    user.username = sanitizedUsername;
    user.role = role;
    user.facultyId = facultyId;
    user.competencies = cleanCompetencies;
    user.primaryCompetency = user.competencies[0] || '';
    saveDatabase(state);
    res.json({ success: true, user });
  });

  app.post('/api/faculty/user/delete', (req, res) => {
    const { requesterId, userId } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Удалять ответственных может только админ' });
    }
    const user = state.users.find((u) => u.id === userId);
    if (!user || !isFacultyUser(user)) return res.status(404).json({ error: 'Ответственный не найден' });
    state.users = state.users.filter((u) => u.id !== userId);
    state.tasks.forEach((task) => {
      const ids = assignedIds(task).filter((id) => id !== userId);
      task.assignedTo = ids.length === 0 ? null : ids;
    });
    saveDatabase(state);
    res.json({ success: true });
  });

  app.post('/api/faculty/task/create', async (req, res) => {
    const { requesterId, facultyId, title, description, deadline, assignedTo, reminders, competency, eventId } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId) && !state.users.some((u) => u.id === requesterId && u.role === 'organizer')) {
      return res.status(403).json({ error: 'Создавать задачи факультетам могут только мегаорги' });
    }
    const assigneeIds = Array.isArray(assignedTo)
      ? [...new Set(assignedTo.filter(Boolean))]
          .filter((id) => state.users.some((user) => user.id === id && isFacultyUser(user)))
      : [];
    if (!facultyId || !title || !description || !deadline || assigneeIds.length === 0) {
      return res.status(400).json({ error: 'Заполни факультет, название, описание, дедлайн и исполнителей' });
    }
    const cleanEventId = String(eventId || '').trim();
    if (cleanEventId && !state.events?.some((item) => item.id === cleanEventId && item.status === 'active')) {
      return res.status(400).json({ error: 'Выбранное мероприятие не найдено или уже завершено' });
    }
    const cleanReminders: TaskReminder[] = Array.isArray(reminders)
      ? reminders.filter((item: any) => Number(item.value) > 0).slice(0, 3).map((item: any, index: number) => ({
          id: 'rem_' + Date.now() + '_' + index,
          type: item.type === 'repeat' ? 'repeat' : 'before_deadline',
          value: Math.max(1, Number(item.value) || 1),
          unit: item.unit === 'hours' ? 'hours' : 'days',
        }))
      : [];
    const task: Task = {
      id: 't_' + Date.now(),
      title,
      description,
      deadline,
      assignedTo: assigneeIds,
      creatorId: requesterId,
      facultyId,
      eventId: cleanEventId,
      competency: String(competency || '').trim() || 'Факультет',
      sow: '',
      tips: [],
      status: 'waiting',
      priority: 'normal',
      createdAt: new Date().toISOString(),
      completedAt: '',
      reminders: cleanReminders,
    };
    state.tasks.push(task);
    for (const id of assigneeIds) {
      const target = state.users.find((u) => u.id === id);
      if (!target) continue;
      const text = `Новая задача от MEGABATTLE:\n\n${taskDetailsText(task, state)}\n\nЧтобы поменять статус, нажми «Мои задачи».`;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      state.messages[target.id].push({
        id: `faculty_task_created_${Date.now()}_${target.id}`,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
      });
      if (target?.telegramId) {
        await sendTelegramMessage(target.telegramId, text, undefined, false, target);
      }
    }
    saveDatabase(state);
    res.json({ success: true, task });
  });

  app.post('/api/faculty/task/update', async (req, res) => {
    const { requesterId, taskId, title, description, deadline, assignedTo, reminders, facultyId, competency, eventId } = req.body;
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (task.creatorId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать задачу может автор или админ' });
    }
    const previousAssigneeIds = new Set(assignedIds(task));
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (deadline !== undefined) task.deadline = deadline;
    if (facultyId !== undefined) task.facultyId = facultyId;
    if (competency !== undefined) task.competency = String(competency || '').trim() || 'Факультет';
    if (eventId !== undefined) {
      const cleanEventId = String(eventId || '').trim();
      if (cleanEventId && !state.events?.some((item) => item.id === cleanEventId)) return res.status(400).json({ error: 'Мероприятие не найдено' });
      task.eventId = cleanEventId;
    }
    if (Array.isArray(assignedTo)) {
      const assigneeIds = [...new Set(assignedTo.filter(Boolean))]
        .filter((id) => state.users.some((user) => user.id === id && isFacultyUser(user)));
      task.assignedTo = assigneeIds.length ? assigneeIds : null;
    }
    if (Array.isArray(reminders)) {
      task.reminders = reminders.filter((item: any) => Number(item.value) > 0).slice(0, 3).map((item: any, index: number) => ({
        id: item.id || 'rem_' + Date.now() + '_' + index,
        type: item.type === 'repeat' ? 'repeat' : 'before_deadline',
        value: Math.max(1, Number(item.value) || 1),
        unit: item.unit === 'hours' ? 'hours' : 'days',
        sentAt: item.sentAt,
        lastSentAt: item.lastSentAt,
      }));
    }
    const currentAssigneeIds = new Set(assignedIds(task));
    const notificationIds = new Set([...previousAssigneeIds, ...currentAssigneeIds]);
    for (const id of notificationIds) {
      const target = state.users.find((user) => user.id === id);
      if (!target) continue;
      const text = currentAssigneeIds.has(id)
        ? `Задача обновлена.\n\n${taskDetailsText(task, state)}`
        : `Назначение снято.\n\nВы больше не исполнитель задачи «${task.title}».`;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      state.messages[target.id].push({
        id: `faculty_task_updated_${Date.now()}_${target.id}`,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
      });
      if (target.telegramId) {
        await sendTelegramMessage(target.telegramId, text, undefined, false, target);
      }
    }
    saveDatabase(state);
    res.json({ success: true, task });
  });

  app.post('/api/availability/weeks', async (req, res) => {
    const { requesterId, weeks, activeDays, startHour, endHour, notifyTeam = false } = req.body || {};
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Admin access required' });
    const weekCount = Number(weeks);
    if (!Number.isInteger(weekCount) || weekCount < 2 || weekCount > 5) {
      return res.status(400).json({ error: 'Количество недель должно быть от 2 до 5' });
    }
    const requestedActiveDays = Array.isArray(activeDays)
      ? [...new Set(activeDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
      : normalizeAvailabilityConfig(state.settings).activeDays;
    const requestedStartHour = Number(startHour ?? normalizeAvailabilityConfig(state.settings).startHour);
    const requestedEndHour = Number(endHour ?? normalizeAvailabilityConfig(state.settings).endHour);
    if (!requestedActiveDays.length) return res.status(400).json({ error: 'Выбери хотя бы один день недели' });
    if (!Number.isInteger(requestedStartHour) || !Number.isInteger(requestedEndHour)
      || requestedStartHour < 0 || requestedEndHour > 23 || requestedEndHour < requestedStartHour) {
      return res.status(400).json({ error: 'Проверь диапазон времени: начало и конец должны быть от 00:00 до 23:00' });
    }
    state.settings = {
      ...(state.settings || {}),
      availabilityWeekCount: weekCount,
      availabilityActiveDays: requestedActiveDays,
      availabilityStartHour: requestedStartHour,
      availabilityEndHour: requestedEndHour,
    };
    saveDatabase(state);
    chatSlotDrafts.clear();
    persistChatPanelMessageIds();
    let googleSheetsWeeks: unknown = null;
    if (sheetsConfig) {
      try {
        googleSheetsWeeks = await ensurePrimaryWeekSheet(sheetsConfig, state.users, state.settings);
        await exportAvailabilitiesToSheet(sheetsConfig, state.users, state.availabilities);
      }
      catch (error: any) {
        console.error('Google Sheets primary week update failed:', error);
        return res.status(502).json({ error: error.message || 'Не удалось обновить текущую неделю на листе ОСНОВА' });
      }
    }
    let notified = 0;
    if (notifyTeam) {
      const weekWord = weekCount >= 5 ? 'недель' : 'недели';
      const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
      const text = `Пожалуйста, заполните свободные слоты на ${weekCount} ${weekWord} вперёд в Mini App.`
        + `\nДни: ${requestedActiveDays.map((day) => dayNames[day]).join(', ')}.`
        + `\nВремя: ${String(requestedStartHour).padStart(2, '0')}:00–${String(requestedEndHour).padStart(2, '0')}:00.`;
      const recipients = state.users.filter((user) => !isFacultyUser(user) && user.registered && user.telegramId);
      recipients.forEach((user) => {
        if (!state.messages[user.id]) state.messages[user.id] = [];
        state.messages[user.id].push({
          id: `availability_horizon_${Date.now()}_${user.id}`,
          userId: user.id,
          sender: 'bot',
          text,
          timestamp: new Date().toISOString(),
          buttons: [{ text: 'Заполнить слоты', action: 'open_tma' }],
        });
      });
      saveDatabase(state);
      const results = await Promise.allSettled(recipients.map((user) => sendTelegramMessage(user.telegramId!, text, [{ text: 'Заполнить слоты', action: 'open_tma' }], false, user)));
      notified = results.filter((result) => result.status === 'fulfilled' && result.value).length;
    }
    return res.json({ success: true, weeks: weekCount, activeDays: requestedActiveDays, startHour: requestedStartHour, endHour: requestedEndHour, notified, googleSheets: googleSheetsWeeks });
  });

  app.post('/api/event/create', (req, res) => {
    const { requesterId, name, description, startsAt, endsAt } = req.body || {};
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Добавлять мероприятия может только администратор' });
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Укажи название мероприятия' });
    if (state.events?.some((item) => item.status === 'active' && item.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(409).json({ error: 'Активное мероприятие с таким названием уже существует' });
    }
    const workEvent: WorkEvent = {
      id: `event_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      name: cleanName,
      description: String(description || '').trim(),
      startsAt: String(startsAt || '').trim(),
      endsAt: String(endsAt || '').trim(),
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: requesterId,
    };
    state.events = [...(state.events || []), workEvent];
    saveDatabase(state);
    return res.json({ success: true, event: workEvent });
  });

  app.post('/api/event/update', (req, res) => {
    const { requesterId, eventId, name, description, startsAt, endsAt, status } = req.body || {};
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Изменять мероприятия может только администратор' });
    const workEvent = state.events?.find((item) => item.id === eventId);
    if (!workEvent) return res.status(404).json({ error: 'Мероприятие не найдено' });
    const nextName = name === undefined ? workEvent.name : String(name || '').trim();
    const nextStatus = status === undefined ? workEvent.status : status;
    if (nextStatus === 'active' && state.events?.some((item) => item.id !== eventId && item.status === 'active' && item.name.toLowerCase() === nextName.toLowerCase())) {
      return res.status(409).json({ error: 'Активное мероприятие с таким названием уже существует' });
    }
    if (name !== undefined) {
      if (!nextName) return res.status(400).json({ error: 'Название мероприятия не может быть пустым' });
      workEvent.name = nextName;
    }
    if (description !== undefined) workEvent.description = String(description || '').trim();
    if (startsAt !== undefined) workEvent.startsAt = String(startsAt || '').trim();
    if (endsAt !== undefined) workEvent.endsAt = String(endsAt || '').trim();
    if (status !== undefined) {
      if (status !== 'active' && status !== 'archived') return res.status(400).json({ error: 'Неизвестный статус мероприятия' });
      workEvent.status = status;
    }
    saveDatabase(state);
    return res.json({ success: true, event: workEvent });
  });

  // Save/Update User Availability
  app.post('/api/availability', async (req, res) => {
    const { userId, slots, weekStart, hardUnavailableDays } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, userId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    const cleanSlots = filterSlotsByAvailabilityConfig(slots && typeof slots === 'object' ? slots : {}, state.settings);
    state.availabilities[userId] = {
      userId,
      slots: cleanSlots,
      hardUnavailableDays: Array.isArray(hardUnavailableDays)
        ? [...new Set(hardUnavailableDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day < 35))]
        : [],
      weekStart: String(weekStart || ''),
      updatedAt: new Date().toISOString()
    };

    saveDatabase(state);
    let googleSheets: { synced: boolean; error?: string; updatedCells?: number } = { synced: false };
    if (sheetsConfig) {
      try {
        const result = await exportAvailabilityToSheet(sheetsConfig, state.users, state.availabilities[userId]);
        pendingSheetAvailabilityExports.delete(userId);
        persistChatPanelMessageIds();
        googleSheets = { synced: true, updatedCells: result.updatedCells };
      } catch (error: any) {
        console.error('Google Sheets availability export failed:', error);
        pendingSheetAvailabilityExports.add(userId);
        persistChatPanelMessageIds();
        googleSheets = { synced: false, error: error.message || 'Google Sheets export failed' };
      }
    }
    res.json({ success: true, availability: state.availabilities[userId], googleSheets });
  });

  // Schedule a new meeting
  app.post('/api/meeting', async (req, res) => {
    const { title, type, date, time, duration, hostId, participants, topic, description, competency } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, hostId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }
    if (!String(title || '').trim()) return res.status(400).json({ error: 'Укажи название собрания' });
    if (!parseShortDate(String(date || ''))) return res.status(400).json({ error: 'Укажи корректную дату собрания' });
    if (!/^\d{1,2}:\d{2}$/.test(String(time || ''))) return res.status(400).json({ error: 'Укажи время собрания' });
    const cleanDuration = Number(duration || 1);
    if (!Number.isFinite(cleanDuration) || cleanDuration < 0.5 || cleanDuration > 6) {
      return res.status(400).json({ error: 'Длительность собрания должна быть от 30 минут до 6 часов' });
    }
    const scheduleError = meetingScheduleError(String(date), String(time), cleanDuration, state.settings);
    if (scheduleError) return res.status(400).json({ error: scheduleError });

    const cleanParticipants = participants === 'all'
      ? 'all'
      : [...new Set(Array.isArray(participants) ? participants : [])]
          .filter((id) => state.users.some((user) => user.id === id && !isFacultyUser(user)));
    if (type !== 'general' && cleanParticipants !== 'all' && cleanParticipants.length === 0) {
      return res.status(400).json({ error: 'Выбери хотя бы одного участника собрания' });
    }
    const newMeeting = await createMeetingAndNotify(state, {
      title,
      type,
      date,
      time,
      duration: cleanDuration,
      hostId,
      participants: cleanParticipants,
      topic,
      description,
      competency,
    });

    saveDatabase(state);
    res.json({ success: true, meeting: newMeeting });
  });

  app.post('/api/meeting/update', async (req, res) => {
    const { requesterId, meetingId, title, type, date, time, duration, participants, topic, description, competency } = req.body;
    const state = loadDatabase();
    const meeting = state.meetings.find(m => m.id === meetingId);

    if (!meeting) return res.status(404).json({ error: 'Встреча не найдена' });
    if (meeting.hostId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать встречу может автор или админ' });
    }

    const previousRecipientIds = meetingRecipientIds(state, meeting.participants, meeting.hostId);
    const nextDuration = duration === undefined ? meeting.duration : Number(duration);
    const nextDate = String(date || meeting.date);
    const nextTime = String(time || meeting.time);
    if (!Number.isFinite(nextDuration) || nextDuration < 0.5 || nextDuration > 6) {
      return res.status(400).json({ error: 'Длительность собрания должна быть от 30 минут до 6 часов' });
    }
    const scheduleError = meetingScheduleError(nextDate, nextTime, nextDuration, state.settings);
    if (scheduleError) return res.status(400).json({ error: scheduleError });
    if (title) meeting.title = title;
    if (type) meeting.type = type;
    if (date) meeting.date = date;
    if (time) meeting.time = time;
    if (duration !== undefined) {
      meeting.duration = nextDuration;
    }
    if (participants !== undefined) {
      meeting.participants = participants === 'all'
        ? 'all'
        : [...new Set(Array.isArray(participants) ? participants : [])]
            .filter((id) => state.users.some((user) => user.id === id && !isFacultyUser(user)));
    }
    meeting.topic = topic || '';
    meeting.description = description || '';
    meeting.competency = competency || '';

    const recipients = meetingRecipientIds(state, meeting.participants, meeting.hostId);
    previousRecipientIds.forEach((id) => recipients.add(id));
    await notifyMeetingRecipients(
      state,
      recipients,
      `Встреча изменена.\n\n${meetingDetailsText(meeting, state)}\n\nПроверьте обновлённые дату, время и состав участников.`,
      'meeting_updated',
    );
    await syncMeetingCalendar(state, meeting);
    saveDatabase(state);
    res.json({ success: true, meeting });
  });

  app.post('/api/meeting/delete', async (req, res) => {
    const { requesterId, meetingId } = req.body;
    const state = loadDatabase();
    const meeting = state.meetings.find(m => m.id === meetingId);

    if (!meeting) return res.status(404).json({ error: 'Встреча не найдена' });
    if (meeting.hostId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Удалить встречу может автор или админ' });
    }

    const recipients = meetingRecipientIds(state, meeting.participants, meeting.hostId);
    meeting.status = 'cancelled';
    await notifyMeetingRecipients(
      state,
      recipients,
      `Встреча отменена.\n\n${meeting.title}\nДата: ${formatShortDate(meeting.date)}\nВремя: ${meeting.time}`,
      'meeting_cancelled',
    );
    await syncMeetingCalendar(state, meeting);
    saveDatabase(state);
    res.json({ success: true, meeting });
  });

  app.post('/api/meeting/rsvp', async (req, res) => {
    const { requesterId, meetingId, attending = true } = req.body || {};
    const state = loadDatabase();
    const requester = state.users.find((user) => user.id === requesterId && user.registered && !isFacultyUser(user));
    if (!requester) return res.status(403).json({ error: 'Нет доступа к собранию' });
    const meeting = state.meetings.find((item) => item.id === meetingId && item.status === 'scheduled');
    if (!meeting) return res.status(404).json({ error: 'Собрание не найдено' });

    const result = updateMeetingAttendance(meeting, requester.id, Boolean(attending));
    if (result.changed) await syncMeetingCalendar(state, meeting);
    saveDatabase(state);
    if (result.changed && result.attending && meeting.hostId !== requester.id) {
      const host = state.users.find((user) => user.id === meeting.hostId);
      if (host?.telegramId) {
        void sendTelegramMessage(host.telegramId, `${userMention(requester)} присоединится к собранию «${meeting.title}».`, undefined, false, host);
      }
    }
    return res.json({ success: true, meeting, attending: result.attending });
  });

  // Create a new task
  app.post('/api/task/create', async (req, res) => {
    const { title, description, deadline, assignedTo, sow, tips, priority, creatorId, competency, competencies, reminders, eventId } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, creatorId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    const cleanPriority: Task['priority'] = ['normal', 'important', 'critical'].includes(priority) ? priority : 'normal';
    const cleanEventId = String(eventId || '').trim();
    if (cleanEventId && !state.events?.some((item) => item.id === cleanEventId && item.status === 'active')) {
      return res.status(400).json({ error: 'Выбранное мероприятие не найдено или уже завершено' });
    }
    const requestedAssigneeIds = Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : assignedTo ? [assignedTo] : [];
    const assigneeIds = [...new Set(requestedAssigneeIds)]
      .filter((id) => state.users.some((user) => user.id === id && !isFacultyUser(user)));
    const now = new Date().toISOString();
    const cleanCompetencies = [...new Set((Array.isArray(competencies) ? competencies : competency ? [competency] : [])
      .map(String).filter((name) => state.competencies?.includes(name)))];
    const newTask: Task = {
      id: 't_' + Date.now(),
      title: String(title || '').trim() || 'Без названия',
      description: String(description || '').trim(),
      deadline: String(deadline || '').trim(),
      assignedTo: assigneeIds.length === 0 ? null : assigneeIds,
      creatorId,
      competency: cleanCompetencies[0] || '',
      competencies: cleanCompetencies,
      eventId: cleanEventId,
      sow: sow || '',
      tips: tips || [],
      status: assigneeIds.length ? 'assigned' : 'open',
      priority: cleanPriority,
      createdAt: now,
      completedAt: '',
      reminders: normalizeTaskReminders(reminders),
      assigneeNotes: {},
      completionComments: {},
    };

    state.tasks.push(newTask);
    const sendJobs: Promise<boolean>[] = [];

    // If assigned to someone, notify them
    if (assigneeIds.length) {
      for (const assignedToId of assigneeIds) {
      const assignedUser = state.users.find(u => u.id === assignedToId);
      if (assignedUser) {
        if (!state.messages[assignedToId]) state.messages[assignedToId] = [];
        state.messages[assignedToId].push({
          id: 'task_notify_' + Date.now(),
          userId: assignedToId,
          sender: 'bot',
          text: `Тебе назначена новая задача!\n\n${taskDetailsText(newTask, state)}`,
          timestamp: new Date().toISOString(),
          buttons: [{ text: 'Открыть задачи', action: 'open_tasks' }]
        });
        if (assignedUser.telegramId) {
          sendJobs.push(sendTelegramMessage(
            assignedUser.telegramId,
            `Тебе назначена новая задача!\n\n${taskDetailsText(newTask, state)}`,
            [{ text: 'Открыть задачи', action: 'open_tasks' }],
          ));
        }
      }
      }
    } else {
      // General notification about a new public task
      for (const u of state.users) {
        if (!state.messages[u.id]) state.messages[u.id] = [];
        state.messages[u.id].push({
          id: 'task_open_notify_' + Date.now() + '_' + u.id,
          userId: u.id,
          sender: 'bot',
          text: `Клич о помощи: на доске появилась свободная задача.\n\n${taskDetailsText(newTask, state)}`,
          timestamp: new Date().toISOString(),
          buttons: [{ text: 'Посмотреть задачу', action: `task_view:${newTask.id}` }]
        });
        if (u.telegramId) {
          sendJobs.push(sendTelegramMessage(
            u.telegramId,
            `Клич о помощи: на доске появилась свободная задача.\n\n${taskDetailsText(newTask, state)}`,
            [{ text: 'Посмотреть задачу', action: `task_view:${newTask.id}` }],
          ));
        }
      }
    }

    await Promise.allSettled(sendJobs);
    saveDatabase(state);
    res.json({ success: true, task: newTask });
  });

  app.post('/api/task/update', async (req, res) => {
    const { requesterId, taskId, title, description, deadline, assignedTo, sow, priority, competency, competencies, reminders, eventId } = req.body || {};
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (task.creatorId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать задачу может автор или администратор' });
    }

    const previousAssignees = new Set(assignedIds(task));
    if (title !== undefined) task.title = String(title || '').trim() || 'Без названия';
    if (description !== undefined) task.description = String(description || '').trim();
    if (deadline !== undefined) task.deadline = String(deadline || '').trim();
    if (competency !== undefined) task.competency = String(competency || '').trim();
    if (competencies !== undefined) {
      task.competencies = [...new Set((Array.isArray(competencies) ? competencies : []).map(String).filter((name) => state.competencies?.includes(name)))];
      task.competency = task.competencies[0] || '';
    }
    if (eventId !== undefined) {
      const cleanEventId = String(eventId || '').trim();
      if (cleanEventId && !state.events?.some((item) => item.id === cleanEventId)) {
        return res.status(400).json({ error: 'Мероприятие не найдено' });
      }
      task.eventId = cleanEventId;
    }
    if (sow !== undefined) task.sow = String(sow || '').trim();
    if (priority !== undefined && ['normal', 'important', 'critical'].includes(priority)) task.priority = priority;
    if (reminders !== undefined) task.reminders = normalizeTaskReminders(reminders);
    if (assignedTo !== undefined) {
      const cleanAssignees = [...new Set(Array.isArray(assignedTo) ? assignedTo : assignedTo ? [assignedTo] : [])]
        .filter((id) => state.users.some((user) => user.id === id && !isFacultyUser(user)));
      task.assignedTo = cleanAssignees.length ? cleanAssignees : null;
      if (task.status !== 'completed') task.status = cleanAssignees.length ? 'assigned' : 'open';
    }

    const currentAssignees = new Set(assignedIds(task));
    const notificationTargets = new Set([...previousAssignees, ...currentAssignees]);
    const sendJobs: Promise<boolean>[] = [];
    for (const id of notificationTargets) {
      const target = state.users.find((user) => user.id === id);
      if (!target) continue;
      const text = currentAssignees.has(id)
        ? `Задача обновлена.\n\n${taskDetailsText(task, state)}`
        : `Назначение снято.\n\nВы больше не исполнитель задачи «${task.title}».`;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      state.messages[target.id].push({
        id: `task_updated_${Date.now()}_${target.id}`,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
        buttons: currentAssignees.has(id) ? [{ text: 'Открыть задачи', action: 'open_tasks' }] : undefined,
      });
      if (target.telegramId) sendJobs.push(sendTelegramMessage(target.telegramId, text, currentAssignees.has(id) ? [{ text: 'Открыть задачи', action: 'open_tasks' }] : undefined, false, target));
    }
    saveDatabase(state);
    await Promise.allSettled(sendJobs);
    res.json({ success: true, task });
  });

  app.post('/api/task/comment', (req, res) => {
    const { requesterId, taskId, assigneeId, side, text } = req.body || {};
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    const requester = state.users.find((user) => user.id === requesterId && user.registered);
    if (!task) return res.status(404).json({ error: 'Задача не найдена. Обнови страницу и попробуй снова.' });
    if (!requester) return res.status(403).json({ error: 'Пользователь не найден или доступ ещё не активирован' });
    if (task.status === 'completed') return res.status(409).json({ error: 'Выполненная задача доступна только для просмотра. Сначала верни её в работу.' });
    if (side !== 'coordinator' && side !== 'executor') return res.status(400).json({ error: 'Неизвестный тип комментария' });
    const targetAssigneeId = side === 'executor' ? requester.id : String(assigneeId || '');
    if (!assignedIds(task).includes(targetAssigneeId)) return res.status(400).json({ error: 'Исполнитель больше не назначен на эту задачу. Обнови страницу.' });
    const isCoordinator = task.creatorId === requester.id || requester.role === 'admin';
    const isExecutor = targetAssigneeId === requester.id;
    if ((side === 'coordinator' && !isCoordinator) || (side === 'executor' && !isExecutor)) {
      return res.status(403).json({ error: 'Нет доступа к этому комментарию' });
    }
    task.assigneeNotes = task.assigneeNotes || {};
    task.assigneeNotes[targetAssigneeId] = {
      ...(task.assigneeNotes[targetAssigneeId] || {}),
      [side]: String(text || '').trim().slice(0, 2_000),
      updatedAt: new Date().toISOString(),
    };
    saveDatabase(state);
    return res.json({ success: true, task });
  });

  app.post('/api/team/broadcast', async (req, res) => {
    const { requesterId, recipientMode, competencies, recipientIds, title, body } = req.body || {};
    const state = loadDatabase();
    const author = state.users.find((user) => user.id === requesterId && user.registered && !isFacultyUser(user));
    if (!author) return res.status(403).json({ error: 'Рассылки доступны участникам основной команды' });
    const cleanBody = String(body || '').trim().slice(0, 4_000);
    const cleanTitle = String(title || '').trim().slice(0, 120);
    if (!cleanBody) return res.status(400).json({ error: 'Текст рассылки обязателен' });
    if (!['all', 'blocks', 'people'].includes(recipientMode)) return res.status(400).json({ error: 'Выбери получателей рассылки' });

    const teamUsers = state.users.filter((user) => !isFacultyUser(user));
    const cleanCompetencies = [...new Set((Array.isArray(competencies) ? competencies : []).map(String).filter((name) => state.competencies?.includes(name)))];
    const requestedIds = new Set((Array.isArray(recipientIds) ? recipientIds : []).map(String));
    let recipients: User[] = [];
    if (recipientMode === 'all') recipients = teamUsers;
    if (recipientMode === 'blocks') {
      if (!cleanCompetencies.length) return res.status(400).json({ error: 'Выбери хотя бы один блок получателей' });
      recipients = teamUsers.filter((user) => cleanCompetencies.some((name) => user.primaryCompetency === name || user.competencies?.includes(name)) || requestedIds.has(user.id));
    }
    if (recipientMode === 'people') recipients = teamUsers.filter((user) => requestedIds.has(user.id));
    recipients = [...new Map(recipients.map((user) => [user.id, user])).values()];
    if (!recipients.length) return res.status(400).json({ error: 'Не найдено ни одного доступного получателя' });

    const sendableRecipients = recipients.filter((recipient) => recipient.telegramId);
    const unavailable = recipients.length - sendableRecipients.length;
    if (!sendableRecipients.length) {
      return res.status(409).json({
        error: 'Никому не удалось отправить сообщение: выбранные участники ещё не открывали MegaBot через /start.',
        recipients: recipients.length,
        delivered: 0,
        unavailable,
        failed: 0,
      });
    }

    const authorName = author.realName || author.username || 'Участник команды';
    const authorUsername = author.username ? ` (${author.username.startsWith('@') ? author.username : `@${author.username}`})` : '';
    const messageText = `${cleanTitle ? `*${cleanTitle}*\n\n` : ''}${cleanBody}\n\n*Автор:* ${authorName}${authorUsername}`;
    const timestamp = new Date().toISOString();
    const sendJobs: Promise<boolean>[] = [];
    for (const recipient of recipients) {
      if (!state.messages[recipient.id]) state.messages[recipient.id] = [];
      state.messages[recipient.id].push({
        id: `team_broadcast_${Date.now()}_${recipient.id}`,
        userId: recipient.id,
        sender: 'bot',
        text: messageText,
        timestamp,
        buttons: [{ text: 'Открыть Mini App', action: 'open_tma' }],
      });
      if (recipient.telegramId) sendJobs.push(sendTelegramMessage(recipient.telegramId, messageText, [{ text: 'Открыть Mini App', action: 'open_tma' }], false, recipient));
    }
    saveDatabase(state);
    const delivery = await Promise.allSettled(sendJobs);
    const delivered = delivery.filter((result) => result.status === 'fulfilled' && result.value).length;
    const failed = sendJobs.length - delivered;
    console.log(`[Team Broadcast] author=${author.id} recipients=${recipients.length} queued=${sendJobs.length} delivered=${delivered} unavailable=${unavailable} failed=${failed}`);
    if (!delivered) {
      return res.status(502).json({
        error: 'Telegram не доставил рассылку. Участникам нужно открыть MegaBot и нажать /start, затем повторить отправку.',
        recipients: recipients.length,
        queued: sendJobs.length,
        delivered,
        unavailable,
        failed,
      });
    }
    return res.json({ success: true, recipients: recipients.length, queued: sendJobs.length, delivered, unavailable, failed });
  });

  app.post('/api/task/notify', async (req, res) => {
    const { requesterId, taskId } = req.body || {};
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (task.creatorId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Отправить напоминание может автор или администратор' });
    }
    const recipientIds = assignedIds(task);
    if (!recipientIds.length) return res.status(400).json({ error: 'Сначала назначь исполнителей' });
    const text = `Напоминание по задаче:\n\n${taskDetailsText(task, state)}`;
    const sendJobs: Promise<boolean>[] = [];
    for (const id of recipientIds) {
      const target = state.users.find((user) => user.id === id);
      if (!target) continue;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      state.messages[target.id].push({
        id: `task_manual_reminder_${Date.now()}_${target.id}`,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
        buttons: [{ text: 'Открыть задачи', action: 'open_tasks' }],
      });
      if (target.telegramId) sendJobs.push(sendTelegramMessage(target.telegramId, text, [{ text: 'Открыть задачи', action: 'open_tasks' }], false, target));
    }
    saveDatabase(state);
    const delivery = await Promise.allSettled(sendJobs);
    const delivered = delivery.filter((result) => result.status === 'fulfilled' && result.value).length;
    res.json({ success: true, queued: sendJobs.length, delivered });
  });

  // Claim a public task
  app.post('/api/task/claim', async (req, res) => {
    const { taskId, userId } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, userId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    const task = state.tasks.find(t => t.id === taskId);
    const user = state.users.find(u => u.id === userId);

    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (task.status !== 'open') return res.status(400).json({ error: 'Задача уже занята' });

    task.assignedTo = [userId];
    task.status = 'assigned';
    const claimSendJobs: Promise<boolean>[] = [];

    // Notify everyone who took the task
    if (!state.messages[userId]) state.messages[userId] = [];
    state.messages[userId].push({
      id: 'task_claim_bot_' + Date.now(),
      userId,
      sender: 'bot',
      text: `Ты закрепил за собой задачу: *"${task.title}"*\nБлоки: ${taskCompetencyNames(task).join(', ') || 'не указаны'}\nДедлайн: ${formatShortDate(task.deadline)}.\nТЗ можно проверить в Mini App.`,
      timestamp: new Date().toISOString()
    });
    if (user.telegramId) {
      claimSendJobs.push(sendTelegramMessage(
        user.telegramId,
        `Ты взял задачу в работу:\n\n${taskDetailsText(task, state)}`,
        [{ text: 'Открыть задачи', action: 'open_tasks' }],
        false,
        user,
      ));
    }

    const creator = state.users.find(u => u.id === task.creatorId);
    const text = `${user.realName} взял задачу с доски:\n"${task.title}"\n\nСвязаться: ${user.username}`;
    if (creator && creator.id !== userId) {
      if (!state.messages[creator.id]) state.messages[creator.id] = [];
      state.messages[creator.id].push({
        id: 'task_claim_creator_' + Date.now() + '_' + creator.id,
        userId: creator.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString()
      });
      if (creator.telegramId) {
        claimSendJobs.push(sendTelegramMessage(creator.telegramId, text, undefined, false, creator));
      }
    }
    for (const admin of state.users.filter(u => u.role === 'admin' && u.id !== userId && u.id !== creator?.id)) {
      if (!state.messages[admin.id]) state.messages[admin.id] = [];
      state.messages[admin.id].push({
        id: 'task_claim_admin_' + Date.now() + '_' + admin.id,
        userId: admin.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString()
      });
      if (admin.telegramId) claimSendJobs.push(sendTelegramMessage(admin.telegramId, text, undefined, false, admin));
    }

    saveDatabase(state);
    await Promise.allSettled(claimSendJobs);
    res.json({ success: true, task });
  });

  app.post('/api/task/release', async (req, res) => {
    const { taskId, userId } = req.body;
    const state = loadDatabase();
    const task = state.tasks.find(t => t.id === taskId);
    const user = state.users.find(u => u.id === userId);

    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!assignedIds(task).includes(userId)) {
      return res.status(403).json({ error: 'Эта задача не закреплена за тобой' });
    }

    task.assignedTo = null;
    task.status = 'open';
    task.completedAt = '';
    task.timeSpentMinutes = undefined;
    saveDatabase(state);

    const sendJobs: Promise<boolean>[] = [];
    const creator = state.users.find(u => u.id === task.creatorId);
    if (creator?.telegramId && creator.id !== user.id) {
      sendJobs.push(sendTelegramMessage(creator.telegramId, `${userMention(user)} отказался от задачи *"${task.title}"*. Она снова на бирже.`));
    }

    for (const target of state.users.filter(u => u.telegramId && u.id !== user.id)) {
      sendJobs.push(sendTelegramMessage(target.telegramId!, `Задача снова свободна:\n\n${taskDetailsText(task, state)}`, [{ text: 'Посмотреть задачу', action: `task_view:${task.id}` }]));
    }
    await Promise.allSettled(sendJobs);

    res.json({ success: true, task });
  });

  // Update task status (complete)
  app.post('/api/task/status', async (req, res) => {
    const { taskId, status, requesterId, timeSpentMinutes, completionComment } = req.body;
    const state = loadDatabase();

    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (!['open', 'assigned', 'completed', 'waiting', 'in_progress'].includes(status)) {
      return res.status(400).json({ error: 'Неизвестный статус задачи' });
    }
    const requester = state.users.find((user) => user.id === requesterId && user.registered);
    if (!requester) return res.status(403).json({ error: 'Нет доступа к задаче' });
    if (requester.role !== 'admin' && !assignedIds(task).includes(requester.id)) {
      return res.status(403).json({ error: 'Изменить статус может исполнитель или администратор' });
    }

    const parsedTimeSpent = Number(timeSpentMinutes);
    if (timeSpentMinutes !== undefined && (!Number.isFinite(parsedTimeSpent) || parsedTimeSpent <= 0 || parsedTimeSpent > 60000)) {
      return res.status(400).json({ error: 'Время выполнения должно быть больше нуля' });
    }
    task.status = status;
    if (status === 'completed') {
      task.completedAt = new Date().toISOString();
      task.timeSpentMinutes = timeSpentMinutes === undefined ? undefined : Math.round(parsedTimeSpent);
      task.completionComments = task.completionComments || {};
      const cleanComment = String(completionComment || '').trim();
      if (cleanComment) task.completionComments[requester.id] = cleanComment;
      else delete task.completionComments[requester.id];
    }
    if (status !== 'completed') {
      task.completedAt = '';
      task.timeSpentMinutes = undefined;
    }

    // If completed and was assigned to someone, notify admins
    if (status === 'completed' && task.assignedTo) {
      const workerName = assignedIds(task)
        .map((id) => state.users.find(u => u.id === id)?.realName)
        .filter(Boolean)
        .join(', ') || 'Участник';
      const sendJobs: Promise<boolean>[] = [];
      state.users.filter(u => u.role === 'admin').forEach(admin => {
        const text = `Задача выполнена!\nБлоки: ${taskCompetencyNames(task).join(', ') || 'не указаны'}\nИсполнитель: ${workerName}\nЗадача: "${task.title}"${task.timeSpentMinutes ? `\nЗатрачено: ${taskDurationLabel(task.timeSpentMinutes)}` : ''}${String(completionComment || '').trim() ? `\nКомментарий: ${String(completionComment).trim()}` : ''}`;
        if (!state.messages[admin.id]) state.messages[admin.id] = [];
        state.messages[admin.id].push({
          id: 'task_comp_admin_' + Date.now() + '_' + admin.id,
          userId: admin.id,
          sender: 'bot',
          text,
          timestamp: new Date().toISOString()
        });
        if (admin.telegramId) {
          sendJobs.push(sendTelegramMessage(admin.telegramId, text, undefined, false, admin));
        }
      });
      await Promise.allSettled(sendJobs);
    }

    saveDatabase(state);
    res.json({ success: true, task });
  });

  app.post('/api/task/log/clear', (req, res) => {
    const { requesterId } = req.body;
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Только админ может удалить бэклог задач' });
    }
    state.tasks = [];
    saveDatabase(state);
    res.json({ success: true });
  });

  app.get('/api/task/export', (req, res) => {
    const state = loadDatabase();

    const rows = state.tasks
      .slice()
      .sort((a, b) => String(a.competency || '').localeCompare(String(b.competency || ''), 'ru') || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .map((task) => {
        const creator = state.users.find((u) => u.id === task.creatorId);
        const workEvent = state.events?.find((item) => item.id === task.eventId);
        const executors = assignedIds(task)
          .map((id) => state.users.find((u) => u.id === id)?.realName)
          .filter(Boolean)
          .join(', ');
        return `
          <tr>
            <td>${escapeHtml(workEvent?.name || 'Без мероприятия')}</td>
            <td>${escapeHtml(taskCompetencyNames(task).join(', ') || 'Без блока')}</td>
            <td>${escapeHtml(taskStatusLabel(task.status))}</td>
            <td>${escapeHtml(task.title)}</td>
            <td>${escapeHtml(task.description)}</td>
            <td>${escapeHtml(task.sow)}</td>
            <td>${escapeHtml(task.deadline)}</td>
            <td>${escapeHtml(formatDateTimeShort(task.createdAt))}</td>
            <td>${escapeHtml(formatDateTimeShort(task.completedAt))}</td>
            <td>${escapeHtml(creator?.realName || 'Не указан')}</td>
            <td>${escapeHtml(executors || 'Не назначен')}</td>
            <td>${escapeHtml(taskPriorityLabel(task.priority))}</td>
            <td>${escapeHtml(taskDurationLabel(task.timeSpentMinutes) || 'Не указано')}</td>
            <td>${escapeHtml((task.tips || []).join('\\n'))}</td>
          </tr>`;
      })
      .join('');

    const html = `<!doctype html>
      <html>
        <head><meta charset="utf-8" /></head>
        <body>
          <table border="1">
            <thead>
              <tr>
                <th>Мероприятие</th>
                <th>Блок</th>
                <th>Статус</th>
                <th>Название</th>
                <th>Описание</th>
                <th>ТЗ</th>
                <th>Дедлайн</th>
                <th>Дата назначения</th>
                <th>Дата выполнения</th>
                <th>Автор</th>
                <th>Исполнитель</th>
                <th>Приоритет</th>
                <th>Затрачено времени</th>
                <th>Подсказки</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>`;

    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=\"megabot-task-log.xls\"');
    res.send(html);
  });
  // Suggest meeting windows with a pure algorithm.
  app.post('/api/meeting/suggest', async (req, res) => {
    const state = loadDatabase();
    const teamUsers = state.users.filter((user) => !isFacultyUser(user));
    const availabilityConfig = normalizeAvailabilityConfig(state.settings);

    const windowScores: {
      day: number;
      hour: number;
      endHour: number;
      duration: number;
      count: number;
      score: number;
      users: string[];
    }[] = [];

    const durations = [3, 4, 5, 2, 1];
    for (const d of availabilityConfig.activeDays) {
      for (const duration of durations) {
        for (let h = availabilityConfig.startHour; h <= availabilityConfig.endHour - duration + 1; h++) {
          const hoursWindow = Array.from({ length: duration }, (_, index) => h + index);
          const availableUsers = teamUsers
            .filter(u => {
              const daySlots = alignedAvailabilitySlots(state.availabilities[u.id])?.[d] || [];
              return hoursWindow.every(hour => daySlots.includes(hour));
            })
            .map(u => u.realName);

          if (availableUsers.length > 0) {
            windowScores.push({
              day: d,
              hour: h,
              endHour: h + duration,
              duration,
              count: availableUsers.length,
              score: availableUsers.length * duration,
              users: availableUsers
            });
          }
        }
      }
    }

    windowScores.sort((a, b) => {
      return b.score - a.score
        || b.count - a.count
        || b.duration - a.duration
        || a.day - b.day
        || a.hour - b.hour;
    });

    const bestByDay = new Map<number, typeof windowScores[number]>();
    for (const slot of windowScores) {
      if (!bestByDay.has(slot.day)) bestByDay.set(slot.day, slot);
    }
    const picked = [...bestByDay.values()].slice(0, 5);

    const russianDays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

    const suggestions = picked.map(s => {
      const hoursWindow = Array.from({ length: s.duration }, (_, index) => s.hour + index);
      const missingUsers = teamUsers.filter(u => {
        const daySlots = alignedAvailabilitySlots(state.availabilities[u.id])?.[s.day] || [];
        return !hoursWindow.every(hour => daySlots.includes(hour));
      }).map(u => ({
        id: u.id,
        realName: u.realName,
        username: u.username
      }));

      return {
        dayName: russianDays[s.day],
        dayIndex: s.day,
        hour: s.hour,
        endHour: s.endHour,
        duration: s.duration,
        count: s.count,
        total: teamUsers.length,
        users: s.users,
        missingUsers: missingUsers,
      };
    });

    res.json({
      success: true,
      type: 'algorithmic',
      topSuggestions: suggestions
    });
  });
  // Serve static UI assets or let Vite do it in dev mode
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, max-age=0');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  async function configureTelegramBotUi() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    const webAppUrl = configuredWebAppUrl();
    try {
      await telegramFetch(`${tgApiBase}/bot${botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { type: 'all_private_chats' },
          commands: [
            { command: 'start', description: 'Открыть Mini App' },
            { command: 'register', description: 'Показать профиль' },
            { command: 'slots', description: 'Отметить свободные слоты' },
            { command: 'meetings', description: 'Показать встречи' },
            { command: 'tasks', description: 'Показать мои задачи' },
            { command: 'help', description: 'Справка по боту' }
          ]
        })
      });
      await configureGroupCommandMenu();
      await configureGroupCommandMenu({ type: 'all_chat_administrators' });

      await telegramFetch(`${tgApiBase}/bot${botToken}/setChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menu_button: webAppUrl
            ? { type: 'web_app', text: 'Начать', web_app: { url: webAppUrl } }
            : { type: 'commands' },
        })
      });
      await configureBotProfile();
      const menuState = loadDatabase();
      const menuUsers = menuState.users.filter((user) => user.registered && user.telegramId);
      await Promise.allSettled(menuUsers.map((user) => configureChatMenuButton(user.telegramId!, user)));
      console.log('Telegram commands configured. Mini App menu button configured.');
    } catch (err: any) {
      console.error('Failed to configure Telegram commands/menu:', err.message);
    }
  }

  async function startTelegramLongPolling() {
    if (process.env.DISABLE_TELEGRAM_POLLING === 'true') {
      console.log('Telegram long polling disabled by DISABLE_TELEGRAM_POLLING.');
      return;
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) {
      console.warn('BOT_TOKEN / TELEGRAM_BOT_TOKEN is not set in .env. Telegram long polling was not started.');
      return;
    }

    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

    console.log('Starting Telegram long polling...');

    // Reset the old webhook before long polling so Telegram sends updates here.
    try {
      console.log('Deleting old Telegram webhook...');
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/deleteWebhook`);
      const data = await response.json();
      console.log('Telegram webhook deletion result:', data);
    } catch (err: any) {
      console.error('Failed to delete Telegram webhook:', err.message);
    }

    await sendDueBirthdayReminders();
    await sendSundayAvailabilityReminders();
    await sendTaskReminders();
    setInterval(() => {
      sendDueBirthdayReminders().catch((err) => {
        console.error('Birthday reminder check failed:', err.message);
      });
      sendSundayAvailabilityReminders().catch((err) => {
        console.error('Sunday availability reminder check failed:', err.message);
      });
    }, 24 * 60 * 60 * 1000);
    setInterval(() => {
      sendTaskReminders().catch((err) => {
        console.error('Task reminder check failed:', err.message);
      });
    }, 15 * 60 * 1000);

    console.log('Telegram long polling started.');
    let offset = 0;

    const poll = async () => {
      try {
        const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'callback_query', 'chat_member', 'my_chat_member']));
        const response = await telegramFetch(`${tgApiBase}/bot${botToken}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${allowedUpdates}`);
        if (!response.ok) {
          throw new Error(`HTTP status ${response.status}`);
        }
        const data = (await response.json()) as { ok: boolean; result: any[] };
        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            offset = update.update_id + 1;
            console.log(`[Long Polling] Received update: ${update.update_id}`);

            // Forward the update to the local webhook router.
            try {
              await fetch(`http://localhost:${PORT}/api/telegram-webhook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(update)
              });
            } catch (err: any) {
              console.error('Local update processing failed:', err.message);
            }
          }
        }
      } catch (err: any) {
        console.error('Telegram getUpdates request failed:', err.message);
        console.log(`Telegram getUpdates failed at offset=${offset}; token omitted from logs.`)
        // Small delay on network errors to avoid spamming requests.
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Schedule the next polling cycle.
      setTimeout(poll, 200);
    };

    poll();
  }

  setInterval(() => {
    try { pruneExpiredAvailabilityWeeks(); }
    catch (error) { console.error('Availability week rotation failed:', error); }
  }, 60 * 1000);

  if (sheetsConfig) {
    const maintainPrimarySheetWeek = async () => {
      const state = loadDatabase();
      await ensurePrimaryWeekSheet(sheetsConfig, state.users, state.settings);
    };
    maintainPrimarySheetWeek().catch((error: any) => console.error('Google Sheets primary week maintenance failed:', error.message || error));
    setInterval(() => {
      maintainPrimarySheetWeek().catch((error: any) => console.error('Google Sheets primary week maintenance failed:', error.message || error));
    }, 60 * 60 * 1000);
    setInterval(async () => {
      try {
        await flushPendingSheetAvailabilityExports();
        await reconcileAvailabilityFromPrimarySheet();
      } catch (error: any) {
        console.error('Google Sheets fallback reconciliation failed:', error.message || error);
      }
    }, 15 * 1000);
  }

  if (calendarConfig?.enabled) {
    reconcileMeetingCalendar().catch((error: any) => console.error('Google Calendar startup reconciliation failed:', error.message || error));
    setInterval(() => {
      retryPendingMeetingCalendar().catch((error: any) => console.error('Google Calendar retry failed:', error.message || error));
    }, 60 * 1000);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    configureTelegramBotUi().catch((error: any) => {
      console.error('Telegram UI configuration failed:', error.message || error);
    });
    startTelegramLongPolling();
  });
}

startServer().catch((error) => {
  console.error('Server startup failed:', error);
  process.exitCode = 1;
});





