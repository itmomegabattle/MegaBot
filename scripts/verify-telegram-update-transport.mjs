import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-telegram-transport-'));

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

async function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const appPort = await freePort();
const telegramCalls = [];
let pollingUpdateDelivered = false;
const pollingUpdate = {
  update_id: 7001,
  message: {
    message_id: 7001,
    chat: { id: -7001, type: 'supergroup' },
    from: { id: 100, username: 'admin', first_name: 'Админ' },
    text: '/bindteamchat',
  },
};

const fakeTelegram = http.createServer((req, res) => {
  let rawBody = '';
  req.on('data', (chunk) => { rawBody += chunk; });
  req.on('end', () => {
    telegramCalls.push({ path: req.url, body: rawBody ? JSON.parse(rawBody) : {} });
    let result = true;
    if (req.url.includes('/getUpdates')) {
      result = pollingUpdateDelivered ? [] : [pollingUpdate];
      pollingUpdateDelivered = true;
    } else if (req.url.endsWith('/getMe')) {
      result = { id: 999, is_bot: true, username: 'megabot_transport_test' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});

await new Promise((resolve) => fakeTelegram.listen(0, '127.0.0.1', resolve));
const telegramPort = fakeTelegram.address().port;
const databasePath = path.join(tempRoot, 'database.json');
await writeFile(databasePath, JSON.stringify({
  users: [{
    id: 'u_admin', username: '@admin', realName: 'Администратор', role: 'admin',
    telegramId: '100', registered: true, birthday: '', competencies: [], primaryCompetency: '', facultyId: '',
  }],
  faculties: [], facultyCompetencies: [], competencies: [], availabilities: {}, meetings: [], events: [], tasks: [], messages: {},
  settings: { availabilityWeekCount: 2 },
}, null, 2));

let appProcess;
try {
  appProcess = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ALLOW_LOCAL_PREVIEW: 'false',
      PORT: String(appPort),
      DB_FILE: databasePath,
      DATABASE_RECOVERY_DIR: `${databasePath}.recovery`,
      TELEGRAM_BOT_TOKEN: 'transport-test-token',
      TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
      TELEGRAM_UPDATE_MODE: 'polling',
      TELEGRAM_WEBHOOK_SECRET: '',
      SESSION_SECRET: 'transport-session-secret-32-characters',
      WEBAPP_URL: 'https://example.com',
      ADMIN_TELEGRAM_IDS: '100',
      GOOGLE_SHEETS_DATABASE_ENABLED: 'false',
      GOOGLE_SHEETS_SPREADSHEET_ID: '',
      GOOGLE_SERVICE_ACCOUNT_FILE: '',
      GOOGLE_CALENDAR_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverErrors = '';
  appProcess.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const state = JSON.parse(readFileSync(databasePath, 'utf8'));
      const inboxEntry = state.settings?.telegramInbox?.find((entry) => entry.updateId === 7001);
      if (state.settings?.teamChatId === '-7001' && inboxEntry?.status === 'completed') break;
    } catch {
      // The server may be replacing the file atomically.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const stateAfterPolling = JSON.parse(readFileSync(databasePath, 'utf8'));
  assert.equal(stateAfterPolling.settings.teamChatId, '-7001');
  assert.equal(
    stateAfterPolling.settings.telegramInbox?.find((entry) => entry.updateId === 7001)?.status,
    'completed',
  );
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/deleteWebhook')));
  assert.ok(telegramCalls.some((call) => call.path.includes('/getUpdates')));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (telegramCalls.some((call) => call.path.includes('/getUpdates?offset=7002&'))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    telegramCalls.some((call) => call.path.includes('/getUpdates?offset=7002&')),
    'polling offset must advance only after the update batch is persisted',
  );

  const forgedHttpUpdate = await fetch(`http://127.0.0.1:${appPort}/api/telegram-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pollingUpdate, update_id: 7002, message: { ...pollingUpdate.message, chat: { id: -999 } } }),
  });
  assert.equal(forgedHttpUpdate.status, 404);
  const stateAfterHttpAttempt = JSON.parse(readFileSync(databasePath, 'utf8'));
  assert.equal(stateAfterHttpAttempt.settings.teamChatId, '-7001');

  const webhookSecret = 'transport-cli-webhook-secret';
  const cliResult = await runProcess(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repoRoot, 'scripts', 'telegram-webhook-admin.ts'), 'set'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: 'transport-test-token',
        TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
        TELEGRAM_WEBHOOK_SECRET: webhookSecret,
        WEBAPP_URL: 'https://example.com/app',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.equal(cliResult.code, 0, cliResult.stderr);
  const setWebhookCall = telegramCalls.find((call) => call.path.endsWith('/setWebhook'));
  assert.equal(setWebhookCall.body.url, 'https://example.com/api/telegram-webhook');
  assert.equal(setWebhookCall.body.secret_token, webhookSecret);
  assert.deepEqual(setWebhookCall.body.allowed_updates, ['message', 'callback_query', 'chat_member', 'my_chat_member']);
  assert.equal(serverErrors, '');
  const closed = new Promise(resolve => appProcess.once('close', resolve));
  appProcess.kill();
  await closed;
  const stoppedState = JSON.parse(await readFile(databasePath, 'utf8'));
  assert.equal(stoppedState.settings.teamChatId, '-7001');
  assert.equal(stoppedState.settings.telegramInbox.find(item => item.updateId === 7001).status, 'completed');

  console.log('Telegram transport verification passed: durable polling offset, disabled HTTP route, and webhook CLI configuration.');
} finally {
  if (appProcess && !appProcess.killed) appProcess.kill();
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
