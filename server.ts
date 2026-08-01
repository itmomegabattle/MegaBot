import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { ProxyAgent } from 'undici';
import { SimulationState, User, Availability, Meeting, Task, BotMessage, Faculty, TaskReminder } from './src/types.js';
import {
  buildUserMappingReport,
  currentMoscowWeekStart,
  ensureTemplateSheet,
  ensureManagedWeekSheets,
  exportAvailabilityToSheet,
  googleSheetsConfigFromEnv,
  importAvailabilitiesFromSheet,
  verifySheetsWebhook,
} from './src/googleSheetsSync.js';

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

// Empty initial data. Real users are created through Telegram or added by admins.
const INITIAL_USERS: User[] = [];
const INITIAL_AVAILABILITIES: Record<string, Availability> = {};
const INITIAL_MEETINGS: Meeting[] = [];
const INITIAL_TASKS: Task[] = [];
const INITIAL_MESSAGES: Record<string, BotMessage[]> = {};
const DEFAULT_FACULTIES: Faculty[] = ['КТУ', 'НОЖ', 'ТИНТ', 'ФТМФ', 'ФТМИ'].map((name) => ({
  id: 'fac_' + name.toLowerCase(),
  name,
}));

function createEmptyState(): SimulationState {
  return {
    users: [...INITIAL_USERS],
    faculties: [...DEFAULT_FACULTIES],
    facultyCompetencies: [],
    competencies: [],
    availabilities: { ...INITIAL_AVAILABILITIES },
    meetings: [...INITIAL_MEETINGS],
    tasks: [...INITIAL_TASKS],
    messages: { ...INITIAL_MESSAGES },
    settings: {},
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
  const match = String(value || '').match(/^(\d{2})\.(\d{2})(?:\.(\d{2}|\d{4}))?$/);
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
  if (!task.assignedTo) return [];
  return Array.isArray(task.assignedTo) ? task.assignedTo : [task.assignedTo];
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
  const executors = assignedIds(task)
    .map((id) => state.users.find((user) => user.id === id))
    .filter(Boolean) as User[];
  const executorText = task.status === 'open'
    ? 'открытая задача'
    : executors.length
      ? executors.map(userMention).join(', ')
      : 'не указан';

  return `*${task.title}*\n\n${task.description}\n\n*Блок:* ${task.competency || 'не указан'}\n*Приоритет:* ${taskPriorityLabel(task.priority)}\n*Автор:* ${userMention(creator)}\n*Срок:* ${formatShortDate(task.deadline)}\n*Исполнитель:* ${executorText}${task.timeSpentMinutes ? `\n*Затрачено:* ${taskDurationLabel(task.timeSpentMinutes)}` : ''}${task.sow ? `\n\n*ТЗ:* ${task.sow}` : ''}${task.tips?.length ? `\n\n*Подсказки:*\n${task.tips.map((tip) => `• ${tip}`).join('\n')}` : ''}`;
}

function meetingDetailsText(meeting: Meeting, state: SimulationState) {
  const host = state.users.find((user) => user.id === meeting.hostId);
  return `*${meeting.title}*\n\n*Дата:* ${formatShortDate(meeting.date)}\n*Время:* ${meeting.time}\n*Организатор:* ${userMention(host)}${meeting.competency ? `\n*Блок:* ${meeting.competency}` : ''}${meeting.topic ? `\n*Тема:* ${meeting.topic}` : ''}${meeting.description ? `\n*Описание:* ${meeting.description}` : ''}`;
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
  const rows = dayNames.map((day, index) => {
    const hours = availability[index] || [];
    return `${day}: ${hours.length ? hours.map((hour) => `${hour}:00`).join(', ') : '—'}`;
  });
  return `*Мои слоты на эту неделю*\n\n${rows.join('\n')}`;
}

function meetingsSummaryText(user: User, state: SimulationState) {
  const meetings = state.meetings
    .filter((meeting) => (
      meeting.status === 'scheduled'
      && (meeting.participants === 'all' || meeting.participants.includes(user.id) || meeting.hostId === user.id)
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

function hasSubmittedAvailabilityForWeek(availability?: Availability, weekIndex = 0) {
  if (!availability) return false;
  const slots = alignedAvailabilitySlots(availability);
  const unavailableDays = new Set(alignedHardUnavailableDays(availability));
  const firstDay = weekIndex * 7;
  return Array.from({ length: 7 }, (_, dayOffset) => firstDay + dayOffset).some((dayIndex) => (
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
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
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

  if (!Array.isArray(state.users)) state.users = [];
  if (!Array.isArray(state.faculties)) state.faculties = [];
  DEFAULT_FACULTIES.forEach((faculty) => {
    if (!state.faculties!.some((item) => item.id === faculty.id || item.name === faculty.name)) {
      state.faculties!.push(faculty);
    }
  });
  if (!Array.isArray(state.competencies)) state.competencies = [];
  if (!Array.isArray(state.facultyCompetencies)) state.facultyCompetencies = [];
  if (!state.availabilities) state.availabilities = {};
  if (!Array.isArray(state.meetings)) state.meetings = [];
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!state.messages) state.messages = {};
  if (!state.settings) state.settings = {};
  if (!Number.isInteger(state.settings.availabilityWeekCount) || Number(state.settings.availabilityWeekCount) < 2) {
    state.settings.availabilityWeekCount = 2;
  }

  state.users.forEach((user) => {
    if ((user.role as string) === 'faculty_lead') user.role = 'faculty_responsible';
    if (!Array.isArray(user.competencies)) user.competencies = [];
    if (user.primaryCompetency === undefined) user.primaryCompetency = user.competencies[0] || '';
    if (user.primaryCompetency && !user.competencies.includes(user.primaryCompetency)) {
      user.competencies = [user.primaryCompetency, ...user.competencies];
    }
    if (user.facultyId === undefined) user.facultyId = '';
    if (user.joinedAt === undefined) user.joinedAt = '';
    if (user.lastSeenAt === undefined) user.lastSeenAt = '';
  });
  state.meetings.forEach((meeting: any) => {
    if (meeting.competency === undefined) meeting.competency = '';
    if (meeting.description === undefined) meeting.description = '';
  });
  state.tasks.forEach((task: any) => {
    if (task.creatorId === undefined) task.creatorId = '';
    if (task.assignedTo === undefined) task.assignedTo = null;
    if (task.competency === undefined) task.competency = '';
    if (task.createdAt === undefined) task.createdAt = new Date().toISOString();
    if (task.completedAt === undefined) task.completedAt = task.status === 'completed' ? new Date().toISOString() : '';
    if (!['normal', 'important', 'critical'].includes(task.priority)) {
      task.priority = 'normal';
    }
    if (task.timeSpentMinutes !== undefined) {
      const minutes = Number(task.timeSpentMinutes);
      task.timeSpentMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : undefined;
    }
    if (task.facultyId === undefined) task.facultyId = '';
    if (!Array.isArray(task.reminders)) task.reminders = [];
  });
  Object.values(state.availabilities).forEach((availability: any) => {
    if (availability.weekStart === undefined) availability.weekStart = '';
    if (!Array.isArray(availability.hardUnavailableDays)) availability.hardUnavailableDays = [];
  });

  return state;
}

function saveDatabase(state: SimulationState) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error writing database file:', error);
  }
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
  pruneExpiredAvailabilityWeeks();
  const app = express();
  const sheetsConfig = googleSheetsConfigFromEnv();
  const processedSheetsEvents = new Set<string>();
  app.use(express.json({
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
      uptimeSeconds: Math.floor(process.uptime()),
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN),
      webAppConfigured: Boolean(process.env.WEBAPP_URL),
      googleSheetsConfigured: Boolean(sheetsConfig),
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
      '/task/create': 'creatorId',
      '/task/claim': 'userId',
      '/task/release': 'userId',
      '/task/status': 'requesterId',
      '/task/log/clear': 'requesterId',
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
    completionTaskId?: string;
  }>();
  const chatPanelMessageIds = new Map<string, number>();
  const groupCheckins = new Map<string, { title: string; userIds: Set<string> }>();

  // API Routes

  // Get entire simulation state
  app.get('/api/state', (req, res) => {
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
    const isManagedWeekSheet = /^Неделя \d{4}-\d{2}-\d{2}$/.test(String(req.body?.sheetTitle || ''));
    if (!isPrimarySheet && !isManagedWeekSheet) {
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
      result.imported.forEach((availability) => { state.availabilities[availability.userId] = availability; });
      saveDatabase(state);
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
      return response.ok;
    } catch {
      return false;
    }
  }

  async function sendTelegramKeyboard(chatId: string | number, text: string, rows: string[][], includeWebApp = false, user?: User) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const chatKey = String(chatId);
      const previousPanelId = chatPanelMessageIds.get(chatKey);
      if (previousPanelId) await deleteTelegramMessage(chatId, previousPanelId);
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
      if (data.result?.message_id) chatPanelMessageIds.set(chatKey, data.result.message_id);
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
    const chatKey = String(chatId);
    const previousPanelId = chatPanelMessageIds.get(chatKey);
    if (previousPanelId) await deleteTelegramMessage(chatId, previousPanelId);
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
      if (data.result?.message_id) chatPanelMessageIds.set(chatKey, data.result.message_id);
    } catch (err) {
      console.error('Telegram panel send failed:', err);
    }
  }

  async function sendGroupMessage(chatId: string | number, text: string) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      console.error('Telegram group message failed:', err);
    }
  }

  const groupBotCommands = [
    { command: 'all', description: 'Текст — упомянуть всю команду' },
    { command: 'meeting', description: 'Показать ближайшую встречу' },
    { command: 'deadlines', description: 'Показать ближайшие дедлайны' },
    { command: 'slots', description: 'Показать, кто не отметил слоты' },
    { command: 'birthdays', description: 'Показать ближайшие дни рождения' },
    { command: 'checkin', description: 'Название — запустить перекличку' },
    { command: 'help', description: 'Показать команды MegaBot' },
  ];

  async function configureGroupCommandMenu(scope: Record<string, string | number> = { type: 'all_group_chats' }) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return false;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    try {
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, commands: groupBotCommands }),
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
    const webAppUrl = process.env.WEBAPP_URL;
    const menuButton = user && !isFacultyUser(user) && webAppUrl
      ? {
          type: 'web_app',
          text: 'Открыть',
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
        buttons: [{ text: 'Открыть встречи', action: 'open_tma' }],
      });
      if (target.telegramId) {
        sendJobs.push(sendTelegramMessage(target.telegramId, text, [{ text: 'Открыть встречи', action: 'open_tma' }], false, target));
      }
    }
    return Promise.allSettled(sendJobs);
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
      topic: data.topic || '',
      description: data.description || '',
      status: 'scheduled',
      competency: data.competency || '',
    };

    state.meetings.push(meeting);
    const text = `Новая встреча запланирована!\n\n${meetingDetailsText(meeting, state)}\n\nПожалуйста, освободите это время.`;
    await notifyMeetingRecipients(state, meetingRecipientIds(state, data.participants, data.hostId), text, 'meeting_created');

    return meeting;
  }

  async function sendTelegramMessage(chatId: string | number, text: string, buttons?: { text: string; action: string }[], keyboardOnly = false, recipient?: User): Promise<boolean> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) {
      console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram message was not sent.');
      return false;
    }
    const webAppUrl = process.env.WEBAPP_URL;

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
      if (!response.ok) {
        console.error('Telegram sendMessage failed:', response.status, await response.text());
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

  function slotDayPanel(user: User, state: SimulationState, dayIndex: number, pendingSlots: Record<number, number[]>) {
    const dayNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    const selected = pendingSlots[dayIndex] || [];
    const keyboard = [16, 17, 18, 19, 20, 21, 22, 23].reduce<{ text: string; callback_data: string }[][]>((rows, hour, index) => {
      if (index % 2 === 0) rows.push([]);
      rows[rows.length - 1].push({
        text: `${selected.includes(hour) ? '✓ ' : ''}${hour}:00`,
        callback_data: `slot_toggle:${dayIndex}:${hour}`,
      });
      return rows;
    }, []);
    keyboard.push([
      { text: 'Сохранить неделю', callback_data: 'slot_save' },
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
  ) {
    const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const chatKey = String(chatId);
    const availability = overrideSlots || alignedAvailabilitySlots(state.availabilities[user.id]);
    chatSessions.set(chatKey, {
      flow: 'slots_edit',
      pendingSlots: Object.fromEntries(
        Object.entries(availability).map(([day, selectedHours]) => [Number(day), [...selectedHours]]),
      ),
    });
    const keyboard = [
      dayNames.slice(0, 4).map((day, index) => ({
        text: `${(availability[index] || []).length ? '✓ ' : ''}${day}`,
        callback_data: `slots_day:${index}`,
      })),
      dayNames.slice(4).map((day, offset) => ({
        text: `${(availability[offset + 4] || []).length ? '✓ ' : ''}${day}`,
        callback_data: `slots_day:${offset + 4}`,
      })),
      [{ text: 'Сохранить как есть', callback_data: 'slot_save' }],
    ];
    await sendInlinePanel(chatId, slotsSummaryText(user, state, availability), keyboard);
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

  async function sendDueBirthdayReminders() {
    const state = loadDatabase();
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1);
    const targetBday = `${String(targetDate.getDate()).padStart(2, '0')}.${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
    const markerYear = targetDate.getFullYear();
    const paymentPhone = process.env.BIRTHDAY_PAYMENT_PHONE || '+7 (921) 123-45-67';
    const paymentBank = process.env.BIRTHDAY_PAYMENT_BANK || 'Т-Банк';
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

        const paymentText = process.env.BIRTHDAY_PAYMENT_PHONE && process.env.BIRTHDAY_PAYMENT_BANK
          ? `\n\nСбор на подарок: ${paymentPhone}, ${paymentBank}.`
          : '';
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
      if (hasSubmittedAvailabilityForWeek(state.availabilities[user.id], 1)) continue;
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
    const webAppUrl = process.env.WEBAPP_URL;

    if (!botToken) {
      return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN or BOT_TOKEN is not set.' });
    }
    if (!webAppUrl) {
      return res.status(400).json({ error: 'WEBAPP_URL is not set.' });
    }

    const webhookUrl = `${webAppUrl}/api/telegram-webhook`;
    try {
      const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const response = await telegramFetch(`${tgApiBase}/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
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
  app.post('/api/telegram-webhook', async (req, res) => {
    const update = req.body;

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

      if (action === 'nav_profile') {
        await answerCallback(callback.id);
        await showProfilePanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (action === 'nav_slots') {
        await answerCallback(callback.id);
        const pendingSlots = chatSessions.get(String(chatId))?.pendingSlots
          || alignedAvailabilitySlots(state.availabilities[user.id]);
        await showSlotsPanel(chatId, user, state, pendingSlots);
        return res.json({ ok: true });
      }

      if (action === 'nav_tasks') {
        await answerCallback(callback.id);
        await showTasksPanel(chatId, user, state);
        return res.json({ ok: true });
      }

      if (action.startsWith('slots_day:')) {
        const dayIndex = Number(action.split(':')[1]);
        if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
          await answerCallback(callback.id, 'Неизвестный день');
          return res.json({ ok: true });
        }
        const chatKey = String(chatId);
        const pendingSlots = chatSessions.get(chatKey)?.pendingSlots
          || { ...alignedAvailabilitySlots(state.availabilities[user.id]) };
        chatSessions.set(chatKey, { flow: 'slots_edit', slotDay: dayIndex, pendingSlots });
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots);
        await answerCallback(callback.id);
        await editTelegramPanel(chatId, callback.message.message_id, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action.startsWith('slot_toggle:')) {
        const [, dayValue, hourValue] = action.split(':');
        const dayIndex = Number(dayValue);
        const hour = Number(hourValue);
        const chatKey = String(chatId);
        const session = chatSessions.get(chatKey);
        const pendingSlots = session?.pendingSlots || { ...alignedAvailabilitySlots(state.availabilities[user.id]) };
        const selected = new Set(pendingSlots[dayIndex] || []);
        if (selected.has(hour)) selected.delete(hour);
        else selected.add(hour);
        pendingSlots[dayIndex] = [...selected].sort((a, b) => a - b);
        chatSessions.set(chatKey, { flow: 'slots_edit', slotDay: dayIndex, pendingSlots });
        const panel = slotDayPanel(user, state, dayIndex, pendingSlots);
        await answerCallback(callback.id, selected.has(hour) ? `${hour}:00 добавлено` : `${hour}:00 снято`);
        await editTelegramPanel(chatId, callback.message.message_id, panel.text, panel.keyboard);
        return res.json({ ok: true });
      }

      if (action === 'slot_save') {
        const chatKey = String(chatId);
        const pendingSlots = chatSessions.get(chatKey)?.pendingSlots
          || alignedAvailabilitySlots(state.availabilities[user.id]);
        state.availabilities[user.id] = {
          userId: user.id,
          slots: pendingSlots,
          hardUnavailableDays: state.availabilities[user.id]?.hardUnavailableDays || [],
          weekStart: currentWeekStartIso(),
          updatedAt: new Date().toISOString(),
        };
        chatSessions.delete(chatKey);
        saveDatabase(state);
        await answerCallback(callback.id, 'Слоты сохранены');
        await showProfilePanel(chatId, user, state);
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
        task.assignedTo = user.id;
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
        const groupCommand = text.toLowerCase().split('@')[0];
        const supportedGroupCommand = ['/all', '/meeting', '/deadlines', '/slots', '/birthdays', '/checkin', '/bindteamchat', '/help'].some(
          (command) => groupCommand === command || groupCommand.startsWith(`${command} `),
        );
        if (!supportedGroupCommand) return res.json({ ok: true });
        await deleteTelegramMessage(chatId, update.message.message_id);
        if (!user?.registered) {
          await sendGroupMessage(chatId, 'Эта команда доступна участникам, привязанным к MegaBot.');
          return res.json({ ok: true });
        }
        user.lastSeenAt = new Date().toISOString();
        saveDatabase(state);

        if (groupCommand === '/bindteamchat') {
          if (user.role !== 'admin') {
            await sendGroupMessage(chatId, 'Привязать командный чат может только администратор.');
          } else {
            state.settings = { ...(state.settings || {}), teamChatId: String(chatId) };
            saveDatabase(state);
            await configureGroupCommandMenu({ type: 'chat', chat_id: chatId });
            await sendGroupMessage(chatId, 'Чат привязан к MegaBot. Командные функции активны.');
          }
          return res.json({ ok: true });
        }

        const configuredChatId = state.settings?.teamChatId;
        if (configuredChatId && configuredChatId !== String(chatId)) {
          await sendGroupMessage(chatId, 'Командные команды доступны только в привязанном чате.');
          return res.json({ ok: true });
        }

        if (groupCommand.startsWith('/all')) {
          const note = text.replace(/^\/all(?:@\w+)?/i, '').trim();
          const mentions = state.users
            .filter((member) => !isFacultyUser(member) && member.registered && member.username)
            .map((member) => member.username)
            .join(' ');
          await sendGroupMessage(chatId, `${note ? `*${note}*\n\n` : ''}${mentions || 'Нет привязанных участников.'}`);
          return res.json({ ok: true });
        }

        if (groupCommand === '/meeting') {
          const nextMeeting = state.meetings
            .filter((meeting) => meeting.status === 'scheduled' && meetingDateTime(meeting) >= Date.now())
            .slice()
            .sort((a, b) => meetingDateTime(a) - meetingDateTime(b))[0];
          await sendGroupMessage(chatId, nextMeeting
            ? `*Ближайшая встреча*\n\n${meetingDetailsText(nextMeeting, state)}`
            : 'Ближайших встреч нет.');
          return res.json({ ok: true });
        }

        if (groupCommand === '/deadlines') {
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

        if (groupCommand === '/slots') {
          const team = state.users.filter((member) => !isFacultyUser(member));
          const missing = team.filter((member) => !hasSubmittedAvailabilityForWeek(state.availabilities[member.id]));
          await sendGroupMessage(chatId, missing.length
            ? `*Ещё не отметили слоты (${missing.length}):*\n${missing.map((member) => member.username).join(' ')}`
            : 'Все участники отметили слоты на неделю.');
          return res.json({ ok: true });
        }

        if (groupCommand === '/birthdays') {
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

        if (groupCommand.startsWith('/checkin')) {
          const title = text.replace(/^\/checkin(?:@\w+)?/i, '').trim() || 'Перекличка команды';
          await sendInlinePanel(chatId, `*${title}*\n\nОтметились: 0\nПока никто`, [[
            { text: 'Я здесь · 0', callback_data: 'group_checkin' },
          ]]);
          const panelId = chatPanelMessageIds.get(String(chatId));
          if (panelId) groupCheckins.set(`${chatId}:${panelId}`, { title, userIds: new Set() });
          return res.json({ ok: true });
        }

        await sendGroupMessage(
          chatId,
          '*Команды MegaBot*\n\n'
            + '/all текст — упомянуть всю команду\n'
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
      await configureChatMenuButton(chatId, user);

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
        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        task.timeSpentMinutes = presetMinutes[normalizedText];
        saveDatabase(state);
        for (const admin of state.users.filter((member) => member.role === 'admin' && member.telegramId && member.id !== user.id)) {
          await sendTelegramMessage(admin.telegramId!, `Задача выполнена!\n\n${task.title}\nИсполнитель: ${userMention(user)}${task.timeSpentMinutes ? `\nЗатрачено: ${taskDurationLabel(task.timeSpentMinutes)}` : ''}`);
        }
        await showTasksPanel(chatId, user, state);
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
        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        task.timeSpentMinutes = minutes;
        saveDatabase(state);
        for (const admin of state.users.filter((member) => member.role === 'admin' && member.telegramId && member.id !== user.id)) {
          await sendTelegramMessage(admin.telegramId!, `Задача выполнена!\n\n${task.title}\nИсполнитель: ${userMention(user)}\nЗатрачено: ${taskDurationLabel(minutes)}`);
        }
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
        await showProfilePanel(chatId, user, state);
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
        chatSessions.set(chatKey, { flow: 'task_create_title' });
        await sendTelegramKeyboard(chatId, 'Напиши название задачи.', [['Назад']], false, user);
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
    const { requesterId, userId, realName, username, role, birthday, competencies, primaryCompetency } = req.body;
    const state = loadDatabase();

    const selfEditOnly = requesterId === userId && !realName && !username && !role && !birthday && (Array.isArray(competencies) || primaryCompetency !== undefined);
    if (!isAdminUser(state, requesterId) && !selfEditOnly) {
      return res.status(403).json({ error: 'Редактировать участников может только админ' });
    }

    const user = state.users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    if (realName) user.realName = realName;
    if (username) user.username = username.startsWith('@') ? username : '@' + username;
    if (role) user.role = role;
    if (birthday !== undefined) {
      if (birthday && !birthdayParts(birthday)?.year) {
        return res.status(400).json({ error: 'Укажи дату рождения полностью: ДД.ММ.ГГГГ' });
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
      user.competencies = role === 'faculty_helper' ? cleanCompetencies : [];
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
        competencies: role === 'faculty_helper' ? cleanCompetencies : [],
        primaryCompetency: role === 'faculty_helper' ? cleanCompetencies[0] || '' : '',
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
    user.competencies = role === 'faculty_helper' ? cleanCompetencies : [];
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
    const { requesterId, facultyId, title, description, deadline, assignedTo, reminders, competency } = req.body;
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
    const { requesterId, taskId, title, description, deadline, assignedTo, reminders, facultyId, competency } = req.body;
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
    const { requesterId, weeks, notifyTeam = false } = req.body || {};
    const state = loadDatabase();
    if (!isAdminUser(state, requesterId)) return res.status(403).json({ error: 'Admin access required' });
    const weekCount = Number(weeks);
    if (!Number.isInteger(weekCount) || weekCount < 2 || weekCount > 5) {
      return res.status(400).json({ error: 'Количество недель должно быть от 2 до 5' });
    }
    state.settings = { ...(state.settings || {}), availabilityWeekCount: weekCount };
    saveDatabase(state);
    let googleSheetsWeeks: unknown = null;
    if (sheetsConfig) {
      try { googleSheetsWeeks = await ensureManagedWeekSheets(sheetsConfig, state.users, weekCount); }
      catch (error: any) {
        console.error('Google Sheets week update failed:', error);
        return res.status(502).json({ error: error.message || 'Не удалось обновить недели Google Sheets' });
      }
    }
    let notified = 0;
    if (notifyTeam) {
      const text = `Пожалуйста, заполните свободные слоты сразу на ${weekCount} ${weekCount === 2 ? 'недели' : 'недели'} вперёд в Mini App.`;
      const recipients = state.users.filter((user) => !isFacultyUser(user) && user.telegramId && user.id !== requesterId);
      const results = await Promise.allSettled(recipients.map((user) => sendTelegramMessage(user.telegramId!, text, [{ text: 'Заполнить слоты', action: 'open_tma' }], false, user)));
      notified = results.filter((result) => result.status === 'fulfilled').length;
    }
    return res.json({ success: true, weeks: weekCount, notified, googleSheets: googleSheetsWeeks });
  });

  // Save/Update User Availability
  app.post('/api/availability', async (req, res) => {
    const { userId, slots, weekStart, hardUnavailableDays } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, userId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    state.availabilities[userId] = {
      userId,
      slots,
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
        googleSheets = { synced: true, updatedCells: result.updatedCells };
      } catch (error: any) {
        console.error('Google Sheets availability export failed:', error);
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

    const cleanParticipants = participants === 'all'
      ? 'all'
      : [...new Set(Array.isArray(participants) ? participants : [])]
          .filter((id) => state.users.some((user) => user.id === id && !isFacultyUser(user)));
    const newMeeting = await createMeetingAndNotify(state, {
      title,
      type,
      date,
      time,
      duration,
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
    if (title) meeting.title = title;
    if (type) meeting.type = type;
    if (date) meeting.date = date;
    if (time) meeting.time = time;
    if (duration) meeting.duration = duration;
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
    saveDatabase(state);
    res.json({ success: true, meeting });
  });

  // Create a new task
  app.post('/api/task/create', async (req, res) => {
    const { title, description, deadline, assignedTo, sow, tips, priority, creatorId, competency } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, creatorId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    const cleanPriority: Task['priority'] = ['normal', 'important', 'critical'].includes(priority) ? priority : 'normal';
    const requestedAssigneeIds = Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : assignedTo ? [assignedTo] : [];
    const assigneeIds = [...new Set(requestedAssigneeIds)]
      .filter((id) => state.users.some((user) => user.id === id && !isFacultyUser(user)));
    const now = new Date().toISOString();
    const newTask: Task = {
      id: 't_' + Date.now(),
      title: String(title || '').trim() || 'Без названия',
      description: String(description || '').trim(),
      deadline: String(deadline || '').trim(),
      assignedTo: assigneeIds.length === 0 ? null : assigneeIds,
      creatorId,
      competency: String(competency || '').trim(),
      sow: sow || '',
      tips: tips || [],
      status: assigneeIds.length ? 'assigned' : 'open',
      priority: cleanPriority,
      createdAt: now,
      completedAt: '',
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

    task.assignedTo = userId;
    task.status = 'assigned';

    // Notify everyone who took the task
    if (!state.messages[userId]) state.messages[userId] = [];
    state.messages[userId].push({
      id: 'task_claim_bot_' + Date.now(),
      userId,
      sender: 'bot',
      text: `Ты закрепил за собой задачу: *"${task.title}"*\nБлок: ${task.competency || 'не указан'}\nДедлайн: ${formatShortDate(task.deadline)}.\nТЗ можно проверить в Mini App.`,
      timestamp: new Date().toISOString()
    });
    if (user.telegramId) {
      await sendTelegramMessage(
        user.telegramId,
        `Ты взял задачу в работу:\n\n${taskDetailsText(task, state)}`,
        [{ text: 'Открыть задачи', action: 'open_tasks' }],
        false,
        user,
      );
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
        await sendTelegramMessage(creator.telegramId, text);
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
      if (admin.telegramId) await sendTelegramMessage(admin.telegramId, text);
    }

    saveDatabase(state);
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
    const { taskId, status, requesterId, timeSpentMinutes } = req.body;
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
        const text = `Задача выполнена!\nБлок: ${task.competency || 'не указан'}\nИсполнитель: ${workerName}\nЗадача: "${task.title}"${task.timeSpentMinutes ? `\nЗатрачено: ${taskDurationLabel(task.timeSpentMinutes)}` : ''}`;
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
        const executors = assignedIds(task)
          .map((id) => state.users.find((u) => u.id === id)?.realName)
          .filter(Boolean)
          .join(', ');
        return `
          <tr>
            <td>${escapeHtml(task.competency || 'Без блока')}</td>
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
    for (let d = 0; d < 7; d++) {
      for (const duration of durations) {
        for (let h = 16; h <= 24 - duration; h++) {
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
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
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
    const webAppUrl = process.env.WEBAPP_URL;

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
            ? { type: 'web_app', text: 'Открыть', web_app: { url: webAppUrl } }
            : { type: 'commands' },
        })
      });
      console.log('Telegram commands configured. Mini App menu button configured.');
    } catch (err: any) {
      console.error('Failed to configure Telegram commands/menu:', err.message);
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
        const response = await telegramFetch(`${tgApiBase}/bot${botToken}/getUpdates?offset=${offset}&timeout=30`);
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
    const maintainSheetsWeeks = async () => {
      const state = loadDatabase();
      await ensureManagedWeekSheets(sheetsConfig, state.users, Number(state.settings?.availabilityWeekCount || 2));
    };
    maintainSheetsWeeks().catch((error: any) => console.error('Google Sheets week maintenance failed:', error.message || error));
    setInterval(() => {
      maintainSheetsWeeks().catch((error: any) => console.error('Google Sheets week maintenance failed:', error.message || error));
    }, 60 * 60 * 1000);
    setInterval(async () => {
      try {
        const state = loadDatabase();
        const result = await importAvailabilitiesFromSheet(sheetsConfig, state.users);
        result.imported.forEach((availability) => { state.availabilities[availability.userId] = availability; });
        if (result.imported.length) saveDatabase(state);
      } catch (error: any) {
        console.error('Google Sheets fallback reconciliation failed:', error.message || error);
      }
    }, 60 * 1000);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    startTelegramLongPolling();
  });
}

startServer();





