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
    telegramCalls.push({
      path: req.url,
      body: rawBody ? JSON.parse(rawBody) : {},
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: true }));
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
      WEBAPP_URL: 'https://example.test/app',
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
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/sendMessage')));

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
    workload: 'medium',
  });
  assert.equal(taskResult.response.status, 200);
  assert.deepEqual(taskResult.data.task.assignedTo, ['u_alice', 'u_bob']);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 2);

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
  });
  assert.equal(completed.response.status, 200);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 1);
  assert.equal(telegramCalls.find((call) => call.path.endsWith('/sendMessage')).body.chat_id, '100');

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

  const database = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.equal(database.users.length, fixture.users.length);
  assert.equal(database.users.find((user) => user.id === 'u_alice').telegramId, '200');
  assert.equal(database.users.some((user) => user.telegramId === '999'), false);
  assert.ok(database.messages.u_alice.length > 0);
  assert.ok(database.messages.u_admin.some((message) => message.text.includes('Задача выполнена')));
  assert.equal(serverErrors, '');

  console.log('Core flow verification passed: registration, access binding, task notifications, meeting notifications, and task completion.');
} finally {
  if (appProcess && !appProcess.killed) appProcess.kill();
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
