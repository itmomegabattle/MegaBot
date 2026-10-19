import assert from 'node:assert/strict';
import fs from 'node:fs';
import proxyaddr from 'proxy-addr';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const name of ['vite', '@vitejs/plugin-react', '@tailwindcss/vite', 'postcss', 'typescript', 'esbuild']) assert.ok(!packageJson.dependencies[name], `${name} must not be a runtime dependency`);
assert.equal(packageJson.packageManager, 'npm@10.9.8');
assert.equal(fs.readFileSync('.nvmrc', 'utf8').trim(), '22.23.1');
const config = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
assert.ok(config.include.length);
for (const name of ['dist', 'node_modules', 'backend', 'output', '.tmp']) assert.ok(config.exclude.includes(name));
// Regression for GHSA-jqcg-44mw-7w3h: short IPv4-mapped subnet must not trust arbitrary IPv4.
assert.equal(proxyaddr.compile(['::ffff:10.0.0.0/8'])('203.0.113.4'), false);
const loopback = proxyaddr.compile('loopback');
assert.equal(loopback('127.0.0.1'), true);
assert.equal(loopback('203.0.113.4'), false);
assert.equal(proxyaddr({ connection: { remoteAddress: '203.0.113.4' }, headers: { 'x-forwarded-for': '127.0.0.1' } }, loopback), '203.0.113.4');
console.log('Dependency controls passed: build/runtime split, toolchain pins, TypeScript scope and proxy trust regression.');
