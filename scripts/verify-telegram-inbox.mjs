import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-telegram-inbox-'));
const databasePath = path.join(tempRoot, 'database.json');
const webhookSecret = 'inbox-webhook-secret';

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

async function waitFor(predicate, description, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // The database may be between atomic replacement operations.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function readDatabase() {
  return JSON.parse(await readFile(databasePath, 'utf8'));
}

const appPort = await freePort();
const telegramCalls = [];
let nextMessageId = 1;
const fakeTelegram = http.createServer((req, res) => {
  let rawBody = '';
  req.on('data', (chunk) => { rawBody += chunk; });
  req.on('end', () => {
    const body = rawBody ? JSON.parse(rawBody) : {};
    telegramCalls.push({ path: req.url, body });
    const result = req.url.endsWith('/getMe')
      ? { id: 999, is_bot: true, username: 'megabot_inbox_test' }
      : req.url.includes('/getChatMember')
        ? { status: 'administrator' }
        : req.url.endsWith('/sendMessage')
          ? { message_id: nextMessageId++, chat: { id: body.chat_id }, text: body.text || '' }
          : true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});

await new Promise((resolve) => fakeTelegram.listen(0, '127.0.0.1', resolve));
const telegramPort = fakeTelegram.address().port;

await writeFile(databasePath, JSON.stringify({
  users: [{
    id: 'u_admin', username: '@admin', realName: 'Администратор', role: 'admin',
    telegramId: '100', registered: true, birthday: '', competencies: [], primaryCompetency: '', facultyId: '',
  }],
  faculties: [], facultyCompetencies: [], competencies: [], availabilities: {}, meetings: [], events: [], tasks: [], messages: {},
  settings: { availabilityWeekCount: 2 },
}, null, 2));

let appProcess;
let serverErrors = '';

function startApp({ failUpdateOnce = false, pollIntervalMs = 250 } = {}) {
  serverErrors = '';
  const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ALLOW_LOCAL_PREVIEW: 'false',
      PORT: String(appPort),
      DB_FILE: databasePath,
      TELEGRAM_BOT_TOKEN: 'inbox-test-token',
      TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
      TELEGRAM_UPDATE_MODE: 'webhook',
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_INBOX_POLL_INTERVAL_MS: String(pollIntervalMs),
      TELEGRAM_INBOX_FAIL_UPDATE_ONCE: failUpdateOnce ? '8001' : '',
      SESSION_SECRET: 'inbox-session-secret-at-least-32-characters',
      WEBAPP_URL: 'https://example.com',
      ADMIN_TELEGRAM_IDS: '100',
      BACKGROUND_SCHEDULERS_ENABLED: 'false',
      GOOGLE_SHEETS_DATABASE_ENABLED: 'false',
      GOOGLE_SHEETS_SPREADSHEET_ID: '',
      GOOGLE_SERVICE_ACCOUNT_FILE: '',
      GOOGLE_CALENDAR_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });
  return child;
}

async function waitForServer() {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
    return response.ok;
  }, 'test server');
}

async function stopApp() {
  if (!appProcess || appProcess.exitCode !== null) return;
  const closed = new Promise((resolve) => appProcess.once('close', resolve));
  appProcess.kill('SIGTERM');
  await closed;
}

async function postUpdate(update) {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/telegram-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
    },
    body: JSON.stringify(update),
  });
  return { response, body: await response.json() };
}

const failingUpdate = {
  update_id: 8001,
  message: {
    message_id: 8001,
    chat: { id: -8001, type: 'supergroup' },
    from: { id: 100, username: 'admin', first_name: 'Админ' },
    text: '/bindteamchat',
  },
};
const independentUpdate = {
  update_id: 8002,
  message: {
    message_id: 8002,
    chat: { id: 100, type: 'private' },
    from: { id: 100, username: 'admin', first_name: 'Админ' },
    text: '/help',
  },
};

try {
  appProcess = startApp({ failUpdateOnce: true, pollIntervalMs: 60_000 });
  await waitForServer();

  const firstResponse = await postUpdate(failingUpdate);
  assert.equal(firstResponse.response.status, 200);
  assert.equal(firstResponse.body.duplicate, false);
  await waitFor(async () => {
    const entry = (await readDatabase()).settings.telegramInbox?.find((item) => item.updateId === 8001);
    return entry?.status === 'retry' && entry.attempts === 1;
  }, 'failed update retry state');

  const secondResponse = await postUpdate(independentUpdate);
  assert.equal(secondResponse.response.status, 200);
  await waitFor(async () => {
    const entry = (await readDatabase()).settings.telegramInbox?.find((item) => item.updateId === 8002);
    return entry?.status === 'completed';
  }, 'independent chat completion');
  assert.equal((await readDatabase()).settings.teamChatId, undefined);

  await stopApp();
  appProcess = startApp();
  await waitForServer();
  await waitFor(async () => {
    const state = await readDatabase();
    const entry = state.settings.telegramInbox?.find((item) => item.updateId === 8001);
    return entry?.status === 'completed' && entry.attempts === 2 && state.settings.teamChatId === '-8001';
  }, 'retry completion after restart');

  const completedBeforeDuplicate = (await readDatabase()).settings.telegramInbox.find((item) => item.updateId === 8001);
  const duplicateResponse = await postUpdate(failingUpdate);
  assert.equal(duplicateResponse.response.status, 200);
  assert.equal(duplicateResponse.body.duplicate, true);
  const stateAfterDuplicate = await readDatabase();
  assert.equal(stateAfterDuplicate.settings.telegramInbox.filter((item) => item.updateId === 8001).length, 1);
  assert.equal(stateAfterDuplicate.settings.telegramInbox.find((item) => item.updateId === 8001).attempts, completedBeforeDuplicate.attempts);

  const invalidResponse = await postUpdate({ message: { text: '/help' } });
  assert.equal(invalidResponse.response.status, 400);
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/sendMessage') && String(call.body.chat_id) === '100'));
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/sendMessage') && String(call.body.chat_id) === '-8001'));
  assert.match(serverErrors, /Telegram inbox update 8001 failed|^$/);

  console.log('Telegram inbox integration verification passed: durable receipt, cross-chat progress, restart retry, and duplicate suppression.');
} finally {
  await stopApp();
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
