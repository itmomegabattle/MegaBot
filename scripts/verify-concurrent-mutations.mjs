import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-concurrent-mutations-'));
const databasePath = path.join(tempRoot, 'database.json');
const sessionPath = path.join(tempRoot, 'sessions.json');
const botToken = 'concurrent-mutations-bot-token';

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
    query_id: `concurrency-${user.id}-${crypto.randomUUID()}`,
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

const users = [
  { id: 'u_admin', telegramId: '100', username: '@admin', realName: 'Администратор', role: 'admin' },
  { id: 'u_member', telegramId: '200', username: '@member', realName: 'Участник', role: 'organizer' },
].map((user) => ({
  ...user,
  avatarSeed: user.id,
  registered: true,
  birthday: '',
  competencies: [],
  primaryCompetency: '',
  facultyId: '',
}));

await writeFile(databasePath, JSON.stringify({
  users,
  faculties: [],
  facultyCompetencies: [],
  competencies: [],
  availabilities: {},
  meetings: [],
  events: [],
  tasks: [],
  messages: {},
  settings: { availabilityWeekCount: 2 },
}, null, 2));

const fakeTelegram = http.createServer((req, res) => {
  if (req.url.includes('/sendMessage')) telegramSendCount += 1;
  req.resume();
  req.on('end', () => {
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: req.url.endsWith('/getMe')
        ? { id: 999, is_bot: true, username: 'concurrency_test_bot' }
        : req.url.includes('/sendMessage') ? { message_id: telegramSendCount } : true }));
    };
    if (req.url.includes('/sendMessage')) setTimeout(reply, 75);
    else reply();
  });
});
let telegramSendCount = 0;
await new Promise((resolve) => fakeTelegram.listen(0, '127.0.0.1', resolve));
const telegramPort = fakeTelegram.address().port;
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ALLOW_LOCAL_PREVIEW: 'false',
    PORT: String(port),
    DB_FILE: databasePath,
    SESSION_FILE: sessionPath,
    SESSION_SECRET: 'concurrent-mutations-session-secret',
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
    TELEGRAM_DELIVERY_INTERVAL_MS: '0',
    TELEGRAM_PRIVATE_CHAT_INTERVAL_MS: '0',
    TELEGRAM_UPDATE_MODE: 'disabled',
    BACKGROUND_SCHEDULERS_ENABLED: 'false',
    WEBAPP_URL: 'https://example.com',
    ADMIN_TELEGRAM_IDS: '100',
    GOOGLE_SHEETS_DATABASE_ENABLED: 'false',
    GOOGLE_SHEETS_SPREADSHEET_ID: '',
    GOOGLE_SERVICE_ACCOUNT_FILE: '',
    GOOGLE_CALENDAR_ID: '',
    AUTH_RATE_LIMIT_IP_MAX: '100',
    AUTH_RATE_LIMIT_USER_MAX: '20',
    BROADCAST_RATE_LIMIT_MAX: '20',
    BROADCAST_VOLUME_MAX_RECIPIENTS: '100',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
app.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

