import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-core-'));
const appPort = 31847;
const botToken = 'integration-test-token';
const telegramCalls = [];
let nextTelegramMessageId = 1000;
let sessionCookie = '';

const fixture = {
  users: [
    {
      id: 'u_admin',
      username: '@admin',
      realName: 'Администратор',
      role: 'admin',
      avatarSeed: 'admin',
      telegramId: '100',
      registered: true,
      birthday: '15.04.1998',
      competencies: ['Дизайн'],
      primaryCompetency: 'Дизайн',
      facultyId: '',
    },
    {
      id: 'u_alice',
      username: '@alice',
      realName: 'Алиса Командная',
      role: 'organizer',
      avatarSeed: 'alice',
      registered: false,
      birthday: '09.11.2000',
      competencies: ['Дизайн'],
      primaryCompetency: 'Дизайн',
      facultyId: '',
    },
    {
      id: 'u_bob',
      username: '@bob',
      realName: 'Борис Командный',
      role: 'organizer',
      avatarSeed: 'bob',
      telegramId: '300',
      registered: true,
      birthday: '21.02',
      competencies: [],
      primaryCompetency: '',
      facultyId: '',
    },
    {
      id: 'u_faculty',
      username: '@faculty',
      realName: 'Факультетский Ответственный',
      role: 'faculty_responsible',
      avatarSeed: 'faculty',
      telegramId: '400',
      registered: true,
      birthday: '03.06.2001',
      competencies: ['Дизайн'],
      primaryCompetency: 'Дизайн',
      facultyId: 'fac_test',
    },
  ],
  faculties: [{ id: 'fac_test', name: 'Тестовый факультет' }],
  facultyCompetencies: ['Дизайн'],
  competencies: ['Дизайн'],
  availabilities: {},
  meetings: [],
  tasks: [],
  messages: {},
};

