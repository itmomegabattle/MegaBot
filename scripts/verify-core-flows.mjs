import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-core-'));
const appPort = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});
const botToken = 'integration-test-token';
const telegramWebhookSecret = 'integration-webhook-secret';
const sessionSecret = 'integration-session-secret-32-characters';
const telegramCalls = [];
let nextTelegramMessageId = 1000;
let sessionCookie = '';
let failNextTelegramEdit = false;
let failNextTelegramSend = false;
let rateLimitNextTelegramSend = false;
let delayNextTelegramSendMs = 0;
let groupBotIsAdmin = true;
let createdEventId = '';
let serverErrors = '';

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
      competencies: ['Продакшн'],
      primaryCompetency: 'Продакшн',
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
  competencies: ['Дизайн', 'Продакшн'],
  availabilities: {},
  meetings: [],
  tasks: [],
  messages: {},
};

function signedTelegramInitData(entries) {
  const params = new URLSearchParams(entries);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function telegramInitData(user, options = {}) {
  return signedTelegramInitData({
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: `test-${user.id}`,
    user: JSON.stringify(user),
  });
}

function currentWeekStart() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const monday = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}

async function request(pathname, body, options = {}) {
  const webhookSecret = options.telegramWebhookSecret === undefined
    ? telegramWebhookSecret
    : options.telegramWebhookSecret;
  const response = await fetch(`http://127.0.0.1:${appPort}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${appPort}`,
      }),
      ...(pathname === '/api/telegram-webhook' && webhookSecret !== null
        ? { 'X-Telegram-Bot-Api-Secret-Token': webhookSecret }
        : {}),
      ...((options.cookie === undefined ? sessionCookie : options.cookie)
        ? { Cookie: options.cookie === undefined ? sessionCookie : options.cookie }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`${pathname} returned non-JSON ${response.status}: ${responseText.slice(0, 160)}\n${serverErrors.slice(-2000)}`);
  }
  return { response, data };
}

async function saveAvailabilityWeek(userId, weekIndex, days = {}, hardUnavailableDays = [], out = false, expectedVersion) {
  const snapshot = (await request('/api/state')).data;
  const baseWeekStart = snapshot.settings.availabilityWeekStart || currentWeekStart();
  const weekStart = new Date(Date.parse(`${baseWeekStart}T12:00:00Z`) + weekIndex * 7 * 86400000).toISOString().slice(0, 10);
  const version = expectedVersion ?? Number(snapshot.availabilities[userId]?.weekVersions?.[weekStart] || 0);
  return request('/api/availability', { userId, weekStart, days, hardUnavailableDays, out, expectedVersion: version });
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
  req.on('end', async () => {
    const resultMessageId = req.url.endsWith('/sendMessage') ? nextTelegramMessageId++ : undefined;
    telegramCalls.push({
      path: req.url,
      body: rawBody ? JSON.parse(rawBody) : {},
      resultMessageId,
    });
    if (failNextTelegramEdit && req.url.endsWith('/editMessageText')) {
      failNextTelegramEdit = false;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'Bad Request: message to edit not found' }));
      return;
    }
    if (failNextTelegramSend && req.url.endsWith('/sendMessage')) {
      failNextTelegramSend = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
      return;
    }
    if (rateLimitNextTelegramSend && req.url.endsWith('/sendMessage')) {
      rateLimitNextTelegramSend = false;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 300 } }));
      return;
    }
    if (delayNextTelegramSendMs && req.url.endsWith('/sendMessage')) {
      const delayMs = delayNextTelegramSendMs;
      delayNextTelegramSendMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const result = req.url.endsWith('/getMe')
      ? { id: 999, is_bot: true, username: 'megaorgi_bot' }
      : req.url.includes('/getChatMember')
        ? { status: groupBotIsAdmin ? 'administrator' : 'member' }
        : resultMessageId
          ? { message_id: resultMessageId, chat: { id: 1 }, text: '' }
          : true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      result,
    }));
  });
});

await new Promise((resolve) => fakeTelegram.listen(0, '127.0.0.1', resolve));
const telegramPort = fakeTelegram.address().port;
let appProcess;

