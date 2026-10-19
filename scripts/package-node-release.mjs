import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeReleaseFile, assertNodeServerSources } from './node-release-boundary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assertNodeServerSources(JSON.parse(readFileSync(path.join(root, 'dist/server.cjs.map'), 'utf8')));
const staging = path.join(root, '.tmp', 'releases', randomUUID());
mkdirSync(staging, { recursive: true });
// Explicit allowlist: no .env, credentials, runtime data, Java or node_modules.
for (const name of ['dist', 'package.json', 'package-lock.json', 'ecosystem.config.cjs']) {
  cpSync(path.join(root, name), path.join(staging, name), { recursive: true });
}
function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${name}`);
    if (entry.isDirectory()) return files(path.join(directory, entry.name), `${name}/`);
    if (!entry.isFile() || !nodeReleaseFile(name)) throw new Error(`File outside the Node release: ${name}`);
    return [name];
  }).sort();
}
const checksums = files(staging).map(name => `${createHash('sha256').update(readFileSync(path.join(staging, name))).digest('hex')}  ${name}\n`).join('');
const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const revision = `${baseCommit.slice(0, 12)}-rc-${createHash('sha256').update(checksums).digest('hex').slice(0, 12)}`;
writeFileSync(path.join(staging, 'SHA256SUMS'), checksums);
writeFileSync(path.join(staging, 'release.json'), JSON.stringify({ revision, baseCommit, builtAt: new Date().toISOString(), node: process.version, scope: 'Node/UI only', sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()) }, null, 2));
const destination = path.join(root, 'output', 'releases');
mkdirSync(destination, { recursive: true });
const archive = path.join(destination, `megabot-${revision}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', staging, '.']);
const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ archive, sha256: hash, revision, staging }, null, 2));