async function request(pathname, { cookie = '', body, idempotencyKey = '' } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

async function authenticate(id, username) {
  const result = await request('/api/user/get-or-create', {
    body: { initData: telegramInitData({ id, username, first_name: username }) },
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie').split(';')[0];
}

async function storedState() {
  return JSON.parse(await readFile(databasePath, 'utf8'));
}

try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        started = true;
        break;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(started, true, `Concurrency test server did not start: ${stderr}`);

  const adminCookie = await authenticate(100, 'admin');
  const memberCookie = await authenticate(200, 'member');
  const createTask = (index) => request('/api/task/create', {
    cookie: adminCookie,
    body: {
      creatorId: 'u_admin',
      title: `Параллельная задача ${index}`,
      description: '',
      deadline: '31.12.2030',
      assignedTo: ['u_member'],
      priority: 'normal',
    },
  });

  const creates = await Promise.all(Array.from({ length: 20 }, (_, index) => createTask(index)));
  assert.deepEqual([...new Set(creates.map(({ response }) => response.status))], [200]);
  const createdTasks = creates.map(({ data }) => data.task);
  assert.equal(new Set(createdTasks.map((task) => task.id)).size, 20);
  assert.equal((await storedState()).tasks.filter((task) => task.title.startsWith('Параллельная задача ')).length, 20);

  const idempotentTaskBody = {
    creatorId: 'u_admin', title: 'Идемпотентная задача', description: '', deadline: '31.12.2030', assignedTo: ['u_member'], priority: 'normal',
  };
  const idempotentKey = `task-${crypto.randomUUID()}`;
  const sendsBeforeIdempotentTask = telegramSendCount;
  const idempotentCreates = await Promise.all(Array.from({ length: 10 }, () => request('/api/task/create', {
    cookie: adminCookie, body: idempotentTaskBody, idempotencyKey: idempotentKey,
  })));
  assert.deepEqual([...new Set(idempotentCreates.map(({ response }) => response.status))], [200]);
  assert.equal(new Set(idempotentCreates.map(({ data }) => data.task.id)).size, 1);
  assert.match(idempotentCreates[0].data.task.id, /^t_[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(idempotentCreates.filter(({ response }) => response.headers.get('idempotency-replayed') === 'true').length, 9);
  const afterIdempotentCreate = await storedState();
  assert.equal(afterIdempotentCreate.tasks.filter((task) => task.title === idempotentTaskBody.title).length, 1);
  assert.equal(afterIdempotentCreate.messages.u_member.filter((message) => message.text.includes(idempotentTaskBody.title)).length, 1);
  assert.equal(telegramSendCount - sendsBeforeIdempotentTask, 1);
  const bodyConflict = await request('/api/task/create', {
    cookie: adminCookie, idempotencyKey: idempotentKey,
    body: { ...idempotentTaskBody, title: 'Другое тело' },
  });
  assert.equal(bodyConflict.response.status, 409);
  assert.equal(afterIdempotentCreate.settings.idempotencyRecords.find((record) => record.key === idempotentKey)?.status, 'completed');

  const independent = createdTasks.slice(0, 2);
  const completions = await Promise.all(independent.map((task) => request('/api/task/status', {
    cookie: memberCookie,
    body: { taskId: task.id, version: task.version, status: 'completed', requesterId: 'u_member' },
  })));
  assert.deepEqual([...new Set(completions.map(({ response }) => response.status))], [200]);
  const afterIndependent = await storedState();
  assert.ok(independent.every((task) => afterIndependent.tasks.find((item) => item.id === task.id)?.status === 'completed'));
  const repeatedCompletion = await request('/api/task/status', {
    cookie: memberCookie,
    body: { taskId: independent[0].id, version: independent[0].version, status: 'completed', requesterId: 'u_member' },
  });
  assert.equal(repeatedCompletion.response.status, 200);
  assert.equal(repeatedCompletion.data.alreadyApplied, true);
  assert.equal(repeatedCompletion.data.task.version, afterIndependent.tasks.find((task) => task.id === independent[0].id).version);

  const conflictTask = createdTasks[2];
  const conflictingUpdates = await Promise.all(['Первая версия', 'Вторая версия'].map((title) => request('/api/task/update', {
    cookie: adminCookie,
    body: { requesterId: 'u_admin', taskId: conflictTask.id, version: conflictTask.version, title },
  })));
  assert.deepEqual(conflictingUpdates.map(({ response }) => response.status).sort((a, b) => a - b), [200, 409]);
  const afterConflict = await storedState();
  const persistedConflictTask = afterConflict.tasks.find((task) => task.id === conflictTask.id);
  assert.equal(persistedConflictTask.version, 2);
  assert.ok(['Первая версия', 'Вторая версия'].includes(persistedConflictTask.title));

  const completionTask = createdTasks[3];
  const [broadcast, completion] = await Promise.all([
    request('/api/team/broadcast', {
      cookie: adminCookie,
      body: { requesterId: 'u_admin', recipientMode: 'people', recipientIds: ['u_member'], body: 'Параллельная рассылка' },
    }),
    request('/api/task/status', {
      cookie: memberCookie,
      body: { taskId: completionTask.id, version: completionTask.version, status: 'completed', requesterId: 'u_member' },
    }),
  ]);
  assert.equal(broadcast.response.status, 200);
  assert.equal(completion.response.status, 200);
  const finalState = await storedState();
  assert.equal(finalState.tasks.find((task) => task.id === completionTask.id)?.status, 'completed');
  assert.ok(finalState.messages.u_member.some((message) => message.text.includes('Параллельная рассылка')));

  const broadcastKey = `broadcast-${crypto.randomUUID()}`;
  const broadcastBody = { requesterId: 'u_admin', recipientMode: 'people', recipientIds: ['u_member'], body: 'Одна идемпотентная рассылка' };
  const sendsBeforeIdempotentBroadcast = telegramSendCount;
  const repeatedBroadcasts = await Promise.all(Array.from({ length: 10 }, () => request('/api/team/broadcast', {
    cookie: adminCookie, body: broadcastBody, idempotencyKey: broadcastKey,
  })));
  assert.deepEqual([...new Set(repeatedBroadcasts.map(({ response }) => response.status))], [200]);
  assert.equal(repeatedBroadcasts.filter(({ response }) => response.headers.get('idempotency-replayed') === 'true').length, 9);
  assert.equal(telegramSendCount - sendsBeforeIdempotentBroadcast, 1);
  assert.equal((await storedState()).messages.u_member.filter((message) => message.text.includes(broadcastBody.body)).length, 1);

  const openTask = await request('/api/task/create', {
    cookie: adminCookie,
    body: { creatorId: 'u_admin', title: 'Одна открытая задача', description: '', deadline: '31.12.2030', assignedTo: [], priority: 'normal' },
  });
  assert.equal(openTask.response.status, 200);
  const parallelClaims = await Promise.all([
    request('/api/task/claim', { cookie: memberCookie, body: { taskId: openTask.data.task.id, userId: 'u_member' } }),
    request('/api/task/claim', { cookie: adminCookie, body: { taskId: openTask.data.task.id, userId: 'u_admin' } }),
  ]);
  assert.deepEqual(parallelClaims.map(({ response }) => response.status).sort((a, b) => a - b), [200, 409]);
  assert.equal((await storedState()).tasks.find((task) => task.id === openTask.data.task.id)?.assignedTo?.length, 1);

  const backupPath = `${databasePath}.backup`;
  assert.equal(stderr, '');
  await rename(databasePath, backupPath);
  await mkdir(databasePath);
  const failedSave = await createTask('ошибка-сохранения');
  assert.equal(failedSave.response.status, 503);
  await rmdir(databasePath);
  await rename(backupPath, databasePath);
  const stateAfterFailedSave = await request('/api/state', { cookie: adminCookie });
  assert.equal(stateAfterFailedSave.response.status, 200);
  assert.equal(stateAfterFailedSave.data.tasks.some((task) => task.title === 'Параллельная задача ошибка-сохранения'), false);

  console.log('Concurrent mutation verification passed: parallel creates, durable idempotency, body conflicts, single broadcast delivery, stale versions, claims, and failed persistence.');
} finally {
  if (!app.killed) app.kill();
  await once(app, 'exit');
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  if (stderr) assert.match(stderr, /^Error writing database file: Error: (?:EPERM|EACCES|EISDIR)/);
}
