import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  clearGoogleSheetsDatabaseAuditLog,
  exportStateToGoogleSheetsDatabase,
  googleSheetsDatabaseConfigFromEnv,
  importStateFromGoogleSheetsDatabase,
  initializeGoogleSheetsDatabase,
} from '../src/googleSheetsDatabase.js';
import { resetOperationalData } from '../src/stateMaintenance.js';
import type { SimulationState } from '../src/types.js';

const command = process.argv[2] || 'status';
const config = googleSheetsDatabaseConfigFromEnv();
if (!config) throw new Error('Set GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE in .env');

const backupDirectory = path.resolve(process.env.DB_BACKUP_DIR || 'backups');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const digest = (state: SimulationState) => crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');

function writeBackup(state: SimulationState, label: string) {
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupFile = path.join(backupDirectory, `${label}-${stamp()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return backupFile;
}

function archiveLegacyRuntimeFiles() {
  const archived: string[] = [];
  for (const source of [path.resolve('database.json'), path.resolve('database.json.chat-panels.json'), path.resolve('chat-panels.json')]) {
    if (!fs.existsSync(source)) continue;
    const destination = path.join(backupDirectory, `retired-${path.basename(source)}-${stamp()}`);
    fs.renameSync(source, destination);
    archived.push(destination);
  }
  return archived;
}

async function readRemoteState() {
  const imported = await importStateFromGoogleSheetsDatabase(config);
  if (!imported.initialized || !imported.state) throw new Error('Google Sheets database is not initialized');
  return imported;
}

async function assertBotStopped() {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (response.ok) throw new Error('MegaBot is still running. Stop it with: pm2 stop megabot');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MegaBot is still running')) throw error;
  }
}

async function main() {
  if (command === 'check') {
    const result = await initializeGoogleSheetsDatabase(config);
    console.log(JSON.stringify({ passed: true, writeAccess: true, ...result }, null, 2));
    return;
  }

  if (command === 'status') {
    const imported = await readRemoteState();
    console.log(JSON.stringify({
      passed: true,
      spreadsheetId: config.spreadsheetId,
      enabled: config.enabled,
      initialized: imported.initialized,
      revision: imported.revision,
      counts: imported.counts,
      digest: digest(imported.state!),
    }, null, 2));
    return;
  }

  if (command === 'backup') {
    const imported = await readRemoteState();
    const backupFile = writeBackup(imported.state!, 'google-sheets-database');
    console.log(JSON.stringify({ passed: true, backupFile, revision: imported.revision, digest: digest(imported.state!) }, null, 2));
    return;
  }

  if (command === 'restore-backup') {
    if (!process.argv.includes('--confirm')) throw new Error('Restore refused. Stop the bot and repeat with --confirm.');
    await assertBotStopped();
    const requestedFile = process.argv.find((argument, index) => index > 2 && argument !== '--confirm');
    if (!requestedFile) throw new Error('Backup JSON path is required');
    const backupFile = path.resolve(requestedFile);
    const state = JSON.parse(fs.readFileSync(backupFile, 'utf8')) as SimulationState;
    if (!Array.isArray(state.users) || !Array.isArray(state.tasks) || !Array.isArray(state.meetings)) {
      throw new Error('Backup does not contain a valid MegaBot state');
    }
    await exportStateToGoogleSheetsDatabase(config, state, 'manual_restore');
    const verified = await readRemoteState();
    if (digest(verified.state!) !== digest(state)) throw new Error('Restore roundtrip digest mismatch');
    console.log(JSON.stringify({ passed: true, backupFile, revision: verified.revision, digest: digest(state), counts: verified.counts }, null, 2));
    return;
  }

  if (command === 'reset-operational-data') {
    if (!process.argv.includes('--confirm')) throw new Error('Destructive reset refused. Stop the bot and repeat with --confirm.');
    await assertBotStopped();
    const imported = await readRemoteState();
    const backupFile = writeBackup(imported.state!, 'before-production-reset');
    const cleanState = resetOperationalData(imported.state!);
    await clearGoogleSheetsDatabaseAuditLog(config);
    await exportStateToGoogleSheetsDatabase(config, cleanState, 'production_reset');
    const verified = await readRemoteState();
    if (digest(verified.state!) !== digest(cleanState)) throw new Error('Reset roundtrip digest mismatch; backup was preserved');
    const archivedLegacyFiles = archiveLegacyRuntimeFiles();
    console.log(JSON.stringify({
      passed: true,
      backupFile,
      archivedLegacyFiles,
      revision: verified.revision,
      digest: digest(cleanState),
      preservedUsers: cleanState.users.length,
      cleared: { events: 0, meetings: 0, tasks: 0, availabilities: 0, messages: 0 },
    }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}. Use check, status, backup, restore-backup, or reset-operational-data.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
