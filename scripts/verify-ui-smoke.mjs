import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';

assert.ok(process.env.npm_execpath, 'Run through npm run verify:ui');
mkdirSync('output/playwright', { recursive: true });
const session = `ci-${process.pid}`;
function cli(args) {
  return execFileSync(process.execPath, [process.env.npm_execpath, 'exec', '--yes', '--package=@playwright/cli@0.1.22', '--', 'playwright-cli', `-s=${session}`, ...args], { encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
}
// Frontend preview only: never start server.ts or load production credentials.
const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '15173', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let previewLog = '';
preview.stdout.on('data', chunk => { previewLog += chunk; });
preview.stderr.on('data', chunk => { previewLog += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(preview.exitCode, null, previewLog);
    try { ready = (await fetch('http://127.0.0.1:15173', { signal: AbortSignal.timeout(500) })).ok; } catch { /* Not listening yet. */ }
    if (ready && previewLog.includes('http://127.0.0.1:15173')) break;
    ready = false;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, `Preview unavailable: ${previewLog}`);
  // Dedicated synthetic CI profile, also usable in a disposable root container.
  cli(['open', 'about:blank', '--config', 'scripts/playwright-ci.json']);
  for (const name of ['setup-duration', 'release', 'ui-hotfix']) {
    const output = cli(['run-code', '--filename', name === 'ui-hotfix' ? 'scripts/verify-ui-hotfix.js' : `scripts/verify-${name}-ui.js`]);
    writeFileSync(`output/playwright/${name}-ci.log`, output);
    // CLI can report a browser exception while returning exit 0. Require success proof.
    assert.ok(output.includes('"passed":true') && !output.includes('### Error'), `${name} browser smoke failed; see output/playwright/${name}-ci.log`);
  }
  console.log('UI smoke passed: duration, responsive layouts, navigation/disclosures/admin isolation; synthetic API only.');
} finally {
  try { cli(['close']); } catch { /* Preserve the original failure. */ }
  if (preview.exitCode === null && preview.signalCode === null) {
    const closed = once(preview, 'close');
    preview.kill();
    await closed;
  }
}
