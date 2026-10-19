import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeReleaseFile, assertNodeServerSources } from './node-release-boundary.mjs';

const archive = path.resolve(process.argv[2] || '');
assert.ok(archive.endsWith('.tar.gz'), 'Pass the generated release archive');
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
assert.equal(readFileSync(`${archive}.sha256`, 'utf8').split(' ')[0], digest);
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
assert.equal(new Set(entries).size, entries.length, 'Duplicate archive entries');
for (const entry of execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/)) {
  assert.ok(entry.startsWith('-') || entry.startsWith('d'), 'Only ordinary files/directories are allowed');
}
for (const entry of entries) {
  assert.ok(entry === './' || /^\.\/(?:dist\/(?:assets\/|brand\/|fonts\/)?)$/.test(entry)
    || (entry.startsWith('./') && nodeReleaseFile(entry.slice(2))), `Unexpected archive entry: ${entry}`);
  assert.ok(!entry.split('/').includes('..'), 'Unsafe archive path');
}
const extracted = mkdtempSync(path.join(os.tmpdir(), 'megabot-release-check-'));
execFileSync('tar', ['-xzf', archive, '-C', extracted]);
const checked = new Set();
for (const line of readFileSync(path.join(extracted, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const [expected, name] = line.split('  ');
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.ok(nodeReleaseFile(name), `Unexpected checksum path: ${name}`);
  assert.ok(!checked.has(name), `Duplicate checksum: ${name}`);
  checked.add(name);
  assert.equal(createHash('sha256').update(readFileSync(path.join(extracted, name))).digest('hex'), expected, name);
}
const payloadFiles = entries.filter(entry => !entry.endsWith('/') && !['./release.json', './SHA256SUMS'].includes(entry)).map(entry => entry.slice(2));
assert.deepEqual([...checked].sort(), payloadFiles.sort(), 'Every payload file must have exactly one checksum');
assert.ok(entries.includes('./dist/server.cjs'));
assert.ok(entries.includes('./dist/index.html'));
for (const name of ['package.json', 'package-lock.json', 'ecosystem.config.cjs', 'dist/server.cjs.map']) assert.ok(entries.includes(`./${name}`), `Missing release file: ${name}`);
assertNodeServerSources(JSON.parse(readFileSync(path.join(extracted, 'dist/server.cjs.map'), 'utf8')));
const manifest = JSON.parse(readFileSync(path.join(extracted, 'release.json'), 'utf8'));
assert.equal(manifest.scope, 'Node/UI only');
console.log(`Release archive verified: ${manifest.revision}; ${entries.length} entries; checksums and Node/UI-only allowlist passed.`);
