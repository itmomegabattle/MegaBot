import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-state-access-'));
const databasePath = path.join(tempRoot, 'database.json');
const sessionPath = path.join(tempRoot, 'sessions.json');
const botToken = 'state-access-bot-token';
const sessionSecret = 'state-access-independent-secret-32-chars';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function telegramInitData(user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `state-access-${user.id}`,
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

const fakeTelegram = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: req.url.endsWith('/getMe')
      ? { id: 999, is_bot: true, username: 'state_access_test_bot' }
      : true }));
  });
});

await new Promise((resolve) => fakeTelegram.listen(0, '127.0.0.1', resolve));
const telegramPort = fakeTelegram.address().port;

const users = [
  { id: 'u_admin', telegramId: '100', username: '@admin', realName: 'Администратор', role: 'admin', birthday: '15.04.1998', facultyId: '' },
  { id: 'u_member', telegramId: '200', username: '@member', realName: 'Участник', role: 'organizer', birthday: '09.11.2000', facultyId: '' },
  { id: 'u_faculty_a', telegramId: '300', username: '@faculty_a', realName: 'Факультет А', role: 'faculty_responsible', birthday: '03.06.2001', facultyId: 'fac_a' },
  { id: 'u_faculty_b', telegramId: '400', username: '@faculty_b', realName: 'Факультет Б', role: 'faculty_helper', birthday: '04.07.2002', facultyId: 'fac_b' },
].map((user) => ({
  ...user,
  avatarSeed: user.id,
  registered: true,
  competencies: ['Дизайн'],
  primaryCompetency: 'Дизайн',
  joinedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-09-22T12:00:00.000Z',
}));

await writeFile(databasePath, JSON.stringify({
  users,
  faculties: [{ id: 'fac_a', name: 'Факультет А' }, { id: 'fac_b', name: 'Факультет Б' }],
  facultyCompetencies: ['Дизайн'],
  competencies: ['Дизайн'],
  availabilities: {
    u_admin: { userId: 'u_admin', weekStart: '2026-09-21', updatedAt: '2026-09-22T00:00:00.000Z', slots: { 0: [18] } },
    u_member: { userId: 'u_member', weekStart: '2026-09-21', updatedAt: '2026-09-22T00:00:00.000Z', slots: { 0: [19] } },
    u_faculty_a: { userId: 'u_faculty_a', weekStart: '2026-09-21', updatedAt: '2026-09-22T00:00:00.000Z', slots: { 0: [20] } },
  },
  meetings: [{ id: 'meeting_1', title: 'Встреча', type: 'general', date: '30.09.26', time: '18:00', duration: 1, hostId: 'u_admin', participants: 'all', status: 'scheduled', googleCalendarEventId: 'internal-calendar-id' }],
  events: [],
  tasks: [
    { id: 'task_a', title: 'Задача А', description: 'Только факультету А', deadline: '30.09.26', assignedTo: ['u_faculty_a'], creatorId: 'u_admin', competency: 'Дизайн', competencies: ['Дизайн'], sow: '', tips: [], status: 'assigned', priority: 'normal', facultyId: 'fac_a', reminders: [{ id: 'reminder_1', type: 'before_deadline', value: 1, unit: 'days', sentAt: '2026-09-21T00:00:00.000Z', lastSentAt: '2026-09-21T00:00:00.000Z' }], assigneeNotes: { u_faculty_a: { executor: 'Моя заметка' }, u_admin: { coordinator: 'Скрытая заметка' } }, completionComments: {} },
    { id: 'task_b', title: 'Задача Б', description: 'Только факультету Б', deadline: '30.09.26', assignedTo: ['u_faculty_b'], creatorId: 'u_admin', competency: 'Дизайн', competencies: ['Дизайн'], sow: '', tips: [], status: 'assigned', priority: 'normal', facultyId: 'fac_b', assigneeNotes: {}, completionComments: {} },
    { id: 'task_core', title: 'Задача команды', description: 'Не для факультета', deadline: '30.09.26', assignedTo: ['u_member'], creatorId: 'u_admin', competency: 'Дизайн', competencies: ['Дизайн'], sow: '', tips: [], status: 'assigned', priority: 'normal', assigneeNotes: {}, completionComments: {} },
  ],
  messages: {
    u_admin: [{ id: 'admin_message', userId: 'u_admin', sender: 'bot', text: 'Админу', timestamp: '2026-09-22T00:00:00.000Z' }],
    u_member: [{ id: 'member_message', userId: 'u_member', sender: 'bot', text: 'Участнику', timestamp: '2026-09-22T00:00:00.000Z' }],
    u_faculty_a: [{ id: 'faculty_message', userId: 'u_faculty_a', sender: 'bot', text: 'Факультету', timestamp: '2026-09-22T00:00:00.000Z' }],
  },
  settings: {
    availabilityWeekCount: 3,
    availabilityActiveDays: [0, 1, 2, 3, 4],
    availabilityStartHour: 17,
    availabilityEndHour: 23,
    teamChatId: '-100-secret',
    teamImportantThreadId: 77,
    pendingImportantNotifications: [{ id: 'queued', text: 'Внутренняя очередь', silent: false, createdAt: '2026-09-22T00:00:00.000Z', attempts: 1 }],
    notificationDeliveries: [{
      id: 'failed-delivery', dedupeKey: 'failed-delivery', category: 'test', chatId: '200', text: 'Проверка',
      disableNotification: false, disableWebPagePreview: true, intendedAt: '2026-09-22T00:00:00.000Z',
      availableAt: '2026-09-22T00:00:00.000Z', status: 'failed', attempts: 1,
      lastErrorCode: '403', lastErrorMessage: 'Forbidden', updatedAt: '2026-09-22T00:00:00.000Z',
    }],
    databaseRevision: 42,
  },
}, null, 2));

