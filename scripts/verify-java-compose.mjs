import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Exercise the real Compose db and packaged Java app, never an existing local/live database.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = `megabot-b01-${randomUUID().slice(0, 8)}`;
const output = join(root, 'output', project);
await mkdir(output, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SystemRoot|windir|ComSpec|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramFiles|ProgramFiles\(x86\))$/i.test(key)));
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const jar = join(root, 'backend', 'target', 'megabot-0.0.1-SNAPSHOT.jar');
assert(existsSync(jar), 'Build backend/mvnw verify before running this drill');

async function run(command, args) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, timeout: 120_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr}`)));
  });
  return stdout.trim();
}
async function until(label, check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (app && (app.exitCode !== null || app.signalCode !== null)) throw new Error(`Java exited during ${label}; see ${output}`);
    if (await check()) return;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
const emptyEnv = join(output, 'empty.env');
const override = join(output, 'override.yaml');
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
// Docker may assign a different ephemeral mapping after stop/up: reserve one port for this run.
const dbPort = await freePort();
let appPort = await freePort();
while (appPort === dbPort) appPort = await freePort();
await writeFile(emptyEnv, '');
await writeFile(override, `services:
  db:
    restart: "no"
    environment:
      POSTGRES_DB: b01_drill
      POSTGRES_USER: b01_admin
      POSTGRES_PASSWORD: b01_admin_disposable
      MEGABOT_DB_USERNAME: b01_app
      MEGABOT_DB_PASSWORD: b01_app_disposable
    ports: !override
      - "127.0.0.1:${dbPort}:5432"
`);
const composeArgs = ['compose', '--project-name', project, '--env-file', emptyEnv,
  '-f', join(root, 'compose.yaml'), '-f', override];
const compose = (...args) => run('docker', [...composeArgs, ...args]);
const sql = query => compose('exec', '-T', 'db', 'psql', '-U', 'b01_admin', '-d', 'b01_drill', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query);
const context = JSON.parse(await run('docker', ['context', 'inspect']));
assert.match(context[0].Endpoints.docker.Host, /^(npipe:\/\/|unix:\/\/)/, 'Only a local Docker daemon is allowed');
const version = await run(java, ['--version']);
assert.match(version, /^(openjdk|java) 21[. ]/, 'This drill requires the configured Java 21');
assert.equal(await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '', 'Project must be new');
assert.equal(await run('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '', 'Project volume must be new');
const base = `http://127.0.0.1:${appPort}`;
let app, appExit, dbUrl, volume;
const evidence = { project, java: version.split('\n')[0], checks: [], passed: false };
async function health(kind, cookie = false) {
  try {
    const response = await fetch(`${base}/actuator/health/${kind}`, {
      signal: AbortSignal.timeout(5000), headers: cookie ? { Cookie: 'megabot_session=b01-stale-cookie' } : {},
    });
    return { code: response.status, status: (await response.json()).status };
  } catch { return null; }
}
function startApp(label) {
  const log = createWriteStream(join(output, `${label}.log`));
  app = spawn(java, ['-Xmx384m', '-jar', jar, '--spring.profiles.active=local',
    '--server.address=127.0.0.1', `--server.port=${appPort}`,
    `--spring.datasource.url=${dbUrl}`, '--spring.datasource.username=b01_app',
    '--spring.datasource.password=b01_app_disposable', '--spring.datasource.hikari.connection-timeout=1500',
    '--spring.datasource.hikari.validation-timeout=1000', '--megabot.delivery.enabled=false',
    '--megabot.telegram.incoming-mode=disabled', '--megabot.auth.telegram.bot-token=',
    '--megabot.integrations.telegram.mode=fake', '--megabot.integrations.google.mode=fake'],
    { cwd: output, env, windowsHide: true });
  app.stdout.pipe(log); app.stderr.pipe(log);
  appExit = new Promise((resolve, reject) => {
    app.once('error', reject);
    app.once('close', code => { log.end(); resolve(code); });
  });
}
async function stopApp() {
  if (!app) return;
  if (app.exitCode === null && app.signalCode === null) app.kill();
  await appExit;
  app = null;
}
try {
  await compose('up', '-d', '--wait', 'db');
  const address = await compose('port', 'db', '5432');
  assert.equal(address, `127.0.0.1:${dbPort}`);
  dbUrl = `jdbc:postgresql://127.0.0.1:${address.split(':')[1]}/b01_drill`;
  volume = `${project}_megabot-postgres-data`;
  const inspection = JSON.parse(await run('docker', ['volume', 'inspect', volume]));
  assert.equal(inspection[0].Labels['com.docker.compose.project'], project);
  startApp('startup');
  await until('fresh Java readiness', async () => (await health('readiness'))?.status === 'UP');
  assert.equal((await health('liveness')).code, 200);
  const migrations = Number(await sql('select count(*) from flyway_schema_history where success'));
  assert(migrations >= 32, `Expected current migrations, found ${migrations}`);
  await sql("insert into users(id,username,real_name,role) values ('b01_probe','b01_probe','B01 synthetic participant','organizer')");
  evidence.checks.push({ name: 'compose-java-startup', migrations, readiness: 'UP', liveness: 'UP' });
  console.log('Compose + packaged Java started on isolated ports; migrations applied.');

  await compose('stop', 'db');
  await until('DB failure must cause readiness 503/DOWN', async () => {
    const result = await health('readiness');
    return result?.code === 503 && result.status === 'DOWN';
  }, 45_000);
  assert.equal((await health('liveness')).code, 200);
  assert.equal((await health('liveness', true)).code, 200);
  assert.equal((await health('readiness', true)).code, 503);
  assert.equal((await fetch(`${base}/api/v1/me`, { signal: AbortSignal.timeout(5000) })).status, 401);
  evidence.checks.push({ name: 'database-down', readinessCode: 503, livenessCode: 200 });
  console.log('Stopped owned database: readiness=503/DOWN, liveness=200.');
  await compose('up', '-d', '--wait', 'db');
  await until('recovery without Java restart', async () => (await health('readiness'))?.status === 'UP');
  evidence.checks.push({ name: 'database-recovery', readiness: 'UP' });
  console.log('Database recovered; the running Java process became ready again.');

  await stopApp();
  await compose('down'); // Preserve the owned named volume, recreate containers from scratch.
  await compose('up', '-d', '--wait', 'db');
  const newAddress = await compose('port', 'db', '5432');
  assert.equal(newAddress, `127.0.0.1:${dbPort}`);
  dbUrl = `jdbc:postgresql://127.0.0.1:${newAddress.split(':')[1]}/b01_drill`;
  startApp('restart');
  await until('recreated containers and Java readiness', async () => (await health('readiness'))?.status === 'UP');
  assert.equal(await sql("select real_name from users where id='b01_probe'"), 'B01 synthetic participant');
  assert.equal(Number(await sql('select count(*) from flyway_schema_history where success')), migrations);
  evidence.checks.push({ name: 'named-volume-and-java-restart', participantPreserved: true, migrationsUnchanged: true });
  console.log('Recreated Compose containers and restarted Java; named-volume data preserved.');
  evidence.passed = true;
} finally {
  await stopApp();
  await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  // This unpredictable project and its label were checked; no other project's volume is removed.
  assert.match(project, /^megabot-b01-[a-f0-9]{8}$/);
  await compose('down', '--volumes');
}
console.log(JSON.stringify({ ...evidence, output }, null, 2));
