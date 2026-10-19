import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const names = ['README.md', 'backend/README.md', ...fs.readdirSync('docs').filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
for (const name of names) {
  const text = fs.readFileSync(name, 'utf8');
  for (const match of text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(name), decodeURIComponent(target))), `${name}: missing link ${target}`);
  }
}
const product = fs.readFileSync('docs/PRODUCT.md', 'utf8');
for (const stale of ['текущий Mini App отправляет все черновики сразу', 'пока отправляет доступность всех недель', 'чат обходит общий helper', 'durable персональной очереди ещё нет', 'шаги перехватывают его как ввод']) {
  assert.ok(!product.includes(stale), `Stale product claim: ${stale}`);
}
for (const contract of ['только выбранную календарную неделю', '18:00', '21:00', 'unknown не повторяется автоматически', 'DATA-04', 'Node-интерфейс остаётся с прежней немедленной отправкой']) assert.ok(product.includes(contract), `Missing product boundary: ${contract}`);
const readme = fs.readFileSync('README.md', 'utf8');
for (const plan of ['todo.md', 'todo_design.md', 'backend.md']) assert.ok(readme.includes(`](${plan})`));
assert.ok(readme.includes('переключение ещё не завершены'));
assert.ok(!readme.includes('TypeScript config захватывает dist'));
const architecture = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
assert.ok(!architecture.includes('применяет из таблицы только первую неделю'));
const schema = fs.readFileSync('src/googleSheetsDatabase.ts', 'utf8').match(/DATABASE_SCHEMA_VERSION = (\d+)/)[1];
assert.ok(architecture.includes(`версией схемы \`${schema}\``), 'Architecture must describe the current Sheets schema');
const backend = fs.readFileSync('backend/README.md', 'utf8');
for (const stale of ['монтаж всегда длится 60 минут', 'Другие task events ещё не отправляются.', 'UI ещё не подключён.', 'UI, legacy adapter и фактическая Telegram-доставка ещё не включены.']) {
  assert.ok(!backend.includes(stale), `Stale backend guide: ${stale}`);
}
assert.ok(backend.includes('production') && backend.includes('выключен'));
console.log(`Documentation checks passed: ${names.length} guides, local links and corrected Node/Java boundaries.`);