const port = await freePort();
const app = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ALLOW_LOCAL_PREVIEW: 'false',
    PORT: String(port),
    DB_FILE: databasePath,
    SESSION_FILE: sessionPath,
    SESSION_SECRET: sessionSecret,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
    TELEGRAM_UPDATE_MODE: 'disabled',
    BACKGROUND_SCHEDULERS_ENABLED: 'false',
    WEBAPP_URL: 'https://example.com',
    ADMIN_TELEGRAM_IDS: '100',
    GOOGLE_SHEETS_DATABASE_ENABLED: 'false',
    GOOGLE_SHEETS_SPREADSHEET_ID: '',
    GOOGLE_SERVICE_ACCOUNT_FILE: '',
    GOOGLE_CALENDAR_ID: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
app.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

async function request(pathname, cookie, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

async function authenticate(telegramId, username) {
  const result = await request('/api/user/get-or-create', '', {
    initData: telegramInitData({ id: telegramId, username, first_name: username }),
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie').split(';')[0];
}

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.status, 'ready');
  assert.equal((await request('/api/health/live')).response.status, 200);
  assert.equal((await request('/api/health/ready')).response.status, 200);
  const correlatedHealth = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
    headers: { 'X-Request-ID': 'state-access-request-123' },
  });
  assert.equal(correlatedHealth.headers.get('x-request-id'), 'state-access-request-123');
  for (const key of ['telegramConfigured', 'webAppConfigured', 'googleSheetsConfigured', 'googleCalendarConfigured']) {
    assert.equal(key in health.data, false, `health must not expose ${key}`);
  }

  const adminCookie = await authenticate(100, 'admin');
  const memberCookie = await authenticate(200, 'member');
  const facultyACookie = await authenticate(300, 'faculty_a');
  const facultyBCookie = await authenticate(400, 'faculty_b');

  assert.equal((await request('/api/admin/diagnostics')).response.status, 401);
  assert.equal((await request('/api/admin/diagnostics', memberCookie)).response.status, 403);
  const diagnostics = await request('/api/admin/diagnostics', adminCookie);
  assert.equal(diagnostics.response.status, 200);
  assert.equal(diagnostics.data.status, 'degraded');
  assert.equal(diagnostics.data.persistence.status, 'healthy');
  assert.equal(diagnostics.data.persistence.mode, 'local_json');
  assert.equal(diagnostics.data.persistence.durableRevision, diagnostics.data.persistence.replicatedRevision);
  assert.equal(typeof diagnostics.data.queues.notificationDelivery.pending, 'number');
  assert.equal(diagnostics.data.queues.notificationDelivery.attention, 1);
  assert.equal(typeof diagnostics.data.queues.telegramInbox.pending, 'number');
  assert.ok(diagnostics.data.workers.telegram_inbox);
  assert.doesNotMatch(JSON.stringify(diagnostics.data), /state-access-bot-token|state-access-independent-secret/);

  const adminState = await request('/api/state', adminCookie);
  assert.equal(adminState.response.status, 200);
  assert.equal(adminState.data.users.find((user) => user.id === 'u_member').birthday, '09.11.2000');
  assert.deepEqual(Object.keys(adminState.data.messages), ['u_admin']);
  assert.equal(adminState.data.users.some((user) => 'telegramId' in user || 'joinedAt' in user), false);
  assert.equal('teamChatId' in adminState.data.settings, false);
  assert.equal('pendingImportantNotifications' in adminState.data.settings, false);
  assert.equal('databaseRevision' in adminState.data.settings, false);
  assert.equal('u_faculty_a' in adminState.data.availabilities, false);
  assert.equal('googleCalendarEventId' in adminState.data.meetings[0], false);
  assert.equal('sentAt' in adminState.data.tasks[0].reminders[0], false);
  assert.equal('lastSentAt' in adminState.data.tasks[0].reminders[0], false);

  const memberState = await request('/api/state', memberCookie);
  assert.equal(memberState.response.status, 200);
  assert.equal(memberState.data.users.find((user) => user.id === 'u_member').birthday, '09.11.2000');
  assert.equal(memberState.data.users.find((user) => user.id === 'u_admin').birthday, '15.04');
  assert.equal(memberState.data.users.some((user) => 'lastSeenAt' in user), false);
  assert.deepEqual(Object.keys(memberState.data.messages), ['u_member']);

  for (const facultyCookie of [facultyACookie, facultyBCookie]) {
    assert.equal((await request('/api/state', facultyCookie)).response.status, 403);
    assert.equal((await request('/api/task/export', facultyCookie)).response.status, 403);
    assert.equal((await request('/api/integrations/google-sheets/availability', facultyCookie)).response.status, 403);
    assert.equal((await request('/api/task/create', facultyCookie, {
      creatorId: 'u_admin', title: 'Чужая задача', description: '', deadline: '30.09.26', assignedTo: null,
    })).response.status, 403);
  }

  assert.equal((await request('/api/faculty/me', memberCookie)).response.status, 403);
  const facultyProfile = await request('/api/faculty/me', facultyACookie);
  assert.equal(facultyProfile.response.status, 200);
  assert.equal(facultyProfile.data.user.id, 'u_faculty_a');
  assert.equal('telegramId' in facultyProfile.data.user, false);
  assert.equal('lastSeenAt' in facultyProfile.data.user, false);

  const facultyATasks = await request('/api/faculty/my-tasks', facultyACookie);
  assert.deepEqual(facultyATasks.data.tasks.map((task) => task.id), ['task_a']);
  assert.deepEqual(Object.keys(facultyATasks.data.tasks[0].assigneeNotes), ['u_faculty_a']);
  const facultyBTasks = await request('/api/faculty/my-tasks', facultyBCookie);
  assert.deepEqual(facultyBTasks.data.tasks.map((task) => task.id), ['task_b']);

  console.log('State access verification passed: four roles, redacted core DTOs, faculty isolation, and cross-faculty task filtering.');
} finally {
  if (!app.killed) app.kill();
  await once(app, 'exit');
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  assert.equal(stderr, '');
}
