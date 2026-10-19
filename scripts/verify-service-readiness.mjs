import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-readiness-'));
const invalidDatabasePath = path.join(tempRoot, 'database-is-a-directory');
await mkdir(invalidDatabasePath);

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const selectedPort = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selectedPort));
  });
});

const app = spawn(process.execPath, [path.join(repoRoot, 'dist', 'server.cjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ALLOW_LOCAL_PREVIEW: 'false',
    PORT: String(port),
    DB_FILE: invalidDatabasePath,
    SESSION_FILE: path.join(tempRoot, 'sessions.json'),
    SESSION_SECRET: 'readiness-independent-secret-32-characters',
    TELEGRAM_UPDATE_MODE: 'disabled',
    TELEGRAM_BOT_TOKEN: '',
    BOT_TOKEN: '',
    BACKGROUND_SCHEDULERS_ENABLED: 'false',
    GOOGLE_SHEETS_DATABASE_ENABLED: 'false',
    GOOGLE_SHEETS_SPREADSHEET_ID: '',
    GOOGLE_SERVICE_ACCOUNT_FILE: '',
    GOOGLE_CALENDAR_ID: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let startupOutput = '';
app.stdout.on('data', chunk => { startupOutput += chunk; });
app.stderr.on('data', chunk => { startupOutput += chunk; });

try {
  let liveResponse;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(app.exitCode, null, `Server exited during startup: ${startupOutput}`);
    try {
      liveResponse = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
        headers: { 'X-Request-ID': 'readiness-check-123' },
      });
      if (liveResponse.ok) break;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(liveResponse?.status, 200, 'liveness must describe the running process even when persistence is unavailable');
  assert.equal(liveResponse.headers.get('x-request-id'), 'readiness-check-123');

  const readinessResponse = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
  const readiness = await readinessResponse.json();
  assert.equal(readinessResponse.status, 503);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.status, 'unavailable');

  const legacyHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(legacyHealth.status, 503);

  const mutation = await fetch(`http://127.0.0.1:${port}/api/user/get-or-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'readiness-operation-123' },
    body: JSON.stringify({ initData: '' }),
  });
  assert.equal(mutation.headers.get('x-operation-id'), 'readiness-operation-123');
  assert.ok(mutation.headers.get('x-request-id'));

  console.log('Service readiness verification passed: liveness stays up, failed durable writes return 503 readiness, and correlation headers are present.');
} finally {
  if (app.exitCode === null && app.signalCode === null) {
    const exited = once(app, 'exit');
    app.kill();
    await exited;
  }
  if (path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
