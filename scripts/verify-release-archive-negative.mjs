import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const candidate = JSON.parse(readFileSync('output/node-release-isolation-package.json', 'utf8'));
const directory = mkdtempSync(path.resolve('.tmp/releases/archive-negative-'));
const verifier = path.resolve('scripts/verify-node-release.mjs');
execFileSync(process.execPath, [verifier, candidate.archive], { stdio: 'pipe' });
const digest = value => createHash('sha256').update(value).digest('hex');
const cases = {
  'missing-checksum': dir => {
    const sums = path.join(dir, 'SHA256SUMS');
    writeFileSync(sums, readFileSync(sums, 'utf8').split('\n').filter(line => !line.endsWith('  package-lock.json')).join('\n'));
  },
  'duplicate-checksum': dir => {
    const sums = path.join(dir, 'SHA256SUMS');
    const text = readFileSync(sums, 'utf8');writeFileSync(sums, text + text.split('\n')[0] + '\n');
  },
  'extra-allowed-file': dir => writeFileSync(path.join(dir, 'dist/assets/unlisted.js'), 'synthetic'),
  'forbidden-java-file': dir => writeFileSync(path.join(dir, 'dist/unfinished.jar'), 'synthetic'),
  'linked-file': dir => linkSync(path.join(dir, 'dist/server.cjs'), path.join(dir, 'dist/assets/linked.js')),
  'missing-package': dir => {
    // Exclude the required file from this archive without removing the source fixture.
    const sums = path.join(dir, 'SHA256SUMS');
    writeFileSync(sums, readFileSync(sums, 'utf8').split('\n').filter(line => !line.endsWith('  package.json')).join('\n'));
    return ['--exclude=./package.json'];
  },
};
for (const [name, mutate] of Object.entries(cases)) {
  const dir = path.join(directory, name);mkdirSync(dir);
  cpSync(candidate.staging, dir, { recursive: true });
  const extra = mutate(dir) || [];
  const archive = path.join(directory, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, ...extra, '-C', dir, '.']);
  writeFileSync(`${archive}.sha256`, `${digest(readFileSync(archive))}  ${path.basename(archive)}\n`);
  const result = spawnSync(process.execPath, [verifier, archive], { encoding: 'utf8' });
  assert.equal(result.error, undefined, name);assert.notEqual(result.status, 0, `${name} was accepted`);
  if (name === 'linked-file') assert.match(result.stderr, /Only ordinary files\/directories are allowed/);
  if (name === 'missing-package') assert.match(result.stderr, /Missing release file: package.json/);
}
console.log(`Release archive negative checks passed: ${Object.keys(cases).length} tampered archives rejected; candidate accepted.`);
