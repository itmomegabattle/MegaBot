import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-session-auth-'));
const databasePath = path.join(tempRoot, 'database.json');
const sessionPath = path.join(tempRoot, 'sessions.json');
const botToken = 'session-auth-bot-token';
const sessionSecret = 'session-auth-independent-secret-32-chars';

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
    query_id: `session-${user.id}`,
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
      ? { id: 999, is_bot: true, username: 'session_test_bot' }
      : true }));
  });
});

await new Promise((resolve) => fakeTelegram.listen(0, '127.0.0.1', resolve));
const telegramPort = fakeTelegram.address().port;
await writeFile(databasePath, JSON.stringify({
  users: [{
    id: 'u_alice', username: '@alice', realName: 'Алиса', role: 'organizer', registered: false,
    avatarSeed: 'alice', birthday: '', competencies: [], primaryCompetency: '', facultyId: '',
  }],
  faculties: [], facultyCompetencies: [], competencies: [], availabilities: {}, meetings: [], events: [], tasks: [], messages: {},
  settings: { availabilityWeekCount: 2 },
}, null, 2));

async function startApp() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
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
      GOOGLE_SHEETS_DATABASE_ENABLED: 'false',
      GOOGLE_SHEETS_SPREADSHEET_ID: '',
      GOOGLE_SERVICE_ACCOUNT_FILE: '',
      GOOGLE_CALENDAR_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return { child, port, stderr: () => stderr };
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Session test server did not start: ${stderr}`);
}

async function stopApp(app) {
  if (!app.child.killed) app.child.kill();
  await once(app.child, 'exit');
  assert.equal(app.stderr(), '');
}

let app;
try {
  app = await startApp();
  const auth = await fetch(`http://127.0.0.1:${app.port}/api/user/get-or-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: telegramInitData({ id: 200, username: 'alice', first_name: 'Алиса' }) }),
  });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { Cookie: cookie } })).status, 200);
  const storedSessions = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(storedSessions.sessions.length, 1);
  assert.equal('token' in storedSessions.sessions[0], false);
  assert.match(storedSessions.sessions[0].tokenHash, /^[a-f0-9]{64}$/);
  await stopApp(app);
  app = undefined;

  app = await startApp();
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { Cookie: cookie } })).status, 200);
  await stopApp(app);
  app = undefined;

  const expiredStore = JSON.parse(await readFile(sessionPath, 'utf8'));
  expiredStore.sessions[0].expiresAt = Date.now() - 1;
  await writeFile(sessionPath, JSON.stringify(expiredStore, null, 2));
  app = await startApp();
  const expired = await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { Cookie: cookie } });
  assert.equal(expired.status, 401);
  assert.match((await expired.json()).error, /Открой Mini App/);

  console.log('Session verification passed: hashed registry persistence, restart survival, and expiry rejection.');
} finally {
  if (app) await stopApp(app);
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
