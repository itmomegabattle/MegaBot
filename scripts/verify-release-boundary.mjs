import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { nodeReleaseFile, assertNodeServerSources } from './node-release-boundary.mjs';

for (const name of ['dist/server.cjs', 'dist/server.cjs.map', 'dist/index.html', 'dist/assets/index-abc.js', 'dist/fonts/Raleway-VariableFont_wght.woff2']) assert.ok(nodeReleaseFile(name));
for (const name of ['backend/app.jar', 'dist/app.jar', 'dist/backend/schema.sql', 'dist/.env', 'dist/database.json', 'dist/server.ts', 'dist/assets/../../.env', '/dist/index.html', 'dist/assets/link.js/secret', 'scripts/legacy-snapshot-dry-run.ts', 'dist/server.cjs\n']) assert.equal(nodeReleaseFile(name), false, name);
assertNodeServerSources({ sources: ['../server.ts', '../src/projectTime.ts'] });
for (const source of ['../backend/app.java', '../scripts/legacy-snapshot-dry-run.ts', '../src/../backend/app.ts', '../.env']) assert.throws(() => assertNodeServerSources({ sources: [source] }));
function inspect(directory, prefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    assert.equal(entry.isSymbolicLink(), false, name);
    if (entry.isDirectory()) inspect(path.join(directory, entry.name), `${name}/`);
    else assert.ok(entry.isFile() && nodeReleaseFile(name), name);
  }
}
inspect('dist', 'dist/');
assertNodeServerSources(JSON.parse(readFileSync('dist/server.cjs.map', 'utf8')));
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
assert.match(ci, /java-backend:\s+if: github\.event_name == 'workflow_dispatch' && inputs\.verify_java/);
const config = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
assert.ok(config.exclude.includes('backend'));
console.log('Node release boundary passed: built files and server sources, deferred Java CI, negative artifact/source fixtures.');