function telegramInitData(user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `test-${user.id}`,
    user: JSON.stringify(user),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function currentWeekStart() {
  const today = new Date();
  const day = today.getDay() === 0 ? 6 : today.getDay() - 1;
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(today.getDate() - day);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

async function request(pathname, body) {
  const response = await fetch(`http://127.0.0.1:${appPort}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const health = await fetch(`http://127.0.0.1:${appPort}/api/health`);
      if (health.ok) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
}

const fakeTelegram = http.createServer((req, res) => {
  let rawBody = '';
  req.on('data', (chunk) => {
    rawBody += chunk;
  });
  req.on('end', () => {
    const resultMessageId = req.url.endsWith('/sendMessage') ? nextTelegramMessageId++ : undefined;
    telegramCalls.push({
      path: req.url,
      body: rawBody ? JSON.parse(rawBody) : {},
      resultMessageId,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      result: resultMessageId
        ? { message_id: resultMessageId, chat: { id: 1 }, text: '' }
        : true,
    }));
  });
});

await new Promise((resolve) => fakeTelegram.listen(0, '127.0.0.1', resolve));
const telegramPort = fakeTelegram.address().port;
let appProcess;

try {
  const testDatabasePath = path.join(tempRoot, 'database.json');
  await writeFile(testDatabasePath, JSON.stringify(fixture, null, 2), 'utf8');

  appProcess = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ALLOW_LOCAL_PREVIEW: 'false',
      PORT: String(appPort),
      DB_FILE: testDatabasePath,
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
      WEBAPP_URL: 'https://dead-tunnel.lhr.life',
      DISABLE_TELEGRAM_POLLING: 'true',
      ADMIN_USERNAMES: '@admin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverErrors = '';
  appProcess.stderr.on('data', (chunk) => {
    serverErrors += chunk.toString();
  });
  await waitForServer();
  for (let attempt = 0; attempt < 50 && !telegramCalls.some((call) => call.path.endsWith('/setMyDescription')); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/setMyDescription')));
  assert.ok(telegramCalls.some((call) => (
    call.path.endsWith('/setChatMenuButton')
    && call.body.menu_button?.web_app?.url === 'https://megaorgiabot.ru'
  )));

  const protectedState = await request('/api/state');
  assert.equal(protectedState.response.status, 401);

  const aliceTelegram = { id: 200, username: 'alice', first_name: 'Алиса' };
  const aliceAuth = await request('/api/user/get-or-create', {
    telegramId: '200',
    username: 'alice',
    initData: telegramInitData(aliceTelegram),
  });
  assert.equal(aliceAuth.response.status, 200);
  assert.equal(aliceAuth.data.user.id, 'u_alice');
  assert.equal(aliceAuth.data.user.realName, 'Алиса Командная');
  assert.equal(aliceAuth.data.user.registered, true);
  assert.equal(aliceAuth.data.user.birthday, '09.11.2000');
  sessionCookie = aliceAuth.response.headers.get('set-cookie').split(';')[0];

  const duplicateClaim = await request('/api/user/get-or-create', {
    telegramId: '201',
    username: 'alice',
    initData: telegramInitData({ id: 201, username: 'alice' }),
  });
  assert.equal(duplicateClaim.response.status, 403);

  const unknownAuth = await request('/api/user/get-or-create', {
    telegramId: '999',
    username: 'unknown',
    initData: telegramInitData({ id: 999, username: 'unknown' }),
  });
  assert.equal(unknownAuth.response.status, 403);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 200 },
      from: aliceTelegram,
      text: '/start',
    },
  });
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/deleteMessage')));
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/sendMessage')));
  const menuButtonCall = telegramCalls.find((call) => call.path.endsWith('/setChatMenuButton'));
  assert.equal(menuButtonCall.body.menu_button.web_app.url, 'https://megaorgiabot.ru');
  assert.equal(menuButtonCall.body.menu_button.text, 'Начать');
  assert.ok(!telegramCalls.some((call) => String(call.body.text || '').includes('меняет администратор')));
  const startMenuCall = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.ok(String(startMenuCall.body.text).includes('MegaBot'));
  const startMenuButtons = startMenuCall.body.reply_markup.keyboard.flat().map((button) => button.text);
  assert.ok(startMenuButtons.includes('Профиль'));
  assert.ok(!startMenuButtons.includes('Команда'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 100,
    message: {
      message_id: 100,
      chat: { id: 100, type: 'private' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/start',
    },
  });
  const adminMenuCall = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.deepEqual(adminMenuCall.body.reply_markup.keyboard.map((row) => row.length), [2, 2, 2]);
  assert.deepEqual(
    adminMenuCall.body.reply_markup.keyboard.flat().map((button) => button.text),
    ['Профиль', 'Слоты', 'Встречи', 'Задачи', 'МФ', 'Помощь'],
  );

  const aliceSessionBeforeAdmin = sessionCookie;
  const adminAuth = await request('/api/user/get-or-create', {
    telegramId: '100',
    username: 'admin',
    initData: telegramInitData({ id: 100, username: 'admin', first_name: 'Админ' }),
  });
  assert.equal(adminAuth.response.status, 200);
  sessionCookie = adminAuth.response.headers.get('set-cookie').split(';')[0];
  const promoteBob = await request('/api/user/update', {
    requesterId: 'u_admin',
    userId: 'u_bob',
    realName: 'Борис Командный',
    username: '@bob',
    role: 'admin',
    birthday: '21.02',
    competencies: [],
    primaryCompetency: '',
  });
  assert.equal(promoteBob.response.status, 200);
  assert.equal(promoteBob.data.user.role, 'admin');
  const restoreBob = await request('/api/user/update', {
    requesterId: 'u_admin',
    userId: 'u_bob',
    realName: 'Борис Командный',
    username: '@bob',
    role: 'organizer',
    birthday: '21.02',
    competencies: [],
    primaryCompetency: '',
  });
  assert.equal(restoreBob.response.status, 200);

  telegramCalls.length = 0;
  const horizonNotification = await request('/api/availability/weeks', {
    requesterId: 'u_admin',
    weeks: 3,
    notifyTeam: true,
  });
  assert.equal(horizonNotification.response.status, 200);
  assert.equal(horizonNotification.data.notified, 3);
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/sendMessage') && String(call.body.chat_id) === '100'));
  sessionCookie = aliceSessionBeforeAdmin;

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 101,
    message: {
      message_id: 101,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Встречи',
    },
  });
  const meetingsMenu = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  const meetingsButtons = meetingsMenu.body.reply_markup.keyboard.flat().map((button) => button.text);
  assert.deepEqual(meetingsButtons, ['Назначить собрание', 'Назад']);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 102,
    message: {
      message_id: 102,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Назад',
    },
  });
  const menuAfterMeetings = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.ok(menuAfterMeetings.body.reply_markup.keyboard.flat().some((button) => button.text === 'Профиль'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 103,
    message: {
      message_id: 103,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Задачи',
    },
  });
  const tasksMenu = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  const tasksButtons = tasksMenu.body.reply_markup.keyboard.flat().map((button) => button.text);
  assert.ok(tasksButtons.includes('Назад'));
  assert.ok(!tasksButtons.includes('Профиль'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 104,
    message: {
      message_id: 104,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Свободные задачи',
    },
  });
  const openTasksPanel = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.inline_keyboard);
  assert.ok(openTasksPanel.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'nav_tasks' && button.text === 'Назад'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 105,
    callback_query: {
      id: 'back-to-tasks',
      from: aliceTelegram,
      data: 'nav_tasks',
      message: { message_id: 999, chat: { id: 200, type: 'private' } },
    },
  });
  const tasksMenuAfterBack = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.ok(tasksMenuAfterBack.body.reply_markup.keyboard.flat().some((button) => button.text === 'Свободные задачи'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 106,
    message: {
      message_id: 106,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Выполненные задачи',
    },
  });
  const completedTasksMenu = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.deepEqual(completedTasksMenu.body.reply_markup.keyboard.flat().map((button) => button.text), ['Назад']);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 11,
    message: {
      message_id: 11,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Слоты',
    },
  });
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/deleteMessage')));
  assert.ok(telegramCalls.some((call) => (
    call.path.endsWith('/sendMessage')
    && String(call.body.text || '').includes('Мои слоты')
    && call.body.reply_markup?.inline_keyboard
  )));
  const slotsSendCall = telegramCalls.find((call) => (
    call.path.endsWith('/sendMessage') && call.body.reply_markup?.inline_keyboard
  ));
  const slotsPanelId = slotsSendCall.resultMessageId;

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 111,
    callback_query: {
      id: 'stale-slots-day',
      from: aliceTelegram,
      data: 'slots_day:2',
      message: { message_id: slotsPanelId - 1, chat: { id: 200, type: 'private' } },
    },
  });
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/deleteMessage') && call.body.message_id === slotsPanelId - 1));
  assert.ok(!telegramCalls.some((call) => call.path.endsWith('/editMessageText')));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 12,
    callback_query: {
      id: 'slots-day',
      from: aliceTelegram,
      data: 'slots_day:2',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const dayPanelEdit = telegramCalls.find((call) => call.path.endsWith('/editMessageText'));
  assert.equal(dayPanelEdit.body.message_id, slotsPanelId);
  assert.ok(dayPanelEdit.body.reply_markup.inline_keyboard.flat().some((button) => button.text === 'Выбрать весь день'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 130,
    callback_query: {
      id: 'slots-whole-day',
      from: aliceTelegram,
      data: 'slot_toggle_day:2',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const wholeDayEdit = telegramCalls.find((call) => call.path.endsWith('/editMessageText'));
  assert.ok(wholeDayEdit);
  const slotDraftState = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.deepEqual(slotDraftState.slotDrafts['200'].slots['2'], [16, 17, 18, 19, 20, 21, 22, 23]);
  assert.ok(wholeDayEdit.body.reply_markup.inline_keyboard.flat().some((button) => button.text === 'Снять весь день'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 13,
    callback_query: {
      id: 'slots-hour',
      from: aliceTelegram,
      data: 'slot_toggle:2:23',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/editMessageText')));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 131,
    callback_query: {
      id: 'slots-back-to-days',
      from: aliceTelegram,
      data: 'nav_slots',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const slotsDaysCall = telegramCalls.find((call) => call.path.endsWith('/editMessageText'));
  assert.ok(slotsDaysCall);
  assert.ok(slotsDaysCall.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'slots_day:2' && button.text === 'Ср · 7/8'));
  assert.ok(String(slotsDaysCall.body.text || '').includes('Ср:'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 14,
    callback_query: {
      id: 'slots-save',
      from: aliceTelegram,
      data: 'slot_save',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const slotsSavedMenu = telegramCalls.find((call) => call.path.endsWith('/editMessageText'));
  assert.ok(slotsSavedMenu);
  const slotsSavedButtons = slotsSavedMenu.body.reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.ok(slotsSavedButtons.includes('Профиль'));
  assert.ok(slotsSavedButtons.includes('Изменить слоты'));
  const slotsSavedDatabase = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.deepEqual(slotsSavedDatabase.availabilities.u_alice.slots['2'], [16, 17, 18, 19, 20, 21, 22]);
  const slotsSavedUiState = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.equal(slotsSavedUiState.slotDrafts['200'], undefined);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 141,
    message: {
      message_id: 141,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Слоты',
    },
  });
  const reopenedSlots = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.inline_keyboard);
  assert.ok(reopenedSlots);
  assert.ok(reopenedSlots.body.reply_markup.inline_keyboard.flat().some((button) => button.text === 'Ср · 7/8'));
  assert.ok(String(reopenedSlots.body.text).includes('Ср: 16:00, 17:00, 18:00, 19:00, 20:00, 21:00, 22:00'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 2,
    message: {
      message_id: 2,
      chat: { id: 999 },
      from: { id: 999, username: 'unknown', first_name: 'Неизвестный' },
      text: '/start',
    },
  });
  assert.ok(telegramCalls.some((call) => (
    call.path.endsWith('/sendMessage')
    && call.body.text.includes('нет в списке участников')
  )));

  const availability = await request('/api/availability', {
    userId: 'u_alice',
    weekStart: '2030-01-07',
    slots: { 0: [18, 19] },
    hardUnavailableDays: [1, 2, 2, 99, 'bad'],
  });
  assert.equal(availability.response.status, 200);
  assert.deepEqual(availability.data.availability.hardUnavailableDays, [1, 2]);

  telegramCalls.length = 0;
  const taskResult = await request('/api/task/create', {
    title: 'Проверка уведомлений',
    description: 'Интеграционный сценарий',
    deadline: '2030-01-01',
    assignedTo: ['u_alice', 'u_bob', 'u_alice', 'missing'],
    creatorId: 'u_admin',
    competency: 'Дизайн',
    priority: 'critical',
  });
  assert.equal(taskResult.response.status, 200);
  assert.deepEqual(taskResult.data.task.assignedTo, ['u_alice', 'u_bob']);
  assert.equal(taskResult.data.task.priority, 'critical');
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 2);

  telegramCalls.length = 0;
  const openTaskResult = await request('/api/task/create', {
    title: 'Открытая задача автора',
    description: 'Проверка уведомления самому автору',
    deadline: '2030-01-05',
    assignedTo: [],
    creatorId: 'u_alice',
    competency: 'Дизайн',
    priority: 'important',
  });
  assert.equal(openTaskResult.response.status, 200);
  telegramCalls.length = 0;
  const selfClaim = await request('/api/task/claim', {
    taskId: openTaskResult.data.task.id,
    userId: 'u_alice',
  });
  assert.equal(selfClaim.response.status, 200);
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/sendMessage') && String(call.body.chat_id) === '200'));

  const editedTask = await request('/api/task/update', {
    requesterId: 'u_alice',
    taskId: openTaskResult.data.task.id,
    title: 'Открытая задача — обновлено',
    description: 'Добавили принудительного исполнителя и напоминание',
    deadline: '2030-01-06',
    assignedTo: ['u_alice', 'u_bob'],
    reminders: [{ type: 'before_deadline', value: 2, unit: 'days' }],
  });
  assert.equal(editedTask.response.status, 200);
  assert.deepEqual(editedTask.data.task.assignedTo, ['u_alice', 'u_bob']);
  assert.equal(editedTask.data.task.reminders.length, 1);

  const executorComment = await request('/api/task/comment', {
    requesterId: 'u_alice',
    taskId: openTaskResult.data.task.id,
    assigneeId: 'u_alice',
    side: 'executor',
    text: 'Собираю материалы',
  });
  assert.equal(executorComment.response.status, 200);
  assert.equal(executorComment.data.task.assigneeNotes.u_alice.executor, 'Собираю материалы');
  const coordinatorComment = await request('/api/task/comment', {
    requesterId: 'u_alice',
    taskId: openTaskResult.data.task.id,
    assigneeId: 'u_bob',
    side: 'coordinator',
    text: 'Борис отвечает за проверку',
  });
  assert.equal(coordinatorComment.response.status, 200);
  assert.equal(coordinatorComment.data.task.assigneeNotes.u_bob.coordinator, 'Борис отвечает за проверку');

  const manualReminder = await request('/api/task/notify', {
    requesterId: 'u_alice',
    taskId: openTaskResult.data.task.id,
  });
  assert.equal(manualReminder.response.status, 200);
  assert.equal(manualReminder.data.queued, 2);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 107,
    callback_query: {
      id: 'complete-with-time',
      from: aliceTelegram,
      data: `task_complete:${openTaskResult.data.task.id}`,
      message: { message_id: 1007, chat: { id: 200, type: 'private' } },
    },
  });
  const completionTimeMenu = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.ok(completionTimeMenu.body.reply_markup.keyboard.flat().some((button) => button.text === 'Не указывать'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 108,
    message: {
      message_id: 108,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: '30 минут',
    },
  });
  const completionCommentMenu = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.ok(String(completionCommentMenu.body.text || '').includes('короткий комментарий'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 109,
    message: {
      message_id: 109,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Заняло дольше из-за согласования макета',
    },
  });
  const afterChatCompletion = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  const completedChatTask = afterChatCompletion.tasks.find((task) => task.id === openTaskResult.data.task.id);
  assert.equal(completedChatTask.timeSpentMinutes, 30);
  assert.equal(completedChatTask.completionComments.u_alice, 'Заняло дольше из-за согласования макета');

  telegramCalls.length = 0;
  const meetingResult = await request('/api/meeting', {
    title: 'Общая встреча',
    type: 'general',
    date: '2030-01-02',
    time: '18:00',
    duration: 2,
    hostId: 'u_admin',
    participants: 'all',
    topic: 'Проверка',
    description: '',
  });
  assert.equal(meetingResult.response.status, 200);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 3);
  assert.ok(!telegramCalls.some((call) => call.body.chat_id === '400'));

  const declineMeeting = await request('/api/meeting/rsvp', {
    requesterId: 'u_alice',
    meetingId: meetingResult.data.meeting.id,
    attending: false,
  });
  assert.equal(declineMeeting.response.status, 200);
  assert.equal(declineMeeting.data.attending, false);
  const attendMeeting = await request('/api/meeting/rsvp', {
    requesterId: 'u_alice',
    meetingId: meetingResult.data.meeting.id,
    attending: true,
  });
  assert.equal(attendMeeting.response.status, 200);
  assert.equal(attendMeeting.data.attending, true);
  assert.ok(attendMeeting.data.meeting.attendeeIds.includes('u_alice'));

  telegramCalls.length = 0;
  const meetingUpdate = await request('/api/meeting/update', {
    requesterId: 'u_admin',
    meetingId: meetingResult.data.meeting.id,
    time: '19:00',
    participants: ['u_alice'],
  });
  assert.equal(meetingUpdate.response.status, 200);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 3);

  telegramCalls.length = 0;
  const meetingDelete = await request('/api/meeting/delete', {
    requesterId: 'u_admin',
    meetingId: meetingResult.data.meeting.id,
  });
  assert.equal(meetingDelete.response.status, 200);
  assert.equal(meetingDelete.data.meeting.status, 'cancelled');
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 1);

  telegramCalls.length = 0;
  const completed = await request('/api/task/status', {
    requesterId: 'u_alice',
    taskId: taskResult.data.task.id,
    status: 'completed',
    timeSpentMinutes: 95,
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.data.task.timeSpentMinutes, 95);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 1);
  assert.equal(telegramCalls.find((call) => call.path.endsWith('/sendMessage')).body.chat_id, '100');
  const taskExportResponse = await fetch(`http://127.0.0.1:${appPort}/api/task/export`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(taskExportResponse.status, 200);
  assert.ok((await taskExportResponse.text()).includes('1 ч 35 мин'));

  const aliceSessionCookie = sessionCookie;
  const facultyAuth = await request('/api/user/get-or-create', {
    telegramId: '400',
    username: 'faculty',
    initData: telegramInitData({ id: 400, username: 'faculty' }),
  });
  assert.equal(facultyAuth.response.status, 200);
  assert.equal(facultyAuth.data.externalOnly, true);
  sessionCookie = facultyAuth.response.headers.get('set-cookie').split(';')[0];
  const forbiddenStatus = await request('/api/task/status', {
    requesterId: 'u_faculty',
    taskId: taskResult.data.task.id,
    status: 'completed',
  });
  assert.equal(forbiddenStatus.response.status, 403);
  sessionCookie = aliceSessionCookie;

  telegramCalls.length = 0;
  const facultyTask = await request('/api/faculty/task/create', {
    requesterId: 'u_admin',
    facultyId: 'fac_test',
    competency: 'Дизайн',
    title: 'Факультетская задача',
    description: 'Проверка уведомлений факультета',
    deadline: '2030-01-03',
    assignedTo: ['u_faculty', 'u_alice', 'missing'],
    reminders: [],
  });
  assert.equal(facultyTask.response.status, 200);
  assert.deepEqual(facultyTask.data.task.assignedTo, ['u_faculty']);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 1);

  telegramCalls.length = 0;
  const facultyTaskUpdate = await request('/api/faculty/task/update', {
    requesterId: 'u_admin',
    taskId: facultyTask.data.task.id,
    assignedTo: [],
  });
  assert.equal(facultyTaskUpdate.response.status, 200);
  assert.equal(facultyTaskUpdate.data.task.assignedTo, null);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 1);
  assert.ok(telegramCalls.some((call) => call.body.text.includes('больше не исполнитель')));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 20,
    message: {
      message_id: 20,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/bindteamchat',
    },
  });
  assert.ok(telegramCalls.some((call) => (
    call.path.endsWith('/sendMessage')
    && String(call.body.text || '').includes('Чат привязан')
  )));
  const boundChatCommandsCall = telegramCalls.find((call) => (
    call.path.endsWith('/setMyCommands')
    && call.body.scope?.type === 'chat'
    && call.body.scope?.chat_id === -100500
  ));
  assert.ok(boundChatCommandsCall);
  assert.deepEqual(
    boundChatCommandsCall.body.commands.map((command) => command.command),
    ['all', 'meeting', 'deadlines', 'slots', 'birthdays', 'checkin', 'help'],
  );
  assert.ok(!boundChatCommandsCall.body.commands.some((command) => command.command === 'start'));

  const oneDayAvailability = await request('/api/availability', {
    userId: 'u_alice',
    weekStart: currentWeekStart(),
    slots: { 2: [18] },
    hardUnavailableDays: [],
  });
  assert.equal(oneDayAvailability.response.status, 200);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 201,
    message: {
      message_id: 201,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/slots',
    },
  });
  const missingSlotsMessage = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.ok(missingSlotsMessage);
  assert.ok(!String(missingSlotsMessage.body.text || '').includes('@alice'));
  assert.ok(String(missingSlotsMessage.body.text || '').includes('@admin'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 21,
    message: {
      message_id: 21,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 200, username: 'alice', first_name: 'Алиса' },
      text: '/all Сбор команды',
    },
  });
  assert.ok(telegramCalls.some((call) => (
    call.path.endsWith('/sendMessage')
    && String(call.body.text || '').includes('@admin')
    && String(call.body.text || '').includes('@alice')
  )));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 22,
    message: {
      message_id: 22,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 200, username: 'alice', first_name: 'Алиса' },
      text: '/checkin Репетиция',
    },
  });
  const checkinMessage = telegramCalls.find((call) => (
    call.path.endsWith('/sendMessage')
    && call.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'group_checkin'
  ));
  assert.ok(checkinMessage);
  const checkinPanelId = checkinMessage.resultMessageId;

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 23,
    callback_query: {
      id: 'checkin-callback',
      from: { id: 200, username: 'alice' },
      data: 'group_checkin',
      message: {
        message_id: checkinPanelId,
        chat: { id: -100500, type: 'supergroup' },
      },
    },
  });
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/editMessageText')));

  const database = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.equal(database.users.length, fixture.users.length);
  assert.equal(database.users.find((user) => user.id === 'u_alice').telegramId, '200');
  assert.equal(database.users.some((user) => user.telegramId === '999'), false);
  assert.equal(database.settings.teamChatId, '-100500');
  assert.ok(database.messages.u_alice.length > 0);
  assert.ok(database.messages.u_admin.some((message) => message.text.includes('Задача выполнена')));
  const persistedPanels = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.equal(persistedPanels.version, 2);
  assert.ok(Number.isInteger(persistedPanels.panels['200'].current));
  assert.ok(Array.isArray(persistedPanels.panels['200'].known));
  assert.deepEqual(persistedPanels.slotDrafts['200'].slots['2'], [16, 17, 18, 19, 20, 21, 22]);
  assert.match(serverErrors, /Temporary WEBAPP_URL dead-tunnel\.lhr\.life is not allowed in production/);

  console.log('Core flow verification passed: registration, access binding, task notifications, meeting notifications, and task completion.');
} finally {
  if (appProcess && !appProcess.killed) appProcess.kill();
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
