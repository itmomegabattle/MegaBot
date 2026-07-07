import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { ProxyAgent } from 'undici';
import { SimulationState, User, Availability, Meeting, Task, BotMessage, Faculty, TaskReminder } from './src/types.js';

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const telegramProxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

function telegramFetch(input: string, init: RequestInit = {}) {
  return fetch(input, telegramProxyAgent ? ({ ...init, dispatcher: telegramProxyAgent } as RequestInit) : init);
}

const PORT = 3000;
const DB_FILE = path.join(process.cwd(), 'database.json');

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
  return state.users.find((user) => user.telegramId === id)
    || (normalizedUsername
      ? state.users.find((user) => user.username.replace(/^@/, '').toLowerCase() === normalizedUsername)
      : undefined);
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
      birthday: '01.01',
      telegramId: id,
      registered: true,
      competencies: [],
      primaryCompetency: '',
      facultyId: '',
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

function isValidBirthday(value?: string) {
  if (!value || !/^\d{2}\.\d{2}$/.test(value)) return false;
  const [day, month] = value.split('.').map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function formatShortDate(value?: string) {
  if (!value) return '';
  if (/^\d{2}\.\d{2}\.\d{2}$/.test(value) || /^\d{2}\.\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}.${match[2]}.${match[1].slice(2)}`;
  return value;
}

function parseShortDate(value?: string) {
  if (!value) return null;
  const normalized = formatShortDate(value);
  const match = normalized.match(/^(\d{2})\.(\d{2})(?:\.(\d{2}))?$/);
  if (!match) return null;
  const year = match[3] ? Number(`20${match[3]}`) : new Date().getFullYear();
  return new Date(year, Number(match[2]) - 1, Number(match[1]), 18, 0, 0, 0);
}

function parseRegistrationInput(text: string) {
  const input = text.replace(/^\/register(@\w+)?/i, '').trim();
  const parts = input.split(/\s+/).filter(Boolean);
  const birthday = parts[parts.length - 1] || '';
  const nameParts = parts.slice(0, -1);
  const realName = nameParts.join(' ').trim();

  if (nameParts.length < 2 || !isValidBirthday(birthday)) {
    return null;
  }

  return { realName, birthday };
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

  return `*${task.title}*\n\n${task.description}\n\n*Блок:* ${task.competency || 'не указан'}\n*Автор:* ${userMention(creator)}\n*Срок:* ${formatShortDate(task.deadline)}\n*Исполнитель:* ${executorText}${task.sow ? `\n\n*ТЗ:* ${task.sow}` : ''}${task.tips?.length ? `\n\n*Подсказки:*\n${task.tips.map((tip) => `• ${tip}`).join('\n')}` : ''}`;
}

function meetingDetailsText(meeting: Meeting, state: SimulationState) {
  const host = state.users.find((user) => user.id === meeting.hostId);
  return `*${meeting.title}*\n\n*Дата:* ${formatShortDate(meeting.date)}\n*Время:* ${meeting.time}\n*Организатор:* ${userMention(host)}${meeting.competency ? `\n*Блок:* ${meeting.competency}` : ''}${meeting.topic ? `\n*Тема:* ${meeting.topic}` : ''}${meeting.description ? `\n*Описание:* ${meeting.description}` : ''}`;
}

function nextShortDate(daysAhead = 1) {
  const target = new Date();
  target.setDate(target.getDate() + daysAhead);
  return `${String(target.getDate()).padStart(2, '0')}.${String(target.getMonth() + 1).padStart(2, '0')}.${String(target.getFullYear()).slice(2)}`;
}

function currentWeekStartIso() {
  const today = new Date();
  const jsDay = today.getDay() === 0 ? 6 : today.getDay() - 1;
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(today.getDate() - jsDay);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
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

  state.users.forEach((user) => {
    if ((user.role as string) === 'faculty_lead') user.role = 'faculty_responsible';
    if (!Array.isArray(user.competencies)) user.competencies = [];
    if (user.primaryCompetency === undefined) user.primaryCompetency = user.competencies[0] || '';
    if (user.primaryCompetency && !user.competencies.includes(user.primaryCompetency)) {
      user.competencies = [user.primaryCompetency, ...user.competencies];
    }
    if (user.facultyId === undefined) user.facultyId = '';
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

async function startServer() {
  const app = express();
  app.use(express.json());
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
  }>();

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

  // Helper to send message to Telegram
  function buildChatKeyboard(_includeWebApp = false, user?: User) {
    if (isFacultyUser(user)) {
      return {
        keyboard: [[{ text: 'Мои задачи' }, { text: 'Помощь' }]],
        resize_keyboard: true,
        is_persistent: true,
      };
    }
    const keyboard: any[] = [];

    keyboard.push(
      [{ text: 'Профиль' }, { text: 'Встречи' }],
      [{ text: 'Задачи' }, { text: 'Помощь' }],
    );

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

  async function sendTelegramKeyboard(chatId: string | number, text: string, rows: string[][], includeWebApp = false, user?: User) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    await telegramFetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: renderTelegramHtml(text),
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(rows, includeWebApp, user),
      }),
    });
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
    await telegramFetch(`${tgApiBase}/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
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
    const targetUserIds = new Set<string>();
    if (data.participants === 'all') {
      state.users.forEach(u => targetUserIds.add(u.id));
    } else {
      data.participants.forEach(id => targetUserIds.add(id));
      targetUserIds.add(data.hostId);
    }

    const text = `Новая встреча запланирована!\n\n${meetingDetailsText(meeting, state)}\n\nПожалуйста, освободите это время.`;
    for (const targetUserId of targetUserIds) {
      const target = state.users.find(u => u.id === targetUserId);
      if (!target) continue;
      if (!state.messages[target.id]) state.messages[target.id] = [];
      state.messages[target.id].push({
        id: 'notify_' + Date.now() + '_' + target.id,
        userId: target.id,
        sender: 'bot',
        text,
        timestamp: new Date().toISOString(),
      });
      if (target.telegramId) {
        await sendTelegramMessage(target.telegramId, text, [{ text: 'Открыть встречи', action: 'open_tma' }]);
      }
    }

    return meeting;
  }

  async function sendTelegramMessage(chatId: string | number, text: string, buttons?: { text: string; action: string }[], keyboardOnly = false, recipient?: User) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) {
      console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram message was not sent.');
      return;
    }
    const webAppUrl = process.env.WEBAPP_URL;

    let replyMarkup: any = buildChatKeyboard(false, recipient);
    if (keyboardOnly) {
      replyMarkup = buildChatKeyboard(false, recipient);
    } else if (buttons && buttons.length > 0) {
      replyMarkup = {};
      replyMarkup.inline_keyboard = buttons.map(b => {
        if (b.action === 'open_tma' || b.action === 'open_tasks') {
          return [{
            text: b.text,
            web_app: { url: webAppUrl || '' }
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
      }
    } catch (err) {
      console.error('Telegram sendMessage failed:', err);
    }
  }

  async function sendDueBirthdayReminders() {
    const state = loadDatabase();
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 2);
    const targetBday = `${String(targetDate.getDate()).padStart(2, '0')}.${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
    const markerYear = targetDate.getFullYear();
    const paymentPhone = process.env.BIRTHDAY_PAYMENT_PHONE || '+7 (921) 123-45-67';
    const paymentBank = process.env.BIRTHDAY_PAYMENT_BANK || 'Т-Банк';
    let changed = false;

    for (const birthdayUser of state.users) {
      if (birthdayUser.birthday !== targetBday) continue;

      for (const recipient of state.users) {
        if (recipient.id === birthdayUser.id) continue;
        const notificationId = `bday_notify_${markerYear}_${birthdayUser.id}_${recipient.id}`;
        if (!state.messages[recipient.id]) state.messages[recipient.id] = [];
        if (state.messages[recipient.id].some((message) => message.id === notificationId)) continue;

        const text = `🎁 Через 2 дня день рождения у ${birthdayUser.realName} (${birthdayUser.birthday}).\n\nСкидываемся на подарок по 400 рублей.\nПеревод: ${paymentPhone}, ${paymentBank}.\n\nИменинник это сообщение не получает.`;
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
          if (target?.telegramId) {
            await sendTelegramMessage(target.telegramId, `Напоминание по задаче:\n\n${taskDetailsText(task, state)}\n\nТекущий статус: ${taskStatusLabel(task.status)}`, undefined, false, target);
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
    if (user.registered === undefined) {
      user.registered = false;
      changed = true;
    }
    if (changed) saveDatabase(state);

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
              { text: 'Взять задачу', action: `task_claim:${task.id}` },
              { text: 'Скип', action: 'task_skip' },
            ]
          : [{ text: 'Посмотреть в приложении', action: 'open_tasks' }];
        await sendTelegramMessage(chatId, taskDetailsText(task, state), buttons);
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
        await sendTelegramMessage(chatId, `Ты взял задачу:\n\n${taskDetailsText(task, state)}`, [
          { text: 'Отказаться от задачи', action: `task_release:${task.id}` },
          { text: 'Посмотреть в приложении', action: 'open_tasks' },
        ]);
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
        saveDatabase(state);
        await answerCallback(callback.id, 'Задача возвращена на биржу');
        await sendTelegramMessage(chatId, `Ты отказался от задачи *"${task.title}"*. Она снова открыта.`);
        const creator = state.users.find(u => u.id === task.creatorId);
        if (creator?.telegramId && creator.id !== user.id) {
          await sendTelegramMessage(creator.telegramId, `${userMention(user)} отказался от задачи *"${task.title}"*. Она снова на бирже.`);
        }
        for (const target of state.users.filter(u => u.telegramId && u.id !== user.id)) {
          await sendTelegramMessage(target.telegramId!, `Задача снова свободна:\n\n${taskDetailsText(task, state)}`, [{ text: 'Посмотреть задачу', action: `task_view:${task.id}` }]);
        }
        return res.json({ ok: true });
      }

      if (action === 'task_skip') {
        await answerCallback(callback.id, 'Ок');
        await sendTelegramKeyboard(chatId, 'Ок, возвращаю меню.', [['Профиль', 'Встречи'], ['Задачи', 'Помощь']], true);
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

      if (!user) {
        await configureChatMenuButton(chatId, undefined);
        await sendTelegramKeyboard(
          chatId,
          'Вас нет в списке участников. Попросите админа добавить ваш Telegram в раздел «Команда», а потом нажмите /start ещё раз.',
          [['Помощь']],
          false,
        );
        return res.json({ ok: true });
      } else if (!user.telegramId) {
        user.telegramId = String(fromUser.id);
      }
      if (user.registered === undefined) {
        user.registered = false;
      }
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

      let replyText = '';
      let buttons: { text: string; action: string }[] | undefined = undefined;
      const cmd = text.toLowerCase();
      const registration = parseRegistrationInput(text);
      const chatKey = String(chatId);
      const normalizedText = text.trim().toLowerCase();
      const session = chatSessions.get(chatKey);

      if (isFacultyUser(user)) {
        user.registered = true;
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

      if (normalizedText === 'назад' || normalizedText === 'меню') {
        const currentSession = chatSessions.get(chatKey);
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
        await sendTelegramKeyboard(chatId, 'Возвращаю меню.', [['Профиль', 'Встречи'], ['Задачи', 'Помощь']], true);
        return res.json({ ok: true });
      }

      if (normalizedText === 'назначить собрание') {
        chatSessions.set(chatKey, { flow: 'meeting_choose_type' });
        await sendTelegramKeyboard(chatId, 'Какое собрание назначаем?', [['Собрать всю команду'], ['Выбрать блок'], ['Назад']]);
        return res.json({ ok: true });
      }

      if (normalizedText === 'собрать всю команду') {
        if (!user.registered) {
          await sendTelegramKeyboard(chatId, 'Сначала зарегистрируйся: напиши `Имя Фамилия ДД.ММ`.', [['Профиль'], ['Назад']]);
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

      if (cmd.startsWith('/start')) {
        if (user.registered) {
          replyText = `Привет, ${user.realName}! Кнопки уже внизу: открывай приложение, смотри встречи, задачи или профиль.`;
        } else {
          replyText = 'Привет! Сначала нужно зарегистрироваться в команде.\n\nНапиши одним сообщением:\n`Имя Фамилия ДД.ММ`\n\nНапример: `Иван Кузнецов 12.10`';
        }
      } else if (isRegistrationPrompt(text)) {
        const directRegistration = parseRegistrationInput(text);
        if (!directRegistration) {
          if (user.registered) {
            replyText = `Твой профиль:\n\n*${user.realName}*\nTelegram: *${user.username}*\nДата рождения: *${user.birthday || '01.01'}*\nРоль: *${user.role === 'admin' ? 'админ' : 'организатор'}*\n\nЧтобы изменить данные, отправь одним сообщением:\n\`Имя Фамилия ДД.ММ\``;
          } else {
            replyText = 'Введи имя, фамилию и дату рождения одним сообщением:\n`Иван Кузнецов 12.10`';
          }
        } else {
          user.realName = directRegistration.realName;
          user.birthday = directRegistration.birthday;
          user.registered = true;
          replyText = `Готово! Профиль сохранён:\n*${user.realName}*\nДата рождения: *${user.birthday}*.\n\nТеперь можно открыть приложение кнопкой снизу.`;
        }
      } else if (registration && !cmd.startsWith('/')) {
        user.realName = registration.realName;
        user.birthday = registration.birthday;
        user.registered = true;
        replyText = `Готово! Профиль сохранён:\n*${user.realName}*\nДата рождения: *${user.birthday}*.\n\nТеперь можно открыть приложение кнопкой снизу.`;
      } else if (isOpenAppText(text)) {
        replyText = user.registered
          ? 'Открывай приложение кнопкой снизу. Если Telegram не открыл его автоматически, нажми кнопку ещё раз.'
          : 'Сначала зарегистрируйся: напиши `Имя Фамилия ДД.ММ`, например `Иван Кузнецов 12.10`.';
      } else if (cmd.startsWith('/meetings') || cmd === 'встречи') {
        if (!user.registered) {
          await sendTelegramKeyboard(chatId, 'Сначала зарегистрируйся: напиши `Имя Фамилия ДД.ММ`.', [['Профиль'], ['Назад']]);
          return res.json({ ok: true });
        } else {
        const activeMeetings = state.meetings.filter(m => m.status === 'scheduled');
        if (activeMeetings.length === 0) {
          replyText = 'На этой неделе активных встреч нет.';
        } else {
          replyText = '*Предстоящие встречи:*\n\n' + activeMeetings.map((m, idx) => {
            const typeStr = m.type === 'general' ? 'общая встреча' : 'локальное обсуждение';
            return `${idx + 1}. *${m.title}*\nДата: ${formatShortDate(m.date)}\nВремя: ${m.time}\nТип: ${typeStr}${m.topic ? `\nОписание: ${m.topic}` : ''}`;
          }).join('\n\n');
        }
        await sendTelegramKeyboard(chatId, replyText, [['Назначить собрание'], ['Назад']]);
        return res.json({ ok: true });
        }
      } else if (cmd.startsWith('/tasks') || cmd === 'задачи') {
        if (!user.registered) {
          replyText = 'Сначала зарегистрируйся: напиши `Имя Фамилия ДД.ММ`.';
        } else {
        const myTasks = state.tasks.filter(t => assignedIds(t).includes(user.id) && t.status !== 'completed');
        if (myTasks.length === 0) {
          replyText = 'У тебя нет активных задач. Открой Mini App, чтобы посмотреть общую доску задач.';
        } else {
          replyText = '*Твои активные задачи:*\n\n' + myTasks.map((t, idx) => {
            const workload = t.workload === 'high' ? 'высокая' : t.workload === 'medium' ? 'средняя' : 'низкая';
            return `${idx + 1}. *${t.title}*\nДедлайн: ${formatShortDate(t.deadline)}\nНагрузка: ${workload}\n${t.description}`;
          }).join('\n\n');
        }
        }
      } else if (cmd.startsWith('/help') || cmd === 'помощь') {
        replyText = '*Кнопки бота:*\n\n*Профиль* — регистрация или обновление имени и даты рождения.\n*Встречи* — список ближайших встреч.\n*Задачи* — твои активные задачи.\n\nMini App открывается системной кнопкой рядом с полем сообщения.\n\nДля регистрации напиши: `Имя Фамилия ДД.ММ`.';
      } else {
        replyText = user.registered
          ? 'Пользуйся кнопками снизу: приложение, профиль, встречи, задачи и помощь.'
          : 'Сначала зарегистрируйся: напиши `Имя Фамилия ДД.ММ`, например `Иван Кузнецов 12.10`.';
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

      await sendTelegramMessage(chatId, replyText, buttons);
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
      birthday: birthday || '01.01',
      registered: false
    };

    state.users.push(newUser);

    // Initialize empty message history with a welcome message
    state.messages[newUserId] = [
      {
        id: 'msg_welcome_' + Date.now(),
        userId: newUserId,
        sender: 'bot',
        text: `Привет, ${realName}! Тебя добавили в команду как ${role === 'admin' ? 'админа' : 'организатора'}.\n\nДата рождения: *${newUser.birthday}*. Открой Mini App, чтобы отметить свободные слоты.`,
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
    if (birthday) user.birthday = birthday;
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
        birthday: '01.01',
        registered: false,
        competencies: role === 'faculty_helper' ? cleanCompetencies : [],
        primaryCompetency: role === 'faculty_helper' ? cleanCompetencies[0] || '' : '',
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
    const assigneeIds = Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : [];
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
      workload: 'medium',
      weightValue: 2,
      createdAt: new Date().toISOString(),
      completedAt: '',
      reminders: cleanReminders,
    };
    state.tasks.push(task);
    for (const id of assigneeIds) {
      const target = state.users.find((u) => u.id === id);
      if (target?.telegramId) {
        await sendTelegramMessage(target.telegramId, `Новая задача от MEGABATTLE:\n\n${taskDetailsText(task, state)}\n\nЧтобы поменять статус, нажми «Мои задачи».`, undefined, false, target);
      }
    }
    saveDatabase(state);
    res.json({ success: true, task });
  });

  app.post('/api/faculty/task/update', (req, res) => {
    const { requesterId, taskId, title, description, deadline, assignedTo, reminders, facultyId, competency } = req.body;
    const state = loadDatabase();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    if (task.creatorId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать задачу может автор или админ' });
    }
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (deadline !== undefined) task.deadline = deadline;
    if (facultyId !== undefined) task.facultyId = facultyId;
    if (competency !== undefined) task.competency = String(competency || '').trim() || 'Факультет';
    if (Array.isArray(assignedTo)) task.assignedTo = assignedTo.filter(Boolean);
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
    saveDatabase(state);
    res.json({ success: true, task });
  });

  // Save/Update User Availability
  app.post('/api/availability', (req, res) => {
    const { userId, slots, weekStart, hardUnavailableDays } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, userId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    state.availabilities[userId] = {
      userId,
      slots,
      hardUnavailableDays: Array.isArray(hardUnavailableDays)
        ? [...new Set(hardUnavailableDays.map((day: unknown) => Number(day)).filter((day: number) => Number.isFinite(day) && day >= 0 && day < 35))]
        : [],
      weekStart: String(weekStart || ''),
      updatedAt: new Date().toISOString()
    };

    saveDatabase(state);
    res.json({ success: true, availability: state.availabilities[userId] });
  });

  // Schedule a new meeting
  app.post('/api/meeting', async (req, res) => {
    const { title, type, date, time, duration, hostId, participants, topic, description, competency } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, hostId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    const newMeeting = await createMeetingAndNotify(state, {
      title,
      type,
      date,
      time,
      duration,
      hostId,
      participants,
      topic,
      description,
      competency,
    });

    saveDatabase(state);
    res.json({ success: true, meeting: newMeeting });
  });

  app.post('/api/meeting/update', (req, res) => {
    const { requesterId, meetingId, title, type, date, time, duration, participants, topic, description, competency } = req.body;
    const state = loadDatabase();
    const meeting = state.meetings.find(m => m.id === meetingId);

    if (!meeting) return res.status(404).json({ error: 'Встреча не найдена' });
    if (meeting.hostId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Редактировать встречу может автор или админ' });
    }

    if (title) meeting.title = title;
    if (type) meeting.type = type;
    if (date) meeting.date = date;
    if (time) meeting.time = time;
    if (duration) meeting.duration = duration;
    if (participants) meeting.participants = participants;
    meeting.topic = topic || '';
    meeting.description = description || '';
    meeting.competency = competency || '';

    saveDatabase(state);
    res.json({ success: true, meeting });
  });

  app.post('/api/meeting/delete', (req, res) => {
    const { requesterId, meetingId } = req.body;
    const state = loadDatabase();
    const meeting = state.meetings.find(m => m.id === meetingId);

    if (!meeting) return res.status(404).json({ error: 'Встреча не найдена' });
    if (meeting.hostId !== requesterId && !isAdminUser(state, requesterId)) {
      return res.status(403).json({ error: 'Удалить встречу может автор или админ' });
    }

    meeting.status = 'cancelled';
    saveDatabase(state);
    res.json({ success: true, meeting });
  });

  // Create a new task
  app.post('/api/task/create', async (req, res) => {
    const { title, description, deadline, assignedTo, sow, tips, workload, creatorId, competency } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, creatorId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }
    if (!String(competency || '').trim()) {
      return res.status(400).json({ error: 'Укажи блок задачи' });
    }

    const weightMap = { low: 1, medium: 2, high: 3 };
    const assigneeIds = Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : assignedTo ? [assignedTo] : [];
    const now = new Date().toISOString();
    const newTask: Task = {
      id: 't_' + Date.now(),
      title,
      description,
      deadline,
      assignedTo: assigneeIds.length === 0 ? null : assigneeIds,
      creatorId,
      competency: String(competency).trim(),
      sow: sow || '',
      tips: tips || [],
      status: assigneeIds.length ? 'assigned' : 'open',
      workload: workload || 'medium',
      weightValue: weightMap[workload as 'low' | 'medium' | 'high'] || 2,
      createdAt: now,
      completedAt: '',
    };

    state.tasks.push(newTask);

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
          await sendTelegramMessage(
            assignedUser.telegramId,
            `Тебе назначена новая задача!\n\n${taskDetailsText(newTask, state)}`,
            [{ text: 'Открыть задачи', action: 'open_tasks' }],
          );
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
          await sendTelegramMessage(
            u.telegramId,
            `Клич о помощи: на доске появилась свободная задача.\n\n${taskDetailsText(newTask, state)}`,
            [{ text: 'Посмотреть задачу', action: `task_view:${newTask.id}` }],
          );
        }
      }
    }

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
    saveDatabase(state);

    const creator = state.users.find(u => u.id === task.creatorId);
    if (creator?.telegramId && creator.id !== user.id) {
      await sendTelegramMessage(creator.telegramId, `${userMention(user)} отказался от задачи *"${task.title}"*. Она снова на бирже.`);
    }

    for (const target of state.users.filter(u => u.telegramId && u.id !== user.id)) {
      await sendTelegramMessage(target.telegramId!, `Задача снова свободна:\n\n${taskDetailsText(task, state)}`, [{ text: 'Посмотреть задачу', action: `task_view:${task.id}` }]);
    }

    res.json({ success: true, task });
  });

  // Update task status (complete)
  app.post('/api/task/status', (req, res) => {
    const { taskId, status } = req.body;
    const state = loadDatabase();

    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });

    task.status = status;
    if (status === 'completed') task.completedAt = new Date().toISOString();
    if (status !== 'completed') task.completedAt = '';

    // If completed and was assigned to someone, notify admins
    if (status === 'completed' && task.assignedTo) {
      const workerName = assignedIds(task)
        .map((id) => state.users.find(u => u.id === id)?.realName)
        .filter(Boolean)
        .join(', ') || 'Участник';
      state.users.filter(u => u.role === 'admin').forEach(admin => {
        if (!state.messages[admin.id]) state.messages[admin.id] = [];
        state.messages[admin.id].push({
          id: 'task_comp_admin_' + Date.now() + '_' + admin.id,
          userId: admin.id,
          sender: 'bot',
          text: `Задача выполнена!\n*Блок:* ${task.competency || 'не указан'}\n*Исполнитель:* ${workerName}\n*Задача:* "${task.title}"`,
          timestamp: new Date().toISOString()
        });
      });
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
            <td>${escapeHtml(task.workload === 'high' ? 'Высокая' : task.workload === 'medium' ? 'Средняя' : 'Низкая')}</td>
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
                <th>Нагрузка</th>
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

    const windowScores: {
      day: number;
      hour: number;
      endHour: number;
      duration: number;
      count: number;
      hardUnavailableCount: number;
      users: string[];
    }[] = [];

    const durations = [3, 4, 5, 6, 7, 8, 2, 1];
    for (let d = 0; d < 7; d++) {
      const hardUnavailableUsers = state.users.filter((u) => alignedHardUnavailableDays(state.availabilities[u.id]).includes(d));
      for (const duration of durations) {
        for (let h = 16; h <= 24 - duration; h++) {
          const hoursWindow = Array.from({ length: duration }, (_, index) => h + index);
          const availableUsers = state.users
            .filter(u => {
              if (alignedHardUnavailableDays(state.availabilities[u.id]).includes(d)) return false;
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
              hardUnavailableCount: hardUnavailableUsers.length,
              users: availableUsers
            });
          }
        }
      }
    }

    windowScores.sort((a, b) => {
      return b.count - a.count
        || a.hardUnavailableCount - b.hardUnavailableCount
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
      const hardUnavailableUsers = state.users.filter(u => alignedHardUnavailableDays(state.availabilities[u.id]).includes(s.day));
      const missingUsers = state.users.filter(u => {
        if (alignedHardUnavailableDays(state.availabilities[u.id]).includes(s.day)) return true;
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
        total: state.users.length,
        users: s.users,
        missingUsers: missingUsers,
        hardUnavailableUsers: hardUnavailableUsers.map(u => ({
          id: u.id,
          realName: u.realName,
          username: u.username
        }))
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
          commands: [
            { command: 'start', description: 'Открыть Mini App' },
            { command: 'register', description: 'Зарегистрироваться в команде' },
            { command: 'meetings', description: 'Показать встречи' },
            { command: 'tasks', description: 'Показать мои задачи' },
            { command: 'help', description: 'Справка по боту' }
          ]
        })
      });

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    startTelegramLongPolling();
  });
}

startServer();





