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
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-security-controls-'));
const databasePath = path.join(tempRoot, 'database.json');
const sessionPath = path.join(tempRoot, 'sessions.json');
const botToken = 'security-controls-bot-token';
const sessionSecret = 'security-controls-session-secret-32-chars';

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
    query_id: `security-${user.id}-${crypto.randomUUID()}`,
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
  { id: 'u_member_two', telegramId: '300', username: '@member_two', realName: 'Второй участник', role: 'organizer' },
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

const baseEnvironment = {
  ...process.env,
  NODE_ENV: 'production',
  DB_FILE: databasePath,
  SESSION_FILE: sessionPath,
  SESSION_SECRET: sessionSecret,
  TELEGRAM_BOT_TOKEN: botToken,
  TELEGRAM_UPDATE_MODE: 'disabled',
  BACKGROUND_SCHEDULERS_ENABLED: 'false',
  WEBAPP_URL: 'https://example.com',
  ADMIN_TELEGRAM_IDS: '100',
  GOOGLE_SHEETS_DATABASE_ENABLED: 'false',
  GOOGLE_SHEETS_SPREADSHEET_ID: '',
  GOOGLE_SERVICE_ACCOUNT_FILE: '',
  GOOGLE_CALENDAR_ID: '',
};

const rejectedPreview = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
  cwd: repoRoot,
  env: { ...baseEnvironment, PORT: String(await freePort()), ALLOW_LOCAL_PREVIEW: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let previewError = '';
rejectedPreview.stderr.on('data', (chunk) => { previewError += chunk.toString(); });
const [previewExitCode] = await once(rejectedPreview, 'exit');
assert.notEqual(previewExitCode, 0);
assert.match(previewError, /ALLOW_LOCAL_PREVIEW=true is forbidden in production/);

const fakeTelegram = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: req.url.endsWith('/getMe')
      ? { id: 999, is_bot: true, username: 'security_test_bot' }
      : req.url.endsWith('/sendMessage') ? { message_id: 1 } : true }));
  });
});
await new Promise((resolve) => fakeTelegram.listen(0, '127.0.0.1', resolve));
const telegramPort = fakeTelegram.address().port;
const port = await freePort();
const app = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
  cwd: repoRoot,
  env: {
    ...baseEnvironment,
    PORT: String(port),
    ALLOW_LOCAL_PREVIEW: 'false',
    TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
    TELEGRAM_DELIVERY_INTERVAL_MS: '0',
    TELEGRAM_PRIVATE_CHAT_INTERVAL_MS: '0',
    AUTH_RATE_LIMIT_WINDOW_MS: '60000',
    AUTH_RATE_LIMIT_IP_MAX: '6',
    AUTH_RATE_LIMIT_USER_MAX: '1',
    BROADCAST_RATE_LIMIT_WINDOW_MS: '60000',
    BROADCAST_RATE_LIMIT_MAX: '1',
    BROADCAST_VOLUME_WINDOW_MS: '60000',
    BROADCAST_VOLUME_MAX_RECIPIENTS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
app.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
const sameOrigin = `http://127.0.0.1:${port}`;

async function request(pathname, { cookie = '', body, origin } = {}) {
  const response = await fetch(`${sameOrigin}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

async function authenticate(id, username) {
  const result = await request('/api/user/get-or-create', {
    body: { initData: telegramInitData({ id, username, first_name: username }) },
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie').split(';')[0];
}

try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await fetch(`${sameOrigin}/api/health`);
      if (health.ok) {
        started = true;
        break;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(started, true, `Security test server did not start: ${stderr}`);

  const page = await fetch(`${sameOrigin}/`);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self' https:\/\/telegram\.org/);
  assert.match(csp, /frame-ancestors https:\/\/web\.telegram\.org https:\/\/\*\.telegram\.org/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(page.headers.has('x-frame-options'), false, 'X-Frame-Options must not block Telegram framing');
  assert.match(await page.text(), /https:\/\/telegram\.org\/js\/telegram-web-app\.js/);

  const adminCookie = await authenticate(100, 'admin');
  const memberCookie = await authenticate(200, 'member');
  const memberTwoCookie = await authenticate(300, 'member_two');

  const userLimited = await request('/api/user/get-or-create', {
    body: { initData: telegramInitData({ id: 100, username: 'admin' }) },
  });
  assert.equal(userLimited.response.status, 429);
  assert.match(userLimited.response.headers.get('retry-after') || '', /^\d+$/);
  assert.ok(userLimited.data.retryAfterSeconds > 0);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await request('/api/user/get-or-create', { body: { initData: 'invalid' } })).response.status, 403);
  }
  const ipLimited = await request('/api/user/get-or-create', { body: { initData: 'invalid' } });
  assert.equal(ipLimited.response.status, 429);
  assert.match(ipLimited.response.headers.get('retry-after') || '', /^\d+$/);

  const profileBody = {
    requesterId: 'u_member_two',
    userId: 'u_member_two',
    realName: 'Второй участник',
    username: '@member_two',
    birthday: '',
    competencies: [],
    primaryCompetency: '',
  };
  assert.equal((await request('/api/user/update', { cookie: memberTwoCookie, body: profileBody })).response.status, 403);
  assert.equal((await request('/api/user/update', { cookie: memberTwoCookie, body: profileBody, origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await request('/api/user/update', { cookie: memberTwoCookie, body: profileBody, origin: sameOrigin })).response.status, 200);

  const firstBroadcast = await request('/api/team/broadcast', {
    cookie: adminCookie,
    origin: sameOrigin,
    body: { requesterId: 'u_admin', recipientMode: 'people', recipientIds: ['u_member'], body: 'Первая рассылка' },
  });
  assert.equal(firstBroadcast.response.status, 200);
  const requestLimited = await request('/api/team/broadcast', {
    cookie: adminCookie,
    origin: sameOrigin,
    body: { requesterId: 'u_admin', recipientMode: 'people', recipientIds: ['u_member'], body: 'Вторая рассылка' },
  });
  assert.equal(requestLimited.response.status, 429);
  assert.match(requestLimited.data.error, /Лимит рассылок/);

  const volumeLimited = await request('/api/team/broadcast', {
    cookie: memberCookie,
    origin: sameOrigin,
    body: { requesterId: 'u_member', recipientMode: 'all', body: 'Слишком широкая рассылка' },
  });
  assert.equal(volumeLimited.response.status, 429);
  assert.match(volumeLimited.data.error, /Лимит получателей/);

  console.log('Security controls verification passed: auth and broadcast limits, Retry-After, Origin checks, production preview guard, and Telegram-compatible CSP.');
} finally {
  if (!app.killed) app.kill();
  await once(app, 'exit');
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  assert.equal(stderr, '');
}
