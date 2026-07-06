import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { SimulationState, User, Availability, Meeting, Task, BotMessage } from './src/types.js';

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const DB_FILE = path.join(process.cwd(), 'database.json');

// Empty initial data. Real users are created through Telegram or added by admins.
const INITIAL_USERS: User[] = [];
const INITIAL_AVAILABILITIES: Record<string, Availability> = {};
const INITIAL_MEETINGS: Meeting[] = [];
const INITIAL_TASKS: Task[] = [];
const INITIAL_MESSAGES: Record<string, BotMessage[]> = {};

function createEmptyState(): SimulationState {
  return {
    users: [...INITIAL_USERS],
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

  return `*${task.title}*\n\n${task.description}\n\n*Автор:* ${userMention(creator)}\n*Срок:* ${formatShortDate(task.deadline)}\n*Исполнитель:* ${executorText}${task.sow ? `\n\n*ТЗ:* ${task.sow}` : ''}${task.tips?.length ? `\n\n*Подсказки:*\n${task.tips.map((tip) => `• ${tip}`).join('\n')}` : ''}`;
}

function meetingDetailsText(meeting: Meeting, state: SimulationState) {
  const host = state.users.find((user) => user.id === meeting.hostId);
  return `*${meeting.title}*\n\n*Дата:* ${formatShortDate(meeting.date)}\n*Время:* ${meeting.time}\n*Организатор:* ${userMention(host)}${meeting.competency ? `\n*Блок:* ${meeting.competency}` : ''}${meeting.topic ? `\n*Описание:* ${meeting.topic}` : ''}`;
}

function nextShortDate(daysAhead = 1) {
  const target = new Date();
  target.setDate(target.getDate() + daysAhead);
  return `${String(target.getDate()).padStart(2, '0')}.${String(target.getMonth() + 1).padStart(2, '0')}.${String(target.getFullYear()).slice(2)}`;
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
  if (!Array.isArray(state.competencies)) state.competencies = [];
  if (!state.availabilities) state.availabilities = {};
  if (!Array.isArray(state.meetings)) state.meetings = [];
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!state.messages) state.messages = {};

  state.users.forEach((user) => {
    if (!Array.isArray(user.competencies)) user.competencies = [];
  });
  state.meetings.forEach((meeting: any) => {
    if (meeting.competency === undefined) meeting.competency = '';
  });
  state.tasks.forEach((task: any) => {
    if (task.creatorId === undefined) task.creatorId = '';
    if (task.assignedTo === undefined) task.assignedTo = null;
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
  const chatSessions = new Map<string, { flow: string; competency?: string; participantIds?: string[] }>();

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
  function buildChatKeyboard(includeWebApp = true) {
    const webAppUrl = process.env.WEBAPP_URL;
    const keyboard: any[] = [];

    if (includeWebApp && webAppUrl) {
      keyboard.push([{ text: 'Открыть приложение', web_app: { url: webAppUrl } }]);
    }

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

  function buildKeyboard(rows: string[][], includeWebApp = false) {
    const webAppUrl = process.env.WEBAPP_URL;
    const keyboard: any[] = [];
    if (includeWebApp && webAppUrl) {
      keyboard.push([{ text: 'Открыть приложение', web_app: { url: webAppUrl } }]);
    }
    rows.forEach((row) => keyboard.push(row.map((text) => ({ text }))));
    return { keyboard, resize_keyboard: true, is_persistent: true };
  }

  async function sendTelegramKeyboard(chatId: string | number, text: string, rows: string[][], includeWebApp = false) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    await fetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: buildKeyboard(rows, includeWebApp),
      }),
    });
  }

  async function answerCallback(callbackQueryId: string, text?: string) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) return;
    const tgApiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
    await fetch(`${tgApiBase}/bot${botToken}/answerCallbackQuery`, {
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

  async function sendTelegramMessage(chatId: string | number, text: string, buttons?: { text: string; action: string }[], keyboardOnly = false) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!botToken) {
      console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram message was not sent.');
      return;
    }
    const webAppUrl = process.env.WEBAPP_URL;

    let replyMarkup: any = buildChatKeyboard();
    if (keyboardOnly) {
      replyMarkup = buildChatKeyboard(false);
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
      await fetch(`${tgApiBase}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown',
          reply_markup: Object.keys(replyMarkup).length > 0 ? replyMarkup : undefined
        })
      });
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

  // Get or create user inside Telegram WebApp
  app.post('/api/user/get-or-create', (req, res) => {
    const { telegramId, username, first_name, last_name } = req.body;
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }

    const state = loadDatabase();

    let user = state.users.find(u => u.telegramId === String(telegramId));
    if (!user && username) {
      user = state.users.find(u => u.username.toLowerCase() === `@${username.toLowerCase()}`);
    }

    if (!user) {
      const newUserId = 'u_' + Date.now();
      const sanitizedUsername = username ? `@${username}` : `@tg_${telegramId}`;
      const realName = first_name + (last_name ? ' ' + last_name : '');
      user = {
        id: newUserId,
        username: sanitizedUsername,
        realName,
        role: getRoleForTelegramUser(telegramId, username),
        avatarSeed: (username || 'user').toLowerCase(),
        birthday: '01.01',
        telegramId: String(telegramId),
        registered: false
      };
      state.users.push(user);
      state.messages[newUserId] = [];
      saveDatabase(state);
    } else {
      let changed = false;
      if (!user.telegramId) {
        user.telegramId = String(telegramId);
        changed = true;
      }
      if (username && user.username !== `@${username}`) {
        user.username = `@${username}`;
        changed = true;
      }
      if (changed) {
        saveDatabase(state);
      }
      const envRole = getRoleForTelegramUser(telegramId, username);
      if (envRole === 'admin' && user.role !== 'admin') {
        user.role = 'admin';
        saveDatabase(state);
      }
      if (user.registered === undefined) {
        user.registered = false;
        saveDatabase(state);
      }
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
      const response = await fetch(`${tgApiBase}/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
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
        if (creator?.telegramId && creator.id !== user.id) {
          await sendTelegramMessage(creator.telegramId, `Задачу *"${task.title}"* подхватил ${userMention(user)}.\n\nСвязаться: ${user.username}`);
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

      let user = state.users.find(u => u.telegramId === String(fromUser.id));
      if (!user && fromUser.username) {
        user = state.users.find(u => u.username.toLowerCase() === `@${fromUser.username.toLowerCase()}`);
      }

      if (!user) {
        const newUserId = 'u_' + Date.now();
        user = {
          id: newUserId,
          username: fromUser.username ? `@${fromUser.username}` : `@tg_${fromUser.id}`,
          realName: fromUser.first_name + (fromUser.last_name ? ' ' + fromUser.last_name : ''),
          role: getRoleForTelegramUser(fromUser.id, fromUser.username),
          avatarSeed: (fromUser.username || 'user').toLowerCase(),
          birthday: '01.01',
          telegramId: String(fromUser.id),
          registered: false
        };
        state.users.push(user);
        state.messages[newUserId] = [];
      } else if (!user.telegramId) {
        user.telegramId = String(fromUser.id);
      }
      if (user.registered === undefined) {
        user.registered = false;
      }
      const envRole = getRoleForTelegramUser(fromUser.id, fromUser.username);
      if (envRole === 'admin' && user.role !== 'admin') {
        user.role = 'admin';
      }

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

      if (normalizedText === 'назад' || normalizedText === 'меню') {
        const currentSession = chatSessions.get(chatKey);
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
        const freshState = loadDatabase();
        const meeting = await createMeetingAndNotify(freshState, {
          title: 'Общее собрание',
          type: 'general',
          date: nextShortDate(1),
          time: '18:00',
          hostId: user.id,
          participants: 'all',
        });
        saveDatabase(freshState);
        chatSessions.delete(chatKey);
        await sendTelegramKeyboard(chatId, `Готово, назначил общее собрание:\n\n${meetingDetailsText(meeting, freshState)}`, [['Назначить собрание'], ['Назад']], true);
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

      const session = chatSessions.get(chatKey);
      if (session?.flow === 'meeting_pick_competency') {
        const freshState = loadDatabase();
        const competency = (freshState.competencies || []).find((item) => item.toLowerCase() === normalizedText);
        if (competency) {
          const members = freshState.users.filter((member) => member.competencies?.includes(competency));
          const memberText = members.length
            ? members.map((member) => `• ${userMention(member)}`).join('\n')
            : 'В этом блоке пока никого нет.';
          chatSessions.set(chatKey, { flow: 'meeting_confirm_competency', competency, participantIds: members.map((member) => member.id) });
          await sendTelegramKeyboard(chatId, `Выбран блок *${competency}*.\n\nУчастники:\n${memberText}`, [['Подтвердить'], ['Назад']]);
          return res.json({ ok: true });
        }
      }

      if (session?.flow === 'meeting_confirm_competency' && normalizedText === 'подтвердить') {
        const freshState = loadDatabase();
        const participantIds = session.participantIds || [];
        if (participantIds.length === 0) {
          await sendTelegramKeyboard(chatId, 'В этом блоке нет участников. Выбери другой блок.', [['Выбрать блок'], ['Назад']]);
          return res.json({ ok: true });
        }
        const meeting = await createMeetingAndNotify(freshState, {
          title: `Собрание блока ${session.competency}`,
          type: 'custom',
          date: nextShortDate(1),
          time: '18:00',
          hostId: user.id,
          participants: participantIds,
          competency: session.competency,
        });
        saveDatabase(freshState);
        chatSessions.delete(chatKey);
        await sendTelegramKeyboard(chatId, `Готово, назначил собрание блока:\n\n${meetingDetailsText(meeting, freshState)}`, [['Назначить собрание'], ['Назад']], true);
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
        replyText = '*Кнопки бота:*\n\n*Открыть приложение* — Mini App со слотами, встречами, задачами и командой.\n*Профиль* — регистрация или обновление имени и даты рождения.\n*Встречи* — список ближайших встреч.\n*Задачи* — твои активные задачи.\n\nДля регистрации напиши: `Имя Фамилия ДД.ММ`.';
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
    const { requesterId, userId, realName, username, role, birthday, competencies } = req.body;
    const state = loadDatabase();

    const selfEditOnly = requesterId === userId && !realName && !username && !role && !birthday && Array.isArray(competencies);
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
    });
    saveDatabase(state);
    res.json({ success: true, competencies: state.competencies });
  });

  // Save/Update User Availability
  app.post('/api/availability', (req, res) => {
    const { userId, slots } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, userId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    state.availabilities[userId] = {
      userId,
      slots,
      updatedAt: new Date().toISOString()
    };

    saveDatabase(state);
    res.json({ success: true, availability: state.availabilities[userId] });
  });

  // Schedule a new meeting
  app.post('/api/meeting', async (req, res) => {
    const { title, type, date, time, duration, hostId, participants, topic, competency } = req.body;
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
      competency,
    });

    saveDatabase(state);
    res.json({ success: true, meeting: newMeeting });
  });

  app.post('/api/meeting/update', (req, res) => {
    const { requesterId, meetingId, title, type, date, time, duration, participants, topic, competency } = req.body;
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
    const { title, description, deadline, assignedTo, sow, tips, workload, creatorId } = req.body;
    const state = loadDatabase();

    if (!isRegisteredUser(state, creatorId)) {
      return res.status(403).json({ error: 'Сначала нужно зарегистрироваться в чате с ботом' });
    }

    const weightMap = { low: 1, medium: 2, high: 3 };
    const assigneeIds = Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : assignedTo ? [assignedTo] : [];
    const newTask: Task = {
      id: 't_' + Date.now(),
      title,
      description,
      deadline,
      assignedTo: assigneeIds.length === 0 ? null : assigneeIds,
      creatorId,
      sow: sow || '',
      tips: tips || [],
      status: assigneeIds.length ? 'assigned' : 'open',
      workload: workload || 'medium',
      weightValue: weightMap[workload as 'low' | 'medium' | 'high'] || 2
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
      text: `Ты закрепил за собой задачу: *"${task.title}"*\nДедлайн: ${formatShortDate(task.deadline)}.\nТЗ можно проверить в Mini App.`,
      timestamp: new Date().toISOString()
    });

    const creator = state.users.find(u => u.id === task.creatorId);
    if (creator && creator.id !== userId) {
      if (!state.messages[creator.id]) state.messages[creator.id] = [];
      const text = `*${user.realName}* взял задачу с доски:\n*"${task.title}"*\n\nСвязаться: ${user.username}`;
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
          text: `Задача выполнена!\n*Исполнитель:* ${workerName}\n*Задача:* "${task.title}"`,
          timestamp: new Date().toISOString()
        });
      });
    }

    saveDatabase(state);
    res.json({ success: true, task });
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
      users: string[];
    }[] = [];

    const durations = [8, 7, 6, 5, 4, 3, 2, 1];
    for (let d = 0; d < 7; d++) {
      for (const duration of durations) {
        for (let h = 16; h <= 24 - duration; h++) {
          const hoursWindow = Array.from({ length: duration }, (_, index) => h + index);
          const availableUsers = state.users
            .filter(u => {
              const daySlots = state.availabilities[u.id]?.slots?.[d] || [];
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
              users: availableUsers
            });
          }
        }
      }
    }

    windowScores.sort((a, b) => {
      const scoreA = a.count * a.duration;
      const scoreB = b.count * b.duration;
      return scoreB - scoreA || b.count - a.count || b.duration - a.duration || a.day - b.day || a.hour - b.hour;
    });

    const bestByDay = new Map<number, typeof windowScores[number]>();
    for (const slot of windowScores) {
      if (!bestByDay.has(slot.day)) bestByDay.set(slot.day, slot);
    }
    const picked = [...bestByDay.values()].slice(0, 5);

    const russianDays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

    const suggestions = picked.map(s => {
      const hoursWindow = Array.from({ length: s.duration }, (_, index) => s.hour + index);
      const missingUsers = state.users.filter(u => {
        const daySlots = state.availabilities[u.id]?.slots?.[s.day] || [];
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
        missingUsers: missingUsers
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
      const response = await fetch(`${tgApiBase}/bot${botToken}/deleteWebhook`);
      const data = await response.json();
      console.log('Telegram webhook deletion result:', data);
    } catch (err: any) {
      console.error('Failed to delete Telegram webhook:', err.message);
    }

    try {
      await fetch(`${tgApiBase}/bot${botToken}/setMyCommands`, {
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

      if (webAppUrl) {
        await fetch(`${tgApiBase}/bot${botToken}/setChatMenuButton`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            menu_button: {
              type: 'web_app',
              text: 'Открыть приложение',
              web_app: { url: webAppUrl }
            }
          })
        });
      }
      console.log('Telegram commands and Mini App menu configured.');
    } catch (err: any) {
      console.error('Failed to configure Telegram commands/menu:', err.message);
    }

    await sendDueBirthdayReminders();
    await sendSundayAvailabilityReminders();
    setInterval(() => {
      sendDueBirthdayReminders().catch((err) => {
        console.error('Birthday reminder check failed:', err.message);
      });
      sendSundayAvailabilityReminders().catch((err) => {
        console.error('Sunday availability reminder check failed:', err.message);
      });
    }, 24 * 60 * 60 * 1000);

    console.log('Telegram long polling started.');
    let offset = 0;

    const poll = async () => {
      try {
        const response = await fetch(`${tgApiBase}/bot${botToken}/getUpdates?offset=${offset}&timeout=30`);
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