try {
  const testDatabasePath = path.join(tempRoot, 'database.json');
  await writeFile(testDatabasePath, JSON.stringify(fixture, null, 2), 'utf8');
  const clockPath = path.join(tempRoot, 'clock.txt');
  const testStartMs = Date.now();
  await writeFile(clockPath, String(testStartMs));
  const clockPreload = path.join(tempRoot, 'clock.cjs');
  await writeFile(clockPreload, `
    const fs = require('node:fs');
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [global.Date.now()])); }
      static now() {
        return fs.existsSync(process.env.TEST_CLOCK_FILE)
          ? Number(fs.readFileSync(process.env.TEST_CLOCK_FILE, 'utf8')) : RealDate.now();
      }
    };
  `);

  appProcess = spawn(process.execPath, ['--require', clockPreload, path.join(repoRoot, 'dist', 'server.cjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ALLOW_LOCAL_PREVIEW: 'false',
      PORT: String(appPort),
      DB_FILE: testDatabasePath,
      TEST_CLOCK_FILE: clockPath,
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
      TELEGRAM_DELIVERY_INTERVAL_MS: '0',
      TELEGRAM_PRIVATE_CHAT_INTERVAL_MS: '0',
      WEBAPP_URL: 'https://dead-tunnel.lhr.life',
      TELEGRAM_UPDATE_MODE: 'webhook',
      TELEGRAM_INBOX_AWAIT_PROCESSING: 'true',
      TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret,
      SESSION_SECRET: sessionSecret,
      GOOGLE_SHEETS_DATABASE_ENABLED: 'false',
      GOOGLE_SHEETS_SPREADSHEET_ID: '',
      GOOGLE_SERVICE_ACCOUNT_FILE: '',
      GOOGLE_CALENDAR_ID: '',
      ADMIN_USERNAMES: '@admin',
      ADMIN_TELEGRAM_IDS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

  const health = await request('/api/health');
  assert.equal(health.data.telegramUpdateMode, 'webhook');

  const setWebhookCallsBefore = telegramCalls.filter((call) => call.path.endsWith('/setWebhook')).length;
  const removedSetupRoute = await request('/api/setup-webhook');
  assert.equal(removedSetupRoute.response.status, 401);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/setWebhook')).length, setWebhookCallsBefore);

  const forgedBindingUpdate = {
    update_id: 999001,
    message: {
      message_id: 999001,
      chat: { id: -999, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/bindteamchat',
    },
  };
  const missingWebhookSecret = await request(
    '/api/telegram-webhook',
    forgedBindingUpdate,
    { telegramWebhookSecret: null },
  );
  assert.equal(missingWebhookSecret.response.status, 401);
  const invalidWebhookSecret = await request(
    '/api/telegram-webhook',
    forgedBindingUpdate,
    { telegramWebhookSecret: 'wrong-secret' },
  );
  assert.equal(invalidWebhookSecret.response.status, 403);
  const stateAfterForgedWebhook = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.notEqual(stateAfterForgedWebhook.settings?.teamChatId, '-999');

  const protectedState = await request('/api/state');
  assert.equal(protectedState.response.status, 401);
  const legacyPayload = Buffer.from(JSON.stringify({
    userId: 'u_admin',
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const legacySignature = crypto.createHmac('sha256', botToken).update(legacyPayload).digest('base64url');
  const legacySession = await request('/api/state', undefined, {
    cookie: `megabot_session=${legacyPayload}.${legacySignature}`,
  });
  assert.equal(legacySession.response.status, 401);

  const aliceTelegram = { id: 200, username: 'alice', first_name: 'Алиса' };
  const authNow = Math.floor(testStartMs / 1000);
  for (const authDate of [authNow - 300, authNow + 30]) {
    const boundaryAuth = await request('/api/user/get-or-create', {
      initData: telegramInitData(aliceTelegram, { authDate }),
    });
    assert.equal(boundaryAuth.response.status, 200);
  }
  for (const authDate of [authNow - 301, authNow + 31, 0, `${authNow}.5`, 'not-a-date']) {
    const rejectedAuthDate = await request('/api/user/get-or-create', {
      initData: telegramInitData(aliceTelegram, { authDate }),
    });
    assert.equal(rejectedAuthDate.response.status, 403);
  }
  const missingAuthDate = await request('/api/user/get-or-create', {
    initData: signedTelegramInitData({ query_id: 'missing-auth-date', user: JSON.stringify(aliceTelegram) }),
  });
  assert.equal(missingAuthDate.response.status, 403);

  const impersonationAttempt = await request('/api/user/get-or-create', {
    telegramId: '100',
    username: 'admin',
    initData: telegramInitData(aliceTelegram),
  });
  assert.equal(impersonationAttempt.response.status, 200);
  assert.equal(impersonationAttempt.data.user.id, 'u_alice');
  assert.equal(impersonationAttempt.data.user.role, 'organizer');

  const usernameAdminAttempt = await request('/api/user/get-or-create', {
    initData: telegramInitData({ id: 999, username: 'admin', first_name: 'Не админ' }),
  });
  assert.equal(usernameAdminAttempt.response.status, 403);

  const invalidSignatureParams = new URLSearchParams(telegramInitData(aliceTelegram));
  invalidSignatureParams.set('hash', '0'.repeat(64));
  const invalidSignature = await request('/api/user/get-or-create', {
    initData: invalidSignatureParams.toString(),
  });
  assert.equal(invalidSignature.response.status, 403);

  const invalidUserType = await request('/api/user/get-or-create', {
    initData: telegramInitData({ id: '200', username: 'alice' }),
  });
  assert.equal(invalidUserType.response.status, 403);

  const malformedUser = await request('/api/user/get-or-create', {
    initData: signedTelegramInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'malformed-user',
      user: '{not-json',
    }),
  });
  assert.equal(malformedUser.response.status, 403);

  const duplicateQueryKey = await request('/api/user/get-or-create', {
    initData: signedTelegramInitData([
      ['auth_date', String(Math.floor(Date.now() / 1000))],
      ['query_id', 'duplicate-a'],
      ['query_id', 'duplicate-b'],
      ['user', JSON.stringify(aliceTelegram)],
    ]),
  });
  assert.equal(duplicateQueryKey.response.status, 403);

  const aliceAuth = await request('/api/user/get-or-create', {
    initData: telegramInitData(aliceTelegram),
  });
  assert.equal(aliceAuth.response.status, 200);
  assert.equal(aliceAuth.data.user.id, 'u_alice');
  assert.equal(aliceAuth.data.user.realName, 'Алиса Командная');
  assert.equal(aliceAuth.data.user.registered, true);
  assert.equal(aliceAuth.data.user.birthday, '09.11.2000');
  const stateAfterAliceAuth = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.equal(stateAfterAliceAuth.users.filter((user) => user.telegramId === '200').length, 1);
  assert.equal(stateAfterAliceAuth.users.length, fixture.users.length);
  const firstAliceSession = aliceAuth.response.headers.get('set-cookie').split(';')[0];
  const rotatedAliceAuth = await request('/api/user/get-or-create', {
    initData: telegramInitData(aliceTelegram),
  });
  const rotatedAliceSession = rotatedAliceAuth.response.headers.get('set-cookie').split(';')[0];
  assert.notEqual(rotatedAliceSession, firstAliceSession);
  assert.equal((await request('/api/state', undefined, { cookie: firstAliceSession })).response.status, 401);
  assert.equal((await request('/api/state', undefined, { cookie: rotatedAliceSession })).response.status, 200);
  const logout = await request('/api/auth/logout', {}, { cookie: rotatedAliceSession });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);
  const revokedSession = await request('/api/state', undefined, { cookie: rotatedAliceSession });
  assert.equal(revokedSession.response.status, 401);
  assert.match(revokedSession.data.error, /Открой Mini App/);
  const activeAliceAuth = await request('/api/user/get-or-create', {
    initData: telegramInitData(aliceTelegram),
  });
  sessionCookie = activeAliceAuth.response.headers.get('set-cookie').split(';')[0];

  const duplicateClaim = await request('/api/user/get-or-create', {
    initData: telegramInitData({ id: 201, username: 'alice' }),
  });
  assert.equal(duplicateClaim.response.status, 403);

  const unknownAuth = await request('/api/user/get-or-create', {
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
  const menuButtonCall = telegramCalls.find((call) => call.path.endsWith('/setChatMenuButton') && String(call.body.chat_id) === '200');
  assert.ok(menuButtonCall, 'the private chat must receive its own Mini App menu button configuration');
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
  assert.deepEqual(adminMenuCall.body.reply_markup.keyboard.map((row) => row.length), [3, 3]);
  assert.equal(adminMenuCall.body.reply_markup.is_persistent, false);
  assert.equal(adminMenuCall.body.reply_markup.one_time_keyboard, false);
  assert.deepEqual(
    adminMenuCall.body.reply_markup.keyboard.flat().map((button) => button.text),
    ['Профиль', 'Слоты', 'Встречи', 'Задачи', 'МФ', 'Помощь'],
  );

  const aliceSessionBeforeAdmin = sessionCookie;
  const adminAuth = await request('/api/user/get-or-create', {
    initData: telegramInitData({ id: 100, username: 'admin', first_name: 'Админ' }),
  });
  assert.equal(adminAuth.response.status, 200);
  sessionCookie = adminAuth.response.headers.get('set-cookie').split(';')[0];
  const adminSessionCookie = sessionCookie;
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
  const avatarUpdate = await request('/api/user/update', {
    requesterId: 'u_admin',
    userId: 'u_admin',
    avatarDataUrl: `data:image/webp;base64,${'a'.repeat(64)}`,
  });
  assert.equal(avatarUpdate.response.status, 200);
  assert.match(avatarUpdate.data.user.avatarDataUrl, /^data:image\/webp;base64,/);

  sessionCookie = aliceSessionBeforeAdmin;
  const selfProfileUpdate = await request('/api/user/update', {
    requesterId: 'u_alice',
    userId: 'u_alice',
    realName: 'Алиса Обновлённая',
    username: '@alice_new',
    birthday: '10.11.2000',
    competencies: ['Дизайн'],
    primaryCompetency: 'Дизайн',
  });
  assert.equal(selfProfileUpdate.response.status, 200);
  assert.equal(selfProfileUpdate.data.user.realName, 'Алиса Обновлённая');
  assert.equal(selfProfileUpdate.data.user.username, '@alice_new');
  assert.equal(selfProfileUpdate.data.user.birthday, '10.11.2000');

  const selfRoleEscalation = await request('/api/user/update', {
    requesterId: 'u_alice',
    userId: 'u_alice',
    role: 'admin',
  });
  assert.equal(selfRoleEscalation.response.status, 403);
  const selfProfileRestore = await request('/api/user/update', {
    requesterId: 'u_alice',
    userId: 'u_alice',
    realName: 'Алиса Командная',
    username: '@alice',
    birthday: '09.11.2000',
    competencies: ['Дизайн'],
    primaryCompetency: 'Дизайн',
  });
  assert.equal(selfProfileRestore.response.status, 200);
  sessionCookie = adminSessionCookie;

  const createEvent = await request('/api/event/create', {
    requesterId: 'u_admin',
    name: 'Тестовое мероприятие',
    description: 'Изолирует задачи интеграционного теста',
    startsAt: '01.01.30',
    endsAt: '31.12.30',
  });
  assert.equal(createEvent.response.status, 200);
  assert.equal(createEvent.data.event.status, 'active');
  createdEventId = createEvent.data.event.id;
  const archiveEvent = await request('/api/event/update', { requesterId: 'u_admin', eventId: createdEventId, status: 'archived' });
  assert.equal(archiveEvent.response.status, 200);
  assert.equal(archiveEvent.data.event.status, 'archived');
  const reactivateEvent = await request('/api/event/update', { requesterId: 'u_admin', eventId: createdEventId, status: 'active' });
  assert.equal(reactivateEvent.response.status, 200);
  assert.equal(reactivateEvent.data.event.status, 'active');
  const renameEvent = await request('/api/event/update', { requesterId: 'u_admin', eventId: createdEventId, name: 'Тестовое мероприятие — обновлено', description: 'Новое описание' });
  assert.equal(renameEvent.response.status, 200);
  assert.equal(renameEvent.data.event.name, 'Тестовое мероприятие — обновлено');

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
  assert.notEqual(meetingsMenu.body.disable_notification, true);
  const meetingsButtons = meetingsMenu.body.reply_markup.keyboard.flat().map((button) => button.text);
  assert.deepEqual(meetingsButtons, ['Назначить собрание', 'Меню', 'Назад']);

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
  for (const [updateId, messageText] of [[1021, 'Назначить собрание'], [1022, 'Выбрать блок']]) {
    await request('/api/telegram-webhook', {
      update_id: updateId,
      message: { message_id: updateId, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: messageText },
    });
  }
  const competencyPicker = telegramCalls.filter((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard).at(-1);
  assert.deepEqual(competencyPicker.body.reply_markup.keyboard[0].map((button) => button.text), ['Меню', 'Назад']);
  assert.ok(competencyPicker.body.reply_markup.keyboard.slice(1).every((row) => row.length <= 3));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1023,
    message: { message_id: 1023, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: '/start' },
  });
  const menuAfterStaleFlowReset = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.ok(menuAfterStaleFlowReset.body.reply_markup.keyboard.flat().some((button) => button.text === 'Профиль'));

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
  assert.equal(tasksMenu.body.disable_notification, true);
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
  const openTasksPanel = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && String(call.body.text || '').includes('Свободных задач'));
  assert.equal(openTasksPanel.body.disable_notification, true);
  assert.ok(!openTasksPanel.body.reply_markup?.inline_keyboard?.flat().some((button) => button.text === 'Назад'));
  const openTasksNavigation = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.deepEqual(openTasksNavigation.body.reply_markup.keyboard.flat().map((button) => button.text), ['Меню']);
  assert.equal(openTasksNavigation.body.text, '\u2063');
  assert.equal(openTasksNavigation.body.reply_markup.is_persistent, true);

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
  assert.equal(completedTasksMenu.body.disable_notification, true);
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
  const slotsNavigationCall = telegramCalls.find((call) => (
    call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard
  ));
  assert.deepEqual(slotsNavigationCall.body.reply_markup.keyboard.flat().map((button) => button.text), ['Меню']);
  assert.equal(slotsNavigationCall.body.text, '\u2063');
  assert.equal(slotsNavigationCall.body.reply_markup.is_persistent, true);
  assert.ok(slotsNavigationCall.resultMessageId > slotsSendCall.resultMessageId, 'reply navigation must be sent after the inline slot panel');
  const slotsNavigationState = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.equal(slotsNavigationState.navigation['200'], slotsNavigationCall.resultMessageId, 'reply navigation anchor must survive a bot restart');
  assert.deepEqual(slotsSendCall.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data), ['slot_edit']);
  const slotsPanelId = slotsSendCall.resultMessageId;

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1100,
    callback_query: {
      id: 'slots-edit-weeks',
      from: aliceTelegram,
      data: 'slot_edit',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/editMessageText') && call.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'slot_week:1')));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 11001,
    callback_query: {
      id: 'slots-open-next-week',
      from: aliceTelegram,
      data: 'slot_week:1',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1101,
    callback_query: {
      id: 'slots-out-next-week',
      from: aliceTelegram,
      data: 'slot_out_week:1',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  let outDraftState = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.deepEqual(outDraftState.slotDrafts['200'].outWeekIndexes, [1]);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1102,
    callback_query: {
      id: 'slots-out-next-week-cancel',
      from: aliceTelegram,
      data: 'slot_out_week:1',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  outDraftState = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.deepEqual(outDraftState.slotDrafts['200'].outWeekIndexes, []);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1103,
    callback_query: {
      id: 'slots-open-first-week',
      from: aliceTelegram,
      data: 'slot_week:0',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });

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
  assert.ok(dayPanelEdit.body.reply_markup.inline_keyboard.flat().some((button) => button.text === 'Не смогу' && button.callback_data === 'slot_unavailable:2'));
  assert.ok(dayPanelEdit.body.reply_markup.inline_keyboard.some((row) => (
    row.some((button) => button.callback_data === 'slot_toggle_day:2')
    && row.some((button) => button.callback_data === 'slot_unavailable:2')
  )));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 129,
    callback_query: {
      id: 'slots-unavailable',
      from: aliceTelegram,
      data: 'slot_unavailable:2',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const unavailableDayEdit = telegramCalls.find((call) => call.path.endsWith('/editMessageText'));
  assert.ok(unavailableDayEdit.body.reply_markup.inline_keyboard.flat().some((button) => button.text === '✅ Не смогу'));
  const unavailableDraftState = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.deepEqual(unavailableDraftState.slotDrafts['200'].hardUnavailableDays, [2]);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1291,
    callback_query: {
      id: 'slots-unavailable-cancel',
      from: aliceTelegram,
      data: 'slot_cancel_day:2',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const cancelledUnavailableDraft = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.deepEqual(cancelledUnavailableDraft.slotDrafts['200'].hardUnavailableDays, []);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1292,
    callback_query: {
      id: 'slots-day-after-unavailable-cancel',
      from: aliceTelegram,
      data: 'slots_day:2',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });

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
  assert.deepEqual(slotDraftState.slotDrafts['200'].slots['2'], [17, 18, 19, 20, 21, 22, 23]);
  assert.ok(wholeDayEdit.body.reply_markup.inline_keyboard.flat().some((button) => button.text === 'Снять весь день'));
  assert.ok(wholeDayEdit.body.reply_markup.inline_keyboard.flat().some((button) => button.text === 'Отменить' && button.callback_data === 'slot_cancel_day:2'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1301,
    callback_query: {
      id: 'slots-cancel-day',
      from: aliceTelegram,
      data: 'slot_cancel_day:2',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const cancelledDayEdit = telegramCalls.find((call) => call.path.endsWith('/editMessageText'));
  assert.ok(cancelledDayEdit.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'slots_day:2' && button.text === 'Ср · 0/7'));
  const cancelledDraftState = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.equal(cancelledDraftState.slotDrafts['200'].slots['2'], undefined);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1302,
    callback_query: {
      id: 'slots-day-again',
      from: aliceTelegram,
      data: 'slots_day:2',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1303,
    callback_query: {
      id: 'slots-whole-day-again',
      from: aliceTelegram,
      data: 'slot_toggle_day:2',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });

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
      data: 'slot_week:0',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const slotsDaysCall = telegramCalls.find((call) => call.path.endsWith('/editMessageText'));
  assert.ok(slotsDaysCall);
  assert.ok(slotsDaysCall.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'slots_day:2' && button.text === 'Ср · 6/7'));
  assert.ok(!slotsDaysCall.body.reply_markup.inline_keyboard.flat().some((button) => ['slots_day:5', 'slots_day:6'].includes(button.callback_data)));
  assert.ok(String(slotsDaysCall.body.text || '').includes('Ср:'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 14,
    callback_query: {
      id: 'slots-save',
      from: aliceTelegram,
      data: 'slot_save_week:0',
      message: { message_id: slotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const slotsSavedMenu = telegramCalls.find((call) => call.path.endsWith('/editMessageText'));
  assert.ok(slotsSavedMenu);
  const slotsSavedButtons = slotsSavedMenu.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(slotsSavedButtons, ['slot_edit']);
  const slotsSavedDatabase = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.deepEqual(slotsSavedDatabase.availabilities.u_alice.slots['2'], [17, 18, 19, 20, 21, 22]);
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
  assert.ok(String(reopenedSlots.body.text).includes('Ср: 17:00, 18:00, 19:00, 20:00, 21:00, 22:00'));
  assert.deepEqual(reopenedSlots.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data), ['slot_edit']);
  const reopenedSlotsPanelId = reopenedSlots.resultMessageId;

  for (const [updateId, id, data] of [[1411, 'slots-edit-again', 'slot_edit'], [1412, 'slots-week-again', 'slot_week:0']]) {
    telegramCalls.length = 0;
    await request('/api/telegram-webhook', {
      update_id: updateId,
      callback_query: { id, from: aliceTelegram, data, message: { message_id: reopenedSlotsPanelId, chat: { id: 200, type: 'private' } } },
    });
  }

  telegramCalls.length = 0;
  await Promise.all([
    request('/api/telegram-webhook', {
      update_id: 144,
      callback_query: {
        id: 'slots-rapid-16',
        from: aliceTelegram,
        data: 'slot_toggle:0:16',
        message: { message_id: reopenedSlotsPanelId, chat: { id: 200, type: 'private' } },
      },
    }),
    request('/api/telegram-webhook', {
      update_id: 145,
      callback_query: {
        id: 'slots-rapid-17',
        from: aliceTelegram,
        data: 'slot_toggle:0:17',
        message: { message_id: reopenedSlotsPanelId, chat: { id: 200, type: 'private' } },
      },
    }),
  ]);
  const rapidToggleDraft = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.deepEqual(rapidToggleDraft.slotDrafts['200'].slots['0'], [17]);

  telegramCalls.length = 0;
  failNextTelegramEdit = true;
  await request('/api/telegram-webhook', {
    update_id: 146,
    callback_query: {
      id: 'slots-edit-recovery',
      from: aliceTelegram,
      data: 'slot_toggle:0:18',
      message: { message_id: reopenedSlotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/editMessageText')));
  const recoveredPanel = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.inline_keyboard);
  assert.ok(recoveredPanel, 'a failed Telegram edit must be recovered by sending one replacement panel');
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/deleteMessage') && call.body.message_id === reopenedSlotsPanelId));
  const recoveredPanelId = recoveredPanel.resultMessageId;
  const recoveredDraft = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.deepEqual(recoveredDraft.slotDrafts['200'].slots['0'], [17, 18]);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 147,
    callback_query: {
      id: 'slots-old-after-recovery',
      from: aliceTelegram,
      data: 'slot_toggle:0:19',
      message: { message_id: reopenedSlotsPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  assert.ok(!telegramCalls.some((call) => call.path.endsWith('/editMessageText')));
  const afterStaleRecoveryDraft = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.deepEqual(afterStaleRecoveryDraft.slotDrafts['200'].slots['0'], [17, 18]);
  assert.ok(Number.isInteger(recoveredPanelId));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 148,
    callback_query: {
      id: 'slots-save-after-recovery',
      from: aliceTelegram,
      data: 'slot_save_week:0',
      message: { message_id: recoveredPanelId, chat: { id: 200, type: 'private' } },
    },
  });
  const savedAfterRecovery = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.deepEqual(savedAfterRecovery.availabilities.u_alice.slots['0'], [17, 18]);
  assert.deepEqual(savedAfterRecovery.availabilities.u_alice.slots['2'], [17, 18, 19, 20, 21, 22]);
  assert.equal((JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'))).slotDrafts['200'], undefined);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 149,
    message: {
      message_id: 149,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Слоты',
    },
  });
  const reopenedAfterRecovery = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.inline_keyboard);
  assert.ok(reopenedAfterRecovery);
  assert.deepEqual(reopenedAfterRecovery.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data), ['slot_edit']);

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

  await saveAvailabilityWeek('u_alice', 0, { 0: [18, 19] }, [1, 2, 2, 99, 'bad']);
  const availability = await saveAvailabilityWeek('u_alice', 1, {}, [], true);
  assert.equal(availability.response.status, 200);
  assert.deepEqual(availability.data.availability.hardUnavailableDays, [1, 2]);
  assert.deepEqual(availability.data.availability.outWeekIndexes, [1]);

  const availabilityWeekStarts = [currentWeekStart(), new Date(Date.parse(`${currentWeekStart()}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10)];
  const initialWeekVersions = availability.data.availability.weekVersions;
  const saveSecondWeek = await saveAvailabilityWeek('u_alice', 1, { 0: [20], 2: [21] }, [4], false, initialWeekVersions[availabilityWeekStarts[1]]);
  assert.equal(saveSecondWeek.response.status, 200);
  const saveFirstWeek = await saveAvailabilityWeek('u_alice', 0, { 0: [22] }, [3], false, initialWeekVersions[availabilityWeekStarts[0]]);
  assert.equal(saveFirstWeek.response.status, 200);
  assert.deepEqual(saveFirstWeek.data.availability.slots[0], [22]);
  assert.deepEqual(saveFirstWeek.data.availability.slots[7], [20], 'saving week A must preserve week B from another client');
  assert.deepEqual(saveFirstWeek.data.availability.slots[9], [21]);
  const staleSecondWeek = await saveAvailabilityWeek('u_alice', 1, { 0: [17] }, [], false, initialWeekVersions[availabilityWeekStarts[1]]);
  assert.equal(staleSecondWeek.response.status, 409, 'stale same-week writes must be rejected');
  await saveAvailabilityWeek('u_alice', 0, { 0: [18, 19] }, [1, 2]);
  const restoredAvailability = await saveAvailabilityWeek('u_alice', 1, {}, [], true);
  assert.equal(restoredAvailability.response.status, 200);

  telegramCalls.length = 0;
  const invalidTaskDate = await request('/api/task/create', {
    title: 'Несуществующая дата',
    deadline: '32.13.27',
    assignedTo: [],
    creatorId: 'u_admin',
  });
  assert.equal(invalidTaskDate.response.status, 400);
  assert.ok(invalidTaskDate.data.fieldErrors.deadline);
  const invalidTaskShape = await request('/api/task/create', {
    title: 'x'.repeat(161), deadline: '2030-01-01', assignedTo: 'u_alice',
    creatorId: 'u_admin', priority: 'urgent', reminders: [{ type: 'sometimes', unit: 'minutes', value: 'NaN' }],
  });
  assert.equal(invalidTaskShape.response.status, 400);
  assert.deepEqual(Object.keys(invalidTaskShape.data.fieldErrors).sort(), ['assignedTo', 'priority', 'reminders', 'title']);
  assert.equal(telegramCalls.length, 0, 'invalid task payloads must not notify anyone');
  const taskResult = await request('/api/task/create', {
    title: 'Проверка уведомлений',
    description: 'Интеграционный сценарий',
    deadline: '2030-01-01',
    assignedTo: ['u_alice', 'u_bob', 'u_alice', 'missing'],
    creatorId: 'u_admin',
    competencies: ['Дизайн', 'Продакшн'],
    priority: 'critical',
    eventId: createdEventId,
  });
  assert.equal(taskResult.response.status, 200);
  assert.deepEqual(taskResult.data.task.assignedTo, ['u_alice', 'u_bob']);
  assert.equal(taskResult.data.task.assignmentMode, 'shared');
  assert.equal(taskResult.data.task.completedBy, undefined);
  assert.equal(taskResult.data.task.priority, 'critical');
  assert.deepEqual(taskResult.data.task.competencies, ['Дизайн', 'Продакшн']);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 2);
  assert.ok(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).every((call) => call.body.disable_notification === true));

  telegramCalls.length = 0;
  const openTaskResult = await request('/api/task/create', {
    title: 'Открытая задача автора',
    description: 'Проверка уведомления самому автору',
    deadline: '2030-01-05',
    assignedTo: [],
    creatorId: 'u_alice',
    competency: 'Дизайн',
    priority: 'important',
    eventId: createdEventId,
  });
  assert.equal(openTaskResult.response.status, 200);
  assert.ok(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).every((call) => call.body.disable_notification === true));
  const openTaskAppLinks = telegramCalls
    .filter((call) => call.path.endsWith('/sendMessage'))
    .flatMap((call) => call.body.reply_markup?.inline_keyboard?.flat() || [])
    .map((button) => button.web_app?.url)
    .filter(Boolean);
  assert.ok(openTaskAppLinks.length > 0);
  assert.ok(openTaskAppLinks.every((url) => new URL(url).searchParams.get('tab') === 'tasks'));

  const sessionBeforeParityChecks = sessionCookie;
  sessionCookie = adminSessionCookie;
  const cancelledDuringCompletion = await request('/api/task/create', {
    title: 'Отмена во время завершения', description: '', deadline: '2030-01-06', assignedTo: ['u_alice'], creatorId: 'u_admin', priority: 'normal',
  });
  assert.equal(cancelledDuringCompletion.response.status, 200);
  for (const update of [
    { update_id: 10501, callback_query: { id: 'parity-complete-start', from: aliceTelegram, data: `task_complete:${cancelledDuringCompletion.data.task.id}`, message: { message_id: 10501, chat: { id: 200, type: 'private' } } } },
    { update_id: 10502, message: { message_id: 10502, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: 'Не указывать' } },
  ]) await request('/api/telegram-webhook', update);
  const cancelDuringFlow = await request('/api/task/delete', { requesterId: 'u_admin', taskId: cancelledDuringCompletion.data.task.id });
  assert.equal(cancelDuringFlow.response.status, 200);
  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 10503,
    message: { message_id: 10503, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: 'Без комментария' },
  });
  let parityState = (await request('/api/state')).data;
  assert.equal(parityState.tasks.find((task) => task.id === cancelledDuringCompletion.data.task.id).status, 'cancelled');
  assert.ok(telegramCalls.some((call) => String(call.body.text || '').includes('Задача отменена')));
  await request('/api/telegram-webhook', {
    update_id: 10504,
    callback_query: { id: 'parity-release-stale', from: aliceTelegram, data: `task_release:${cancelledDuringCompletion.data.task.id}`, message: { message_id: 10504, chat: { id: 200, type: 'private' } } },
  });
  parityState = (await request('/api/state')).data;
  assert.equal(parityState.tasks.find((task) => task.id === cancelledDuringCompletion.data.task.id).status, 'cancelled');

  const navigationDuringCompletion = await request('/api/task/create', {
    title: 'Навигация вместо комментария', description: '', deadline: '2030-01-06', assignedTo: ['u_alice'], creatorId: 'u_admin', priority: 'normal',
  });
  for (const update of [
    { update_id: 10505, callback_query: { id: 'parity-menu-start', from: aliceTelegram, data: `task_complete:${navigationDuringCompletion.data.task.id}`, message: { message_id: 10505, chat: { id: 200, type: 'private' } } } },
    { update_id: 10506, message: { message_id: 10506, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: 'Не указывать' } },
    { update_id: 10507, message: { message_id: 10507, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: 'Задачи' } },
    { update_id: 10508, message: { message_id: 10508, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: 'Без комментария' } },
  ]) await request('/api/telegram-webhook', update);
  parityState = (await request('/api/state')).data;
  assert.equal(parityState.tasks.find((task) => task.id === navigationDuringCompletion.data.task.id).status, 'assigned');
  const navigationTaskCleanup = await request('/api/task/delete', {
    taskId: navigationDuringCompletion.data.task.id,
  });
  assert.equal(navigationTaskCleanup.response.status, 200);

  const meetingsBeforeInvalidChat = parityState.meetings.length;
  for (const [updateId, messageText] of [
    [10509, 'Назначить собрание'], [10510, 'Собрать всю команду'], [10511, 'Ночная встреча'],
    [10512, 'Пропустить'], [10513, '31.12.2030'], [10514, '03:00'],
  ]) await request('/api/telegram-webhook', {
    update_id: updateId,
    message: { message_id: updateId, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: messageText },
  });
  parityState = (await request('/api/state')).data;
  assert.equal(parityState.meetings.length, meetingsBeforeInvalidChat);
  assert.ok(telegramCalls.some((call) => String(call.body.text || '').includes('Встреча должна полностью помещаться')));
  await request('/api/telegram-webhook', {
    update_id: 10515,
    message: { message_id: 10515, chat: { id: 200, type: 'private' }, from: aliceTelegram, text: 'Меню' },
  });
  sessionCookie = sessionBeforeParityChecks;

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1061,
    callback_query: {
      id: 'legacy-task-view',
      from: aliceTelegram,
      data: `task_view:${openTaskResult.data.task.id}`,
      message: { message_id: 10061, chat: { id: 200, type: 'private' } },
    },
  });
  const upgradedLegacyTaskButton = telegramCalls.find((call) => call.path.endsWith('/editMessageReplyMarkup'));
  assert.equal(new URL(upgradedLegacyTaskButton.body.reply_markup.inline_keyboard[0][0].web_app.url).searchParams.get('tab'), 'tasks');
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/answerCallbackQuery') && String(call.body.text || '').includes('нажми ещё раз')));
  const legacyTaskNavigation = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.deepEqual(legacyTaskNavigation.body.reply_markup.keyboard.flat().map((button) => button.text), ['Меню']);
  assert.equal(legacyTaskNavigation.body.reply_markup.is_persistent, true);

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
    competencies: ['Продакшн', 'Дизайн'],
  });
  assert.equal(editedTask.response.status, 200);
  assert.deepEqual(editedTask.data.task.assignedTo, ['u_alice', 'u_bob']);
  assert.equal(editedTask.data.task.reminders.length, 1);
  assert.deepEqual(editedTask.data.task.competencies, ['Продакшн', 'Дизайн']);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1071,
    message: {
      message_id: 1071,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Управлять задачами',
    },
  });
  const taskManagementCards = telegramCalls.filter((call) => (
    call.path.endsWith('/sendMessage')
    && call.body.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data?.startsWith('task_complete:'))
  ));
  assert.equal(taskManagementCards.length, 2, 'each active task must have its own Telegram card');
  assert.ok(taskManagementCards.every((call) => (
    call.body.reply_markup.inline_keyboard.length === 1
    && call.body.reply_markup.inline_keyboard[0].length === 2
  )));
  assert.ok(taskManagementCards.every((call) => call.body.disable_notification === true));
  const taskManagementNavigation = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && call.body.reply_markup?.keyboard);
  assert.deepEqual(taskManagementNavigation.body.reply_markup.keyboard.flat().map((button) => button.text), ['Меню']);
  const taskManagementCardIds = taskManagementCards.map((call) => call.resultMessageId);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 1072,
    message: {
      message_id: 1072,
      chat: { id: 200, type: 'private' },
      from: aliceTelegram,
      text: 'Меню',
    },
  });
  const deletedTaskManagementIds = telegramCalls
    .filter((call) => call.path.endsWith('/deleteMessage'))
    .map((call) => call.body.message_id);
  assert.ok(taskManagementCardIds.every((messageId) => deletedTaskManagementIds.includes(messageId)), 'all task cards must be deleted when leaving task management');

  const executorComment = await request('/api/task/comment', {
    requesterId: 'u_alice',
    taskId: openTaskResult.data.task.id,
    assigneeId: 'stale-client-assignee-id',
    side: 'executor',
    text: 'Собираю материалы',
  });
  assert.equal(executorComment.response.status, 200);
  assert.equal(executorComment.data.task.assigneeNotes.u_alice.executor, 'Собираю материалы');
  const secondExecutorComment = await request('/api/task/comment', {
    requesterId: 'u_alice',
    taskId: openTaskResult.data.task.id,
    assigneeId: 'u_alice',
    side: 'executor',
    text: 'Материалы готовы, начинаю сборку',
  });
  assert.equal(secondExecutorComment.response.status, 200);
  assert.equal(secondExecutorComment.data.task.assigneeNotes.u_alice.history.length, 2);
  assert.deepEqual(secondExecutorComment.data.task.assigneeNotes.u_alice.history.map((comment) => comment.text), ['Собираю материалы', 'Материалы готовы, начинаю сборку']);
  assert.ok(secondExecutorComment.data.task.assigneeNotes.u_alice.history.every((comment) => comment.authorId === 'u_alice'));
  const coordinatorComment = await request('/api/task/comment', {
    requesterId: 'u_alice',
    taskId: openTaskResult.data.task.id,
    assigneeId: 'u_bob',
    side: 'coordinator',
    text: 'Борис отвечает за проверку',
  });
  assert.equal(coordinatorComment.response.status, 200);
  assert.equal(coordinatorComment.data.task.assigneeNotes.u_bob.coordinator, 'Борис отвечает за проверку');

  telegramCalls.length = 0;
  const manualReminder = await request('/api/task/notify', {
    requesterId: 'u_alice',
    taskId: openTaskResult.data.task.id,
  });
  assert.equal(manualReminder.response.status, 200);
  assert.equal(manualReminder.data.queued, 2);
  assert.ok(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).every((call) => call.body.disable_notification === true));

  const completedCurrentWeekForBroadcast = await saveAvailabilityWeek('u_alice', 0, { 0: [18], 1: [18], 2: [18], 3: [18], 4: [18] });
  assert.equal(completedCurrentWeekForBroadcast.response.status, 200);

  const sessionBeforeBroadcast = sessionCookie;
  sessionCookie = adminSessionCookie;

  telegramCalls.length = 0;
  const missingSlotsBroadcast = await request('/api/team/broadcast', {
    requesterId: 'u_admin',
    recipientMode: 'missing_slots',
    availabilityWeekIndex: 0,
    body: 'Пожалуйста, отметьте слоты на эту неделю',
  });
  assert.equal(missingSlotsBroadcast.response.status, 200);
  assert.equal(missingSlotsBroadcast.data.recipients, 2);
  assert.equal(missingSlotsBroadcast.data.availabilityWeekIndex, 0);
  assert.deepEqual(
    telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).map((call) => String(call.body.chat_id)).sort(),
    ['100', '300'],
  );

  telegramCalls.length = 0;
  const missingNextWeekBroadcast = await request('/api/team/broadcast', {
    requesterId: 'u_admin',
    recipientMode: 'missing_slots',
    availabilityWeekIndex: 1,
    body: 'Пожалуйста, отметьте слоты на следующую неделю',
  });
  assert.equal(missingNextWeekBroadcast.response.status, 200);
  assert.equal(missingNextWeekBroadcast.data.recipients, 2, 'saving the current week must preserve the submitted next week');
  assert.equal(missingNextWeekBroadcast.data.availabilityWeekIndex, 1);
  assert.deepEqual(
    telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).map((call) => String(call.body.chat_id)).sort(),
    ['100', '300'],
  );

  telegramCalls.length = 0;
  const blockBroadcast = await request('/api/team/broadcast', {
    requesterId: 'u_admin',
    recipientMode: 'blocks',
    competencies: ['Дизайн'],
    recipientIds: [],
    title: 'Проверка рассылки',
    body: 'Сообщение участникам выбранного блока',
  });
  assert.equal(blockBroadcast.response.status, 200);
  assert.equal(blockBroadcast.data.recipients, 2);
  assert.equal(blockBroadcast.data.delivered, 2);
  assert.ok(telegramCalls.every((call) => !call.path.endsWith('/sendMessage') || ['100', '200'].includes(String(call.body.chat_id))));
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/sendMessage') && String(call.body.text || '').includes('Автор:')));

  sessionCookie = sessionBeforeBroadcast;
  telegramCalls.length = 0;
  const memberBroadcast = await request('/api/team/broadcast', {
    requesterId: 'u_admin',
    recipientMode: 'people',
    recipientIds: ['u_bob'],
    body: 'Рассылка от обычного участника команды',
  });
  assert.equal(memberBroadcast.response.status, 200);
  const memberBroadcastMessage = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.ok(String(memberBroadcastMessage?.body.text || '').includes('Автор:'));
  assert.ok(String(memberBroadcastMessage?.body.text || '').includes('Алиса Командная'));
  sessionCookie = adminSessionCookie;

  const unlinkedUser = await request('/api/user/add', {
    requesterId: 'spoofed-user-id',
    realName: 'Неподключённый Участник',
    username: '@unlinked_user',
    role: 'organizer',
  });
  assert.equal(unlinkedUser.response.status, 200);

  telegramCalls.length = 0;
  const peopleBroadcast = await request('/api/team/broadcast', {
    requesterId: 'spoofed-user-id',
    recipientMode: 'people',
    recipientIds: ['u_bob', unlinkedUser.data.user.id, 'missing'],
    body: 'Персональная рассылка',
  });
  assert.equal(peopleBroadcast.response.status, 200);
  assert.equal(peopleBroadcast.data.recipients, 2);
  assert.equal(peopleBroadcast.data.delivered, 1);
  assert.equal(peopleBroadcast.data.unavailable, 1);
  assert.equal(peopleBroadcast.data.failed, 0);
  assert.equal(String(telegramCalls.find((call) => call.path.endsWith('/sendMessage')).body.chat_id), '300');

  const unavailableBroadcast = await request('/api/team/broadcast', {
    requesterId: 'u_admin',
    recipientMode: 'people',
    recipientIds: [unlinkedUser.data.user.id],
    body: 'Некому доставить',
  });
  assert.equal(unavailableBroadcast.response.status, 409);
  assert.equal(unavailableBroadcast.data.unavailable, 1);

  telegramCalls.length = 0;
  failNextTelegramSend = true;
  const rejectedBroadcast = await request('/api/team/broadcast', {
    requesterId: 'u_admin',
    recipientMode: 'people',
    recipientIds: ['u_bob'],
    body: 'Telegram отклонит сообщение',
  });
  assert.equal(rejectedBroadcast.response.status, 502);
  assert.equal(rejectedBroadcast.data.delivered, 0);
  assert.equal(rejectedBroadcast.data.failed, 1);
  const unlinkedAuth = await request('/api/user/get-or-create', {
    initData: telegramInitData({ id: 555, username: 'unlinked_user', first_name: 'Неподключённый' }),
  });
  assert.equal(unlinkedAuth.response.status, 200);
  const unlinkedSessionCookie = unlinkedAuth.response.headers.get('set-cookie').split(';')[0];
  const removeUnlinkedUser = await request('/api/user/delete', {
    requesterId: 'u_admin',
    userId: unlinkedUser.data.user.id,
  });
  assert.equal(removeUnlinkedUser.response.status, 200);
  assert.equal(removeUnlinkedUser.data.user.active, false);
  assert.ok(removeUnlinkedUser.data.user.deactivatedAt);
  const stateAfterDeactivation = await request('/api/state');
  assert.equal(stateAfterDeactivation.data.users.find((user) => user.id === unlinkedUser.data.user.id).active, false);
  const deletedUserSession = await request('/api/state', undefined, { cookie: unlinkedSessionCookie });
  assert.equal(deletedUserSession.response.status, 401);
  sessionCookie = sessionBeforeBroadcast;

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
  assert.equal(completionTimeMenu.body.disable_notification, true);
  assert.ok(completionTimeMenu.body.reply_markup.keyboard.flat().some((button) => button.text === 'Не указывать'));
  assert.ok(String(completionTimeMenu.body.text || '').includes('завершение закроет её для всех'));

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
  assert.equal(completedChatTask.completedBy, 'u_alice');
  assert.equal(completedChatTask.completionComments.u_alice, 'Заняло дольше из-за согласования макета');

  telegramCalls.length = 0;
  delayNextTelegramSendMs = 400;
  const meetingRequest = request('/api/meeting', {
    title: 'Общая встреча',
    type: 'general',
    date: '2030-01-02',
    time: '18:00',
    duration: 6,
    hostId: 'u_admin',
    participants: 'all',
    topic: 'Проверка',
    description: '',
  });
  let notificationStarted = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    notificationStarted = telegramCalls.some((call) => call.path.endsWith('/sendMessage'));
    if (notificationStarted) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(notificationStarted, true, 'meeting notification must start');
  const stateWhileNotifying = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  const meetingPersistedBeforeNotification = stateWhileNotifying.meetings.some((meeting) => meeting.title === 'Общая встреча');
  assert.equal(meetingPersistedBeforeNotification, true, 'meeting must be durable before Telegram delivery completes');
  const meetingResult = await meetingRequest;
  assert.equal(meetingResult.response.status, 200);
  assert.equal(meetingResult.data.meeting.duration, 6);
  assert.deepEqual(meetingResult.data.meeting.attendeeIds, ['u_alice']);
  const invalidMeetingDuration = await request('/api/meeting', {
    title: 'Слишком длинная встреча',
    type: 'general',
    date: '2030-01-02',
    time: '18:00',
    duration: 6.5,
    hostId: 'u_admin',
    participants: 'all',
  });
  assert.equal(invalidMeetingDuration.response.status, 400);
  const invalidMeetingDate = await request('/api/meeting', {
    title: 'Несуществующая дата', type: 'general', date: '31.02.27', time: '18:00', duration: 1, hostId: 'u_admin', participants: 'all',
  });
  assert.equal(invalidMeetingDate.response.status, 400);
  assert.ok(invalidMeetingDate.data.fieldErrors.date);
  const notificationsBeforeInvalidMeetingShapes = telegramCalls.length;
  const invalidMeetingShape = await request('/api/meeting', {
    title: 'x'.repeat(161), kind: 'webinar', type: 'everyone', date: '2030-01-02', time: '24:60', duration: 'NaN', hostId: 'u_admin', participants: 'u_alice',
  });
  assert.equal(invalidMeetingShape.response.status, 400);
  assert.deepEqual(Object.keys(invalidMeetingShape.data.fieldErrors).sort(), ['duration', 'kind', 'participants', 'time', 'title', 'type']);
  const pastMeeting = await request('/api/meeting', {
    title: 'Событие в прошлом', kind: 'vibe', type: 'general', date: '2020-01-01', time: '12:00', duration: 1, hostId: 'u_admin', participants: 'all',
  });
  assert.equal(pastMeeting.response.status, 400);
  assert.ok(pastMeeting.data.fieldErrors.date);
  assert.equal(telegramCalls.length, notificationsBeforeInvalidMeetingShapes, 'invalid meeting payloads must not notify anyone');
  const weekendMeeting = await request('/api/meeting', {
    title: 'Встреча в выходной', type: 'general', date: '2030-01-05', time: '18:00', duration: 1, hostId: 'u_admin', participants: 'all',
  });
  assert.equal(weekendMeeting.response.status, 400);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 3);
  assert.ok(!telegramCalls.some((call) => call.body.chat_id === '400'));
  assert.ok(!telegramCalls.some((call) => String(call.body.text || '').includes('Придут:')), 'meeting notifications must not embed the attendee list');
  assert.ok(telegramCalls.some((call) => String(call.body.text || '').includes('Среда, 02.01.30')), 'meeting notifications must include the weekday and date');
  const meetingRsvpAction = `meeting_rsvp:${meetingResult.data.meeting.id}:yes`;
  const isMeetingRsvpNotification = (call) => call.path.endsWith('/sendMessage')
    && call.body.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === meetingRsvpAction);
  const hostMeetingNotification = telegramCalls.find((call) => isMeetingRsvpNotification(call) && String(call.body.chat_id) === '100');
  const aliceMeetingNotification = telegramCalls.find((call) => isMeetingRsvpNotification(call) && String(call.body.chat_id) === '200');
  assert.match(hostMeetingNotification.body.reply_markup.inline_keyboard[0][0].text, /Приду/);
  assert.match(aliceMeetingNotification.body.reply_markup.inline_keyboard[0][0].text, /Приду/);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 110,
    callback_query: {
      id: 'meeting-rsvp-callback',
      from: { id: 100, username: 'admin', first_name: 'Администратор' },
      data: meetingRsvpAction,
      message: {
        message_id: 777,
        chat: { id: 100, type: 'private' },
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Я приду', callback_data: meetingRsvpAction }],
            [{ text: 'Открыть встречи', web_app: { url: 'https://example.com' } }],
          ],
        },
      },
    },
  });
  const rsvpMarkupUpdate = telegramCalls.find((call) => call.path.endsWith('/editMessageReplyMarkup'));
  assert.ok(rsvpMarkupUpdate, 'meeting RSVP must update the pressed button');
  assert.match(rsvpMarkupUpdate.body.reply_markup.inline_keyboard[0][0].text, /выбрано/);
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/answerCallbackQuery') && String(call.body.text || '').length > 0));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 159801,
    callback_query: {
      id: 'meeting-rsvp-cancel-callback',
      from: { id: 100, username: 'admin', first_name: 'Администратор' },
      data: `meeting_rsvp:${meetingResult.data.meeting.id}:unanswered`,
      message: {
        message_id: 777,
        chat: { id: 100, type: 'private' },
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Я не приду', callback_data: meetingRsvpAction }],
            [{ text: 'Открыть встречи', web_app: { url: 'https://example.com' } }],
          ],
        },
      },
    },
  });
  const rsvpCancelMarkupUpdate = telegramCalls.find((call) => call.path.endsWith('/editMessageReplyMarkup'));
  assert.ok(rsvpCancelMarkupUpdate, 'meeting RSVP reset must update attendance');
  assert.doesNotMatch(rsvpCancelMarkupUpdate.body.reply_markup.inline_keyboard[0][0].text, /выбрано/);

  telegramCalls.length = 0;
  const declineMeeting = await request('/api/meeting/rsvp', {
    requesterId: 'u_alice',
    meetingId: meetingResult.data.meeting.id,
    response: 'no',
  });
  assert.equal(declineMeeting.response.status, 200);
  assert.equal(declineMeeting.data.response, 'no');
  assert.equal(declineMeeting.data.meeting.rsvpByUser.u_alice, 'no');
  const attendMeeting = await request('/api/meeting/rsvp', {
    requesterId: 'u_alice',
    meetingId: meetingResult.data.meeting.id,
    response: 'yes',
  });
  assert.equal(attendMeeting.response.status, 200);
  assert.equal(attendMeeting.data.response, 'yes');
  assert.ok(attendMeeting.data.meeting.attendeeIds.includes('u_alice'));
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 0, 'RSVP changes must not notify the meeting host');

  telegramCalls.length = 0;
  const meetingUpdate = await request('/api/meeting/update', {
    requesterId: 'u_admin',
    meetingId: meetingResult.data.meeting.id,
    time: '17:00',
    description: 'Обновлённое описание',
    participants: ['u_alice'],
  });
  assert.equal(meetingUpdate.response.status, 200);
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 3);
  const meetingUpdateNotification = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.ok(String(meetingUpdateNotification?.body.text || '').includes('❗Время: 18:00 → 17:00'));
  assert.ok(String(meetingUpdateNotification?.body.text || '').includes('❗Описание:'));
  assert.ok(String(meetingUpdateNotification?.body.text || '').includes('Длительность:'));
  assert.ok(String(meetingUpdateNotification?.body.text || '').includes('Что изменилось'));
  assert.ok(!String(meetingUpdateNotification?.body.text || '').includes('Придут:'));

  telegramCalls.length = 0;
  const meetingDelete = await request('/api/meeting/delete', {
    requesterId: 'u_admin',
    meetingId: meetingResult.data.meeting.id,
  });
  assert.equal(meetingDelete.response.status, 200);
  assert.equal(meetingDelete.data.meeting.status, 'cancelled');
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 1);
  assert.ok(telegramCalls.some((call) => String(call.body.text || '').includes('Среда, 02.01.30')));

  telegramCalls.length = 0;
  const taskCompletionSession = sessionCookie;
  sessionCookie = adminSessionCookie;
  const completed = await request('/api/task/status', {
    requesterId: 'u_admin',
    taskId: taskResult.data.task.id,
    status: 'completed',
    timeSpentMinutes: 95,
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.data.task.timeSpentMinutes, 95);
  assert.equal(completed.data.task.completedBy, 'u_admin');
  const completionNotification = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.ok(String(completionNotification?.body.text || '').includes('Завершил: Администратор'));
  assert.ok(!String(completionNotification?.body.text || '').includes('Борис Командный'));
  sessionCookie = taskCompletionSession;
  const reopened = await request('/api/task/status', {
    requesterId: 'u_alice', taskId: taskResult.data.task.id, status: 'in_progress',
  });
  assert.equal(reopened.response.status, 200);
  assert.equal(reopened.data.task.status, 'in_progress');
  assert.equal(reopened.data.task.timeSpentMinutes, undefined);
  assert.equal(reopened.data.task.completedBy, undefined);
  const correctedCompletion = await request('/api/task/status', {
    requesterId: 'u_alice', taskId: taskResult.data.task.id, status: 'completed', timeSpentMinutes: 80, completionComment: 'Исправленный комментарий',
  });
  assert.equal(correctedCompletion.response.status, 200);
  assert.equal(correctedCompletion.data.task.timeSpentMinutes, 80);
  assert.equal(correctedCompletion.data.task.completedBy, 'u_alice');
  assert.equal(correctedCompletion.data.task.completionComments.u_alice, 'Исправленный комментарий');
  telegramCalls.length = 0;
  sessionCookie = adminSessionCookie;
  const editedCompletion = await request('/api/task/status', {
    requesterId: 'u_admin', taskId: taskResult.data.task.id, status: 'completed', timeSpentMinutes: 80,
  });
  assert.equal(editedCompletion.response.status, 200);
  assert.equal(editedCompletion.data.task.completedBy, 'u_alice');
  assert.equal(editedCompletion.data.alreadyApplied, true);
  assert.equal(telegramCalls.some((call) => call.path.endsWith('/sendMessage')), false, 'unchanged completion retry must not notify twice');
  sessionCookie = taskCompletionSession;
  const commentAfterCompletion = await request('/api/task/comment', {
    requesterId: 'u_alice', taskId: taskResult.data.task.id, assigneeId: 'u_alice', side: 'executor', text: 'Поздний комментарий',
  });
  assert.equal(commentAfterCompletion.response.status, 409);
  const taskExportResponse = await fetch(`http://127.0.0.1:${appPort}/api/task/export`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(taskExportResponse.status, 200);
  const taskExport = await taskExportResponse.text();
  assert.ok(taskExport.includes('1 ч 20 мин'));
  assert.ok(taskExport.includes('Тестовое мероприятие'));

  const aliceSessionCookie = sessionCookie;
  const facultyAuth = await request('/api/user/get-or-create', {
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
    description: '',
    deadline: '2030-01-03',
    assignedTo: ['u_faculty', 'u_alice', 'missing'],
    reminders: [],
    eventId: createdEventId,
  });
  assert.equal(facultyTask.response.status, 200);
  assert.equal(facultyTask.data.task.eventId, createdEventId);
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
  const cancelledFacultyTask = await request('/api/task/delete', {
    requesterId: 'u_alice',
    taskId: facultyTask.data.task.id,
  });
  assert.equal(cancelledFacultyTask.response.status, 200);
  assert.equal(cancelledFacultyTask.data.task.status, 'cancelled');
  assert.ok(cancelledFacultyTask.data.task.cancelledAt);
  assert.equal(cancelledFacultyTask.data.task.cancelledBy, 'u_alice');
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 0);
  const editCancelledTask = await request('/api/faculty/task/update', {
    requesterId: 'u_alice',
    taskId: facultyTask.data.task.id,
    title: 'Этого изменения быть не должно',
  });
  assert.equal(editCancelledTask.response.status, 409);

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
    ['all', 'all_design', 'all_production', 'meeting', 'deadlines', 'slots', 'birthdays', 'checkin', 'help'],
  );
  assert.ok(!boundChatCommandsCall.body.commands.some((command) => command.command === 'start'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 20001,
    message: {
      message_id: 20001,
      message_thread_id: 321,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/bindimportant',
    },
  });
  const importantBindingMessage = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.equal(importantBindingMessage?.body.message_thread_id, 321);
  assert.ok(!telegramCalls.some((call) => call.path.endsWith('/deleteMessage') && call.body.message_id === 20001));

  telegramCalls.length = 0;
  failNextTelegramSend = true;
  const importantMeeting = await request('/api/meeting', {
    title: 'Встреча для важного топика', type: 'general', date: '03.01.30', time: '18:00', duration: 1,
    hostId: 'u_admin', participants: 'all', description: 'Проверка дублирования',
  });
  assert.equal(importantMeeting.response.status, 200);
  const importantTopicNotification = telegramCalls.find((call) => (
    call.path.endsWith('/sendMessage')
    && call.body.chat_id === '-100500'
    && call.body.message_thread_id === 321
  ));
  assert.ok(importantTopicNotification, 'meeting notifications must be duplicated into the IMPORTANT topic');
  assert.equal(telegramCalls.filter((call) => (
    call.path.endsWith('/sendMessage')
    && call.body.chat_id === '-100500'
    && call.body.message_thread_id === 321
  )).length, 1, 'a terminal 403 must not be retried blindly');
  const failedImportantDeliveries = await request('/api/notification-deliveries?status=failed', undefined, { cookie: adminSessionCookie });
  assert.equal(failedImportantDeliveries.response.status, 200);
  assert.ok(failedImportantDeliveries.data.deliveries.some((delivery) => (
    delivery.category === 'important' && delivery.lastErrorCode === '403'
  )));
  const failedImportantDelivery = failedImportantDeliveries.data.deliveries.find((delivery) => delivery.category === 'important');
  const retriedImportantDelivery = await request('/api/notification-deliveries/retry', {
    requesterId: 'u_admin', ids: [failedImportantDelivery.id],
  }, { cookie: adminSessionCookie });
  assert.equal(retriedImportantDelivery.response.status, 200);
  assert.equal(retriedImportantDelivery.data.retried, 1);
  const recoveredDeliveries = await request('/api/notification-deliveries', undefined, { cookie: adminSessionCookie });
  assert.ok(recoveredDeliveries.data.deliveries.some((delivery) => delivery.id === failedImportantDelivery.id && delivery.status === 'sent'));
  assert.ok(!String(importantTopicNotification.body.text || '').includes('Придут:'));

  rateLimitNextTelegramSend = true;
  const rateLimitedTaskReminder = await request('/api/task/notify', {
    requesterId: 'u_admin', taskId: openTaskResult.data.task.id,
  }, { cookie: adminSessionCookie });
  assert.equal(rateLimitedTaskReminder.response.status, 200);
  const retryDeliveries = await request('/api/notification-deliveries?status=retry', undefined, { cookie: adminSessionCookie });
  assert.ok(retryDeliveries.data.deliveries.some((delivery) => delivery.lastErrorCode === '429'));

  telegramCalls.length = 0;
  const setupMeeting = await request('/api/meeting', {
    kind: 'setup', eventId: createdEventId, title: 'Монтаж тестовой площадки',
    type: 'custom', date: '03.01.30', time: '19:00', duration: 4,
    hostId: 'u_admin', participants: [], topic: 'Это поле должно быть очищено', description: 'И это тоже',
  });
  assert.equal(setupMeeting.response.status, 200);
  assert.equal(setupMeeting.data.meeting.kind, 'setup');
  assert.equal(setupMeeting.data.meeting.eventId, createdEventId);
  assert.equal(setupMeeting.data.meeting.type, 'general');
  assert.equal(setupMeeting.data.meeting.participants, 'all');
  assert.equal(setupMeeting.data.meeting.duration, 1);
  assert.equal(setupMeeting.data.meeting.topic, '');
  assert.equal(setupMeeting.data.meeting.description, '');
  const setupNotifications = telegramCalls.filter((call) => call.path.endsWith('/sendMessage'));
  assert.ok(setupNotifications.some((call) => String(call.body.text || '').includes('Новый монтаж запланирован!')));
  assert.ok(setupNotifications.some((call) => String(call.body.text || '').includes('Тестовое мероприятие — обновлено')));
  assert.ok(setupNotifications.some((call) => call.body.chat_id === '-100500' && call.body.message_thread_id === 321), 'setup notifications must be duplicated into IMPORTANT');
  assert.ok(setupNotifications.some((call) => String(call.body.chat_id) === '100'), 'setup host must receive a personal notification');
  assert.ok(setupNotifications.some((call) => String(call.body.chat_id) === '200'), 'whole team must receive setup notifications');

  telegramCalls.length = 0;
  const setupUpdate = await request('/api/meeting/update', {
    requesterId: 'u_admin', meetingId: setupMeeting.data.meeting.id, title: 'Монтаж главной сцены', time: '20:00',
  });
  assert.equal(setupUpdate.response.status, 200);
  assert.equal(setupUpdate.data.meeting.kind, 'setup');
  assert.equal(setupUpdate.data.meeting.participants, 'all');
  assert.ok(telegramCalls.some((call) => String(call.body.text || '').includes('Монтаж изменён')));

  telegramCalls.length = 0;
  const beforeVibeSession = sessionCookie;
  sessionCookie = adminSessionCookie;
  const vibeMeeting = await request('/api/meeting', {
    kind: 'vibe', title: 'Вечер настолок', type: 'custom', date: '05.01.30', time: '03:15', duration: 2,
    hostId: 'u_admin', participants: ['u_alice'], topic: 'Неформально общаемся', description: 'Встречаемся с командой',
  });
  assert.equal(vibeMeeting.response.status, 200);
  assert.equal(vibeMeeting.data.meeting.kind, 'vibe');
  assert.equal(vibeMeeting.data.meeting.duration, 2);
  assert.equal(vibeMeeting.data.meeting.date, '05.01.30', 'vibes must be allowed on weekends');
  assert.equal(vibeMeeting.data.meeting.time, '03:15', 'vibes must be allowed outside availability hours');
  assert.deepEqual(vibeMeeting.data.meeting.participants, ['u_alice']);
  assert.equal(vibeMeeting.data.meeting.topic, 'Неформально общаемся');
  const vibeNotifications = telegramCalls.filter((call) => call.path.endsWith('/sendMessage'));
  assert.ok(vibeNotifications.some((call) => String(call.body.text).includes('Новый вайбик запланирован!')));
  assert.ok(vibeNotifications.some((call) => call.body.chat_id === '-100500' && call.body.message_thread_id === 321));
  assert.ok(vibeNotifications.some((call) => String(call.body.chat_id) === '100'));
  assert.ok(vibeNotifications.some((call) => String(call.body.chat_id) === '200'));
  assert.ok(!vibeNotifications.some((call) => String(call.body.chat_id) === '300'), 'custom vibe should notify only invitees and its host');
  sessionCookie = beforeVibeSession;
  const vibeRsvp = await request('/api/meeting/rsvp', { requesterId: 'u_alice', meetingId: vibeMeeting.data.meeting.id, attending: true });
  assert.equal(vibeRsvp.response.status, 200);
  sessionCookie = adminSessionCookie;
  telegramCalls.length = 0;
  const vibeUpdate = await request('/api/meeting/update', {
    requesterId: 'u_admin', meetingId: vibeMeeting.data.meeting.id,
    title: 'Вечер настолок и чая', date: '06.01.30', time: '23:45',
  });
  assert.equal(vibeUpdate.response.status, 200);
  assert.equal(vibeUpdate.data.meeting.kind, 'vibe', 'editing without a kind must preserve vibe');
  assert.equal(vibeUpdate.data.meeting.date, '06.01.30', 'vibes must remain editable to a weekend');
  assert.equal(vibeUpdate.data.meeting.time, '23:45', 'vibes must remain editable to any time of day');
  assert.ok(telegramCalls.some((call) => String(call.body.text || '').includes('Вайбик изменён')));
  assert.equal((await request('/api/state')).data.meetings.find((item) => item.id === vibeMeeting.data.meeting.id).kind, 'vibe');
  telegramCalls.length = 0;
  const vibeDelete = await request('/api/meeting/delete', { requesterId: 'u_admin', meetingId: vibeMeeting.data.meeting.id });
  assert.equal(vibeDelete.response.status, 200);
  assert.ok(telegramCalls.some((call) => String(call.body.text || '').includes('Вайбик отменён.')));
  sessionCookie = beforeVibeSession;

  const oneDayAvailability = await saveAvailabilityWeek('u_alice', 0, { 2: [18] });
  assert.equal(oneDayAvailability.response.status, 200);

  const sessionBeforeSuggestionSetup = sessionCookie;
  sessionCookie = adminSessionCookie;
  const unmarkedSuggestionUser = await request('/api/user/add', {
    requesterId: 'u_admin',
    realName: 'Неотметившийся Участник',
    username: '@not_marked_suggestion',
    role: 'organizer',
  });
  assert.equal(unmarkedSuggestionUser.response.status, 200);
  const unavailableAdmin = await saveAvailabilityWeek('u_admin', 0, {}, [2]);
  assert.equal(unavailableAdmin.response.status, 200);
  const bobAuth = await request('/api/user/get-or-create', {
    initData: telegramInitData({ id: 300, username: 'bob', first_name: 'Борис' }),
  });
  assert.equal(bobAuth.response.status, 200);
  const bobSessionCookie = bobAuth.response.headers.get('set-cookie').split(';')[0];
  sessionCookie = bobSessionCookie;
  const outBob = await saveAvailabilityWeek('u_bob', 0, {}, [], true);
  assert.equal(outBob.response.status, 200);
  sessionCookie = sessionBeforeSuggestionSetup;
  const filteredSuggestions = await request('/api/meeting/suggest', {
    days: [2],
    duration: 1,
  });
  assert.equal(filteredSuggestions.response.status, 200);
  assert.equal(filteredSuggestions.data.topSuggestions.length, 1);
  assert.equal(filteredSuggestions.data.topSuggestions[0].dayIndex, 2);
  assert.equal(filteredSuggestions.data.topSuggestions[0].hour, 18);
  assert.deepEqual(filteredSuggestions.data.topSuggestions[0].canUsers.map((user) => user.id), ['u_alice']);
  const cannotReasons = Object.fromEntries(filteredSuggestions.data.topSuggestions[0].cannotUsers.map((user) => [user.id, user.reason]));
  assert.equal(cannotReasons.u_admin, 'inconvenient');
  assert.equal(cannotReasons.u_bob, 'out');
  assert.equal(cannotReasons[unmarkedSuggestionUser.data.user.id], 'not_marked');
  assert.equal(filteredSuggestions.data.topSuggestions[0].total, 4);
  const invalidSuggestionDays = await request('/api/meeting/suggest', { days: [], duration: 1 });
  assert.equal(invalidSuggestionDays.response.status, 400);
  sessionCookie = bobSessionCookie;
  const restoreBobAvailability = await saveAvailabilityWeek('u_bob', 0);
  assert.equal(restoreBobAvailability.response.status, 200);
  sessionCookie = adminSessionCookie;
  const removeSuggestionUser = await request('/api/user/delete', {
    requesterId: 'u_admin', userId: unmarkedSuggestionUser.data.user.id,
  });
  assert.equal(removeSuggestionUser.response.status, 200);
  sessionCookie = sessionBeforeSuggestionSetup;

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 201,
    message: {
      message_id: 201,
      message_thread_id: 77,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/slots',
    },
  });
  const missingSlotsMessage = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.ok(missingSlotsMessage);
  assert.equal(missingSlotsMessage.body.message_thread_id, 77);
  assert.ok(!telegramCalls.some((call) => call.path.endsWith('/deleteMessage') && call.body.message_id === 201));
  assert.ok(String(missingSlotsMessage.body.text || '').includes('@alice'));
  assert.ok(String(missingSlotsMessage.body.text || '').includes('@admin'));

  const completedAvailability = await saveAvailabilityWeek('u_alice', 0, { 2: [18] }, [0, 1, 2, 3, 4]);
  assert.equal(completedAvailability.response.status, 200);
  assert.deepEqual(completedAvailability.data.availability.hardUnavailableDays, [0, 1, 3, 4]);

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 202,
    message: {
      message_id: 202,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/slots',
    },
  });
  const completedSlotsMessage = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.ok(completedSlotsMessage);
  assert.ok(!String(completedSlotsMessage.body.text || '').includes('@alice'));
  assert.ok(String(completedSlotsMessage.body.text || '').includes('@admin'));

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
    update_id: 211,
    message: {
      message_id: 211,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 500, username: 'chat_only', first_name: 'Только в чате' },
      text: 'Обычное сообщение участника',
    },
  });
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 0);

  await request('/api/telegram-webhook', {
    update_id: 212,
    chat_member: {
      chat: { id: -100500, type: 'supergroup' },
      new_chat_member: {
        status: 'member',
        user: { id: 600, first_name: 'Без username', is_bot: false },
      },
    },
  });

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 213,
    message: {
      message_id: 213,
      message_thread_id: 88,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/all@megaorgi_bot',
    },
  });
  const allParticipantsMessage = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.equal(allParticipantsMessage?.body.message_thread_id, 88);
  assert.ok(String(allParticipantsMessage?.body.text || '').includes('@admin'));
  assert.ok(String(allParticipantsMessage?.body.text || '').includes('@chat_only'));
  assert.ok(String(allParticipantsMessage?.body.text || '').includes('tg://user?id=600'));
  assert.ok(!String(allParticipantsMessage?.body.text || '').includes('Уведомление'));
  assert.ok(!String(allParticipantsMessage?.body.text || '').includes('Автор:'));
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 1);
  assert.ok(!telegramCalls.some((call) => call.path.endsWith('/deleteMessage')));

  telegramCalls.length = 0;
  groupBotIsAdmin = false;
  await request('/api/telegram-webhook', {
    update_id: 2141,
    message: {
      message_id: 2141,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/all',
    },
  });
  assert.ok(!telegramCalls.some((call) => call.path.includes('/getChatMember')));
  assert.equal(telegramCalls.filter((call) => call.path.endsWith('/sendMessage')).length, 1);
  assert.ok(String(telegramCalls.find((call) => call.path.endsWith('/sendMessage'))?.body.text || '').includes('@admin'));
  groupBotIsAdmin = true;

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 2142,
    message: {
      message_id: 2142,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/all_design',
    },
  });
  const blockPrompt = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && String(call.body.text || '').includes('следующим сообщением'));
  assert.ok(blockPrompt);
  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 2143,
    message: {
      message_id: 2143,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/cancel',
    },
  });
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/deleteMessage') && call.body.message_id === blockPrompt.resultMessageId));
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/sendMessage') && String(call.body.text || '').includes('отменено')));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 215,
    message: {
      message_id: 215,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/all_design Проверка дизайна',
    },
  });
  const designMessage = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.ok(String(designMessage?.body.text || '').includes('Проверка дизайна'));
  assert.ok(String(designMessage?.body.text || '').includes('@alice'));
  assert.ok(!String(designMessage?.body.text || '').includes('@bob'));

  await request('/api/telegram-webhook', {
    update_id: 216,
    chat_member: {
      chat: { id: -100500, type: 'supergroup' },
      new_chat_member: {
        status: 'left',
        user: { id: 600, first_name: 'Без username', is_bot: false },
      },
    },
  });
  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 217,
    message: {
      message_id: 217,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 100, username: 'admin', first_name: 'Админ' },
      text: '/all Проверка выхода',
    },
  });
  const afterLeaveMessage = telegramCalls.find((call) => call.path.endsWith('/sendMessage'));
  assert.ok(!String(afterLeaveMessage?.body.text || '').includes('tg://user?id=600'));

  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 22,
    message: {
      message_id: 22,
      message_thread_id: 99,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 200, username: 'alice', first_name: 'Алиса' },
      text: '/checkin',
    },
  });
  const checkinPrompt = telegramCalls.find((call) => call.path.endsWith('/sendMessage') && String(call.body.text || '').includes('название переклички'));
  assert.ok(checkinPrompt);
  assert.ok(!telegramCalls.some((call) => call.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'group_checkin'));
  telegramCalls.length = 0;
  await request('/api/telegram-webhook', {
    update_id: 2201,
    message: {
      message_id: 2201,
      message_thread_id: 99,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 200, username: 'alice', first_name: 'Алиса' },
      text: 'Репетиция',
    },
  });
  const checkinMessage = telegramCalls.find((call) => (
    call.path.endsWith('/sendMessage')
    && call.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'group_checkin'
  ));
  assert.ok(checkinMessage);
  assert.equal(checkinMessage.body.message_thread_id, 99);
  assert.ok(String(checkinMessage.body.text || '').includes('Репетиция'));
  assert.ok(telegramCalls.some((call) => call.path.endsWith('/deleteMessage') && call.body.message_id === checkinPrompt.resultMessageId));
  assert.ok(!telegramCalls.some((call) => call.path.endsWith('/deleteMessage') && call.body.message_id === 2201));
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

  const activeSessionCookie = sessionCookie;
  sessionCookie = aliceSessionBeforeAdmin;
  const adminOnlySpoofCases = [
    ['/api/integrations/google-sheets/mapping?requesterId=u_admin', undefined],
    ['/api/integrations/google-sheets/template', { requesterId: 'u_admin' }],
    ['/api/user/add', { requesterId: 'u_admin', realName: 'Подмена администратора', username: '@spoofed_admin' }],
    ['/api/user/delete', { requesterId: 'u_admin', userId: 'u_bob' }],
    ['/api/user/update', { requesterId: 'u_admin', userId: 'u_bob', realName: 'Подмена администратора' }],
    ['/api/competency/add', { requesterId: 'u_admin', name: 'Подмена' }],
    ['/api/competency/delete', { requesterId: 'u_admin', name: 'Дизайн' }],
    ['/api/faculty/competency/add', { requesterId: 'u_admin', name: 'Подмена' }],
    ['/api/faculty/competency/delete', { requesterId: 'u_admin', name: 'Дизайн' }],
    ['/api/faculty/user/add', { requesterId: 'u_admin', realName: 'Подмена', username: '@faculty_spoof' }],
    ['/api/faculty/user/update', { requesterId: 'u_admin', userId: 'u_faculty', realName: 'Подмена' }],
    ['/api/faculty/user/delete', { requesterId: 'u_admin', userId: 'u_faculty' }],
    ['/api/availability/weeks', { requesterId: 'u_admin', weeks: 3 }],
    ['/api/availability/week-name', {
      requesterId: 'u_admin', weekIndex: 0, weekStart: currentWeekStart(), name: 'Чужое название',
    }],
    ['/api/event/create', { requesterId: 'u_admin', name: 'Подмена' }],
    ['/api/event/update', { requesterId: 'u_admin', eventId: 'event_missing', name: 'Подмена' }],
    ['/api/task/log/clear', { requesterId: 'u_admin' }],
  ];
  for (const [pathname, body] of adminOnlySpoofCases) {
    const forbidden = await request(pathname, body);
    assert.equal(forbidden.response.status, 403, `${pathname} must reject a spoofed admin actor`);
  }

  sessionCookie = adminSessionCookie;
  const weekMetadata = await request('/api/availability/week-name', {
    requesterId: 'u_admin',
    weekIndex: 0,
    weekStart: currentWeekStart(),
    name: 'Финальная подготовка',
    description: 'Закрываем последние задачи перед мероприятием.',
  });
  assert.equal(weekMetadata.response.status, 200);
  assert.equal(weekMetadata.data.name, 'Финальная подготовка');
  assert.equal(weekMetadata.data.description, 'Закрываем последние задачи перед мероприятием.');

  const availabilitySettings = await request('/api/availability/weeks', {
    requesterId: 'u_admin',
    weeks: 3,
    activeDays: [0, 2, 4],
    startHour: 18,
    endHour: 21,
    notifyTeam: false,
  });
  assert.equal(availabilitySettings.response.status, 200);
  assert.deepEqual(availabilitySettings.data.activeDays, [0, 2, 4]);
  assert.equal(availabilitySettings.data.startHour, 18);
  assert.equal(availabilitySettings.data.endHour, 21);
  sessionCookie = activeSessionCookie;
  const sharedWeekMetadata = await request('/api/state');
  assert.equal(sharedWeekMetadata.response.status, 200);
  assert.equal(sharedWeekMetadata.data.settings.availabilityWeekNames[0], 'Финальная подготовка');
  assert.equal(sharedWeekMetadata.data.settings.availabilityWeekDescriptions[0], 'Закрываем последние задачи перед мероприятием.');
  assert.equal(sharedWeekMetadata.data.settings.availabilityWeekMetadata[currentWeekStart()].name, 'Финальная подготовка');
  assert.equal(sharedWeekMetadata.data.settings.availabilityWeekMetadata[currentWeekStart()].description, 'Закрываем последние задачи перед мероприятием.');

  const database = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.equal(database.users.length, fixture.users.length + 2, 'deactivated profiles must remain for historical references');
  assert.deepEqual(
    database.users.filter((user) => user.active === false).map((user) => user.username).sort(),
    ['@not_marked_suggestion', '@unlinked_user'],
  );
  assert.equal(database.users.find((user) => user.id === 'u_alice').telegramId, '200');
  assert.equal(database.users.some((user) => user.telegramId === '999'), false);
  assert.equal(database.settings.teamChatId, '-100500');
  assert.equal(database.settings.availabilityWeekCount, 3);
  assert.deepEqual(database.settings.availabilityActiveDays, [0, 2, 4]);
  assert.equal(database.settings.availabilityStartHour, 18);
  assert.equal(database.settings.availabilityEndHour, 21);
  assert.equal(database.settings.availabilityWeekNames[0], 'Финальная подготовка');
  assert.equal(database.settings.availabilityWeekDescriptions[0], 'Закрываем последние задачи перед мероприятием.');
  assert.equal(database.settings.availabilityWeekMetadata[currentWeekStart()].name, 'Финальная подготовка');
  assert.ok(database.messages.u_alice.length > 0);
  assert.ok(!database.messages.u_admin.some((message) => message.id.startsWith('task_comp_admin_')));
  const persistedCommentTask = database.tasks.find((task) => task.id === openTaskResult.data.task.id);
  assert.deepEqual(persistedCommentTask.assigneeNotes.u_alice.history.map((comment) => comment.text), ['Собираю материалы', 'Материалы готовы, начинаю сборку']);
  const persistedCancelledTask = database.tasks.find((task) => task.id === facultyTask.data.task.id);
  assert.equal(persistedCancelledTask.status, 'cancelled');
  const persistedPanels = JSON.parse(await readFile(`${testDatabasePath}.chat-panels.json`, 'utf8'));
  assert.equal(persistedPanels.version, 2);
  assert.ok(Number.isInteger(persistedPanels.panels['200'].current));
  assert.ok(Array.isArray(persistedPanels.panels['200'].known));
  assert.equal(persistedPanels.slotDrafts['200'], undefined, 'changing availability rules must invalidate stale chat drafts');
  assert.match(serverErrors, /Temporary WEBAPP_URL dead-tunnel\.lhr\.life is not allowed in production/);

  sessionCookie = adminSessionCookie;
  const oldWeekStart = currentWeekStart();
  const weekAt = (index) => new Date(Date.parse(`${oldWeekStart}T12:00:00Z`) + index * 7 * 86400000).toISOString().slice(0, 10);
  for (let index = 0; index < 3; index += 1) {
    const renamed = await request('/api/availability/week-name', {
      requesterId: 'u_admin', weekIndex: index, weekStart: weekAt(index), name: `Событие ${index}`, description: `Описание ${index}`,
    });
    assert.equal(renamed.response.status, 200);
  }
  await saveAvailabilityWeek('u_admin', 0, { 0: [18] }, [2]);
  await saveAvailabilityWeek('u_admin', 1, { 0: [19] }, [2]);
  const rolloverSave = await saveAvailabilityWeek('u_admin', 2, { 0: [20] }, [2]);
  assert.equal(rolloverSave.response.status, 200);
  await writeFile(clockPath, String(Date.parse(`${weekAt(1)}T00:00:00+03:00`)));
  const rolled = (await request('/api/state')).data;
  assert.equal(rolled.settings.availabilityWeekCount, 3);
  assert.deepEqual(rolled.settings.availabilityWeekNames, ['Событие 1', 'Событие 2', 'Неделя 3']);
  assert.deepEqual(rolled.settings.availabilityWeekDescriptions, ['Описание 1', 'Описание 2', '']);
  assert.deepEqual(rolled.availabilities.u_admin.slots, { 0: [19], 7: [20] });
  assert.deepEqual(rolled.availabilities.u_admin.hardUnavailableDays, [2, 9]);
  assert.equal(rolled.availabilities.u_admin.weekStart, weekAt(1));
  for (const staleWeekStart of [oldWeekStart, '', 'invalid', weekAt(2)]) {
    const rejected = await request('/api/availability', { userId: 'u_admin', weekStart: staleWeekStart, days: { 0: [21] }, hardUnavailableDays: [], out: false, expectedVersion: 0 });
    assert.equal(rejected.response.status, 409);
  }
  const rejectedName = await request('/api/availability/week-name', {
    requesterId: 'u_admin', weekIndex: 0, weekStart: oldWeekStart, name: 'Устаревшее название',
  });
  assert.equal(rejectedName.response.status, 409);
  assert.deepEqual((await request('/api/state')).data.availabilities.u_admin, rolled.availabilities.u_admin);
  const persistedRollover = JSON.parse(await readFile(testDatabasePath, 'utf8'));
  assert.deepEqual(persistedRollover.availabilities.u_admin, rolled.availabilities.u_admin);

  const legacyClear = await request('/api/task/log/clear', { requesterId: 'u_admin' });
  assert.equal(legacyClear.response.status, 410, 'legacy full-log deletion must stay disabled');
  const archivePreview = await request('/api/task/archive/preview', { requesterId: 'u_admin' });
  assert.equal(archivePreview.response.status, 200);
  const stateBeforeArchiveClear = (await request('/api/state')).data;
  const activeTaskIds = stateBeforeArchiveClear.tasks.filter((task) => !['completed', 'cancelled'].includes(task.status)).map((task) => task.id).sort();
  assert.deepEqual(archivePreview.data.taskIds, stateBeforeArchiveClear.tasks.filter((task) => ['completed', 'cancelled'].includes(task.status)).map((task) => task.id).sort());
  const staleArchiveClear = await request('/api/task/archive/clear', { requesterId: 'u_admin', taskIds: ['stale-id'] });
  assert.equal(staleArchiveClear.response.status, 409);
  const archiveClear = await request('/api/task/archive/clear', { requesterId: 'u_admin', taskIds: archivePreview.data.taskIds });
  assert.equal(archiveClear.response.status, 200);
  assert.ok(archiveClear.data.backupId);
  assert.deepEqual((await request('/api/state')).data.tasks.map((task) => task.id).sort(), activeTaskIds, 'archive clear must preserve all active tasks');

  const seasonPreview = await request('/api/task/season-reset/preview', { requesterId: 'u_admin' });
  assert.equal(seasonPreview.response.status, 200);
  const rejectedSeasonReset = await request('/api/task/season-reset', { requesterId: 'u_admin', taskIds: seasonPreview.data.taskIds, confirmation: 'да' });
  assert.equal(rejectedSeasonReset.response.status, 400);
  const seasonReset = await request('/api/task/season-reset', { requesterId: 'u_admin', taskIds: seasonPreview.data.taskIds, confirmation: 'СБРОСИТЬ СЕЗОН' });
  assert.equal(seasonReset.response.status, 200);
  assert.ok(seasonReset.data.backupId);
  assert.equal((await request('/api/state')).data.tasks.length, 0);

  console.log('Core flow verification passed: chat buttons, resilient slot editing, registration, access binding, task notifications, meeting RSVP, archive cleanup, season reset, and task completion.');
} finally {
  if (appProcess && !appProcess.killed) appProcess.kill();
  await new Promise((resolve) => fakeTelegram.close(resolve));
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
