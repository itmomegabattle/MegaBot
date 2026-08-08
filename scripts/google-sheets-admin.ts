import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  buildUserMappingReport,
  backupPrimarySheet,
  ensureTemplateSheet,
  ensurePrimaryWeekSheet,
  migratePrimaryWeekSheet,
  googleSheetsConfigFromEnv,
  listGoogleSheets,
  importAvailabilitiesFromSheet,
  inspectActiveWeekLayouts,
  inspectGoogleSheetRange,
  exportAvailabilityToSheet,
  currentMoscowWeekStart,
} from '../src/googleSheetsSync.js';

const command = process.argv[2] || 'mapping';
const dbFile = path.resolve(process.env.DB_FILE || 'database.json');
const config = googleSheetsConfigFromEnv();
if (!config) throw new Error('Google Sheets environment variables are not configured');
const state = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const users = Array.isArray(state.users) ? state.users : [];

if (command === 'sheets') {
  console.log(JSON.stringify(await listGoogleSheets(config), null, 2));
} else if (command === 'mapping') {
  console.log(JSON.stringify(await buildUserMappingReport(config, users), null, 2));
} else if (command === 'template') {
  console.log(JSON.stringify(await ensureTemplateSheet(config, users), null, 2));
} else if (command === 'backup') {
  console.log(JSON.stringify(await backupPrimarySheet(config), null, 2));
} else if (command === 'prepare') {
  console.log(JSON.stringify(await ensurePrimaryWeekSheet(config, users, state.settings), null, 2));
} else if (command === 'migrate') {
  console.log(JSON.stringify(await migratePrimaryWeekSheet(config, users, state.settings), null, 2));
} else if (command === 'weeks') {
  console.log(JSON.stringify({ deprecatedCommand: 'weeks', ...(await ensurePrimaryWeekSheet(config, users, state.settings)) }, null, 2));
} else if (command === 'import-preview') {
  console.log(JSON.stringify(await importAvailabilitiesFromSheet(config, users), null, 2));
} else if (command === 'layout') {
  console.log(JSON.stringify(await inspectActiveWeekLayouts(config, users), null, 2));
} else if (command === 'range') {
  const range = process.argv[3];
  if (!range) throw new Error('A1 range is required');
  console.log(JSON.stringify(await inspectGoogleSheetRange(config, range), null, 2));
} else if (command === 'roundtrip-test') {
  const user = users.find((item: any) => item.telegramId) || users[0];
  if (!user) throw new Error('No user available for roundtrip test');
  const base = { userId: user.id, hardUnavailableDays: [], weekStart: currentMoscowWeekStart(), updatedAt: new Date().toISOString() };
  await exportAvailabilityToSheet(config, users, { ...base, slots: { 0: [12] } });
  const imported = await importAvailabilitiesFromSheet(config, users);
  const passed = Boolean(imported.imported.find((item) => item.userId === user.id)?.slots?.[0]?.includes(12));
  await exportAvailabilityToSheet(config, users, { ...base, slots: {} });
  if (!passed) throw new Error('Roundtrip test failed: written slot was not imported');
  console.log(JSON.stringify({ passed: true, userId: user.id, telegramId: user.telegramId, restoredBlank: true }, null, 2));
} else {
  throw new Error(`Unknown command: ${command}`);
}
