import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readLatestDatabaseRecoveryRecord,
  writeDatabaseRecoveryRecord,
} from '../src/databaseRecoveryJournal.js';
import { exportStateToGoogleSheetsDatabase } from '../src/googleSheetsDatabase.js';
import type { SimulationState } from '../src/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'megabot-recovery-journal-'));
const state = (revision: number, title: string): SimulationState => ({
  users: [], faculties: [], facultyCompetencies: [], competencies: [], availabilities: {}, meetings: [], events: [], messages: {},
  tasks: [{ id: `t${revision}`, version: 1, title, description: '', deadline: '', assignedTo: null, competency: '', sow: '', tips: [], status: 'open', priority: 'normal' }],
  settings: { availabilityWeekCount: 2, databaseRevision: revision },
});

try {
  writeDatabaseRecoveryRecord(root, state(1, 'Первая'), 3, new Date('2026-09-22T12:00:00.000Z'));
  writeDatabaseRecoveryRecord(root, state(2, 'Вторая'), 3, new Date('2026-09-22T12:00:01.000Z'));
  const newestPath = writeDatabaseRecoveryRecord(root, state(3, 'Третья'), 3, new Date('2026-09-22T12:00:02.000Z'));
  assert.equal(readLatestDatabaseRecoveryRecord(root)?.state.tasks[0].title, 'Третья');

  fs.writeFileSync(newestPath, '{corrupt', 'utf8');
  assert.equal(readLatestDatabaseRecoveryRecord(root)?.state.tasks[0].title, 'Вторая', 'corrupt newest record must fall back');

  writeDatabaseRecoveryRecord(root, state(4, 'Четвёртая'), 3, new Date('2026-09-22T12:00:03.000Z'));
  writeDatabaseRecoveryRecord(root, state(5, 'Пятая'), 3, new Date('2026-09-22T12:00:04.000Z'));
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.json')).length, 3, 'retention must keep immutable recent records');
  assert.equal(readLatestDatabaseRecoveryRecord(root)?.revision, 5);

  const blockedPath = path.join(root, 'not-a-directory');
  fs.writeFileSync(blockedPath, 'blocked', 'utf8');
  assert.throws(() => writeDatabaseRecoveryRecord(blockedPath, state(6, 'Ошибка')));

  const sheetsConfig = { spreadsheetId: 'test', credentialsFile: 'unused.json', enabled: true };
  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  try {
    AbortSignal.timeout = (milliseconds) => {
      timeouts.push(milliseconds);
      return originalTimeout(milliseconds);
    };
    const signals: (AbortSignal | null | undefined)[] = [];
    await exportStateToGoogleSheetsDatabase(sheetsConfig, state(7, 'Sheets'), 'timeout_test', {
      initialize: async () => ({ spreadsheetId: 'test', sheets: [], created: false }),
      request: async (_config, _path, init) => { signals.push(init?.signal); return {}; },
    });
    assert.deepEqual(timeouts, [45_000], 'only the large final snapshot write gets a longer bounded deadline');
    assert.ok(signals[2] instanceof AbortSignal);
    assert.ok(signals.filter(Boolean).length === 1, 'metadata, clear and audit retain their ordinary deadlines');
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  for (let failedStep = 1; failedStep <= 4; failedStep += 1) {
    let requestCount = 0;
    await assert.rejects(exportStateToGoogleSheetsDatabase(sheetsConfig, state(7, 'Sheets'), 'failure_test', {
      initialize: async () => ({ spreadsheetId: 'test', sheets: [], created: false }),
      request: async () => {
        requestCount += 1;
        if (requestCount === failedStep) throw new Error(`mock export failure at step ${failedStep}`);
        return {};
      },
    }), new RegExp(`step ${failedStep}`));
    assert.equal(requestCount, failedStep, `export must surface failure at step ${failedStep}`);
  }
  console.log('Database recovery verification passed: durable fallback, retention, bounded large-write timeout, write rejection, and every Sheets export failure step.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
