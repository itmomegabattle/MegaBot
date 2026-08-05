import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareDatabaseStateCounts,
  exportStateToGoogleSheetsDatabase,
  googleSheetsDatabaseConfigFromEnv,
  importStateFromGoogleSheetsDatabase,
  initializeGoogleSheetsDatabase,
} from '../src/googleSheetsDatabase.js';
import type { SimulationState } from '../src/types.js';

const command = process.argv[2] || 'status';
const config = googleSheetsDatabaseConfigFromEnv();
if (!config) {
  throw new Error('Set GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE in .env');
}

const databaseFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.resolve('database.json');

function readLocalState() {
  if (!fs.existsSync(databaseFile)) throw new Error(`Database file not found: ${databaseFile}`);
  return JSON.parse(fs.readFileSync(databaseFile, 'utf8')) as SimulationState;
}

function writeLocalState(state: SimulationState) {
  const temporaryFile = `${databaseFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temporaryFile, databaseFile);
}

function backupLocalState() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parsed = path.parse(databaseFile);
  const backupFile = path.join(parsed.dir, `${parsed.name}.backup-before-google-sheets-${stamp}${parsed.ext || '.json'}`);
  fs.copyFileSync(databaseFile, backupFile, fs.constants.COPYFILE_EXCL);
  return backupFile;
}

const stateDigest = (state: SimulationState) => crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');

async function main() {
  if (command === 'check' || command === 'init') {
    const result = await initializeGoogleSheetsDatabase(config);
    console.log(JSON.stringify({ passed: true, writeAccess: true, ...result }, null, 2));
    return;
  }

  if (command === 'migrate') {
    const local = readLocalState();
    const backupFile = backupLocalState();
    local.settings ||= {};
    local.settings.databaseRevision = Math.max(1, Number(local.settings.databaseRevision || 0) + 1);
    await initializeGoogleSheetsDatabase(config);
    const exported = await exportStateToGoogleSheetsDatabase(config, local, 'initial_migration');
    const imported = await importStateFromGoogleSheetsDatabase(config);
    if (!imported.initialized || !imported.state) throw new Error('Google Sheets did not return a complete snapshot after migration');
    const comparison = compareDatabaseStateCounts(local, imported.state);
    const sourceDigest = stateDigest(local);
    const destinationDigest = stateDigest(imported.state);
    if (!comparison.passed || sourceDigest !== destinationDigest) throw new Error(`Roundtrip mismatch: ${JSON.stringify({ comparison, sourceDigest, destinationDigest })}`);
    writeLocalState(local);
    console.log(JSON.stringify({
      passed: true,
      spreadsheetId: config.spreadsheetId,
      backupFile,
      revision: exported.revision,
      counts: comparison,
      digest: sourceDigest,
      nextStep: 'Set GOOGLE_SHEETS_DATABASE_ENABLED=true and restart the bot',
    }, null, 2));
    return;
  }

  const imported = await importStateFromGoogleSheetsDatabase(config);
  if (command === 'status') {
    console.log(JSON.stringify({
      passed: imported.initialized,
      spreadsheetId: config.spreadsheetId,
      enabled: config.enabled,
      initialized: imported.initialized,
      revision: imported.revision,
      counts: imported.counts,
    }, null, 2));
    if (!imported.initialized) process.exitCode = 2;
    return;
  }
  if (command === 'verify') {
    if (!imported.initialized || !imported.state) throw new Error('Google Sheets database is not initialized');
    const comparison = compareDatabaseStateCounts(readLocalState(), imported.state);
    const sourceDigest = stateDigest(readLocalState());
    const destinationDigest = stateDigest(imported.state);
    const passed = comparison.passed && sourceDigest === destinationDigest;
    console.log(JSON.stringify({ passed, revision: imported.revision, sourceDigest, destinationDigest, ...comparison }, null, 2));
    if (!passed) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown command: ${command}. Use check, init, migrate, verify, or status.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
