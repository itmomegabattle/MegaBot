import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  exportStateToGoogleSheetsDatabase,
  googleSheetsDatabaseConfigFromEnv,
  importStateFromGoogleSheetsDatabase,
} from '../src/googleSheetsDatabase.js';
import { addAvailabilityWeeks } from '../src/availabilityConfig.js';

const anchorArgument = process.argv.find((argument) => argument.startsWith('--anchor='));
const anchor = String(anchorArgument?.split('=')[1] || '');
if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
  throw new Error('Pass the Monday of the first legacy name: --anchor=YYYY-MM-DD');
}

const config = googleSheetsDatabaseConfigFromEnv();
if (!config) throw new Error('Google Sheets database is not configured');

const imported = await importStateFromGoogleSheetsDatabase(config);
if (!imported.initialized || !imported.state) throw new Error('Google Sheets database is not initialized');
const state = imported.state;
state.settings ||= {};

const existingMetadata = state.settings.availabilityWeekMetadata || {};
if (Object.keys(existingMetadata).length > 0) {
  console.log(JSON.stringify({ passed: true, migrated: false, reason: 'date-bound metadata already exists', metadata: existingMetadata }, null, 2));
  process.exit(0);
}

const names = state.settings.availabilityWeekNames || [];
const descriptions = state.settings.availabilityWeekDescriptions || [];
const metadata = Object.fromEntries(names.map((name, index) => [addAvailabilityWeeks(anchor, index), {
  name: String(name || '').trim(),
  description: String(descriptions[index] || '').trim(),
}]));

const backupDirectory = path.resolve(process.env.DB_BACKUP_DIR || 'backups');
fs.mkdirSync(backupDirectory, { recursive: true });
const backupFile = path.join(backupDirectory, `before-week-metadata-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(backupFile, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });

state.settings.availabilityWeekMetadata = metadata;
state.settings.databaseRevision = Math.max(Number(imported.revision || 0), Number(state.settings.databaseRevision || 0)) + 1;
await exportStateToGoogleSheetsDatabase(config, state, 'availability_week_metadata_migration');

const verified = await importStateFromGoogleSheetsDatabase(config);
if (!verified.state?.settings?.availabilityWeekMetadata) throw new Error('Migration verification failed');
console.log(JSON.stringify({
  passed: true,
  migrated: true,
  anchor,
  backupFile,
  revision: verified.revision,
  metadata: verified.state.settings.availabilityWeekMetadata,
}, null, 2));
