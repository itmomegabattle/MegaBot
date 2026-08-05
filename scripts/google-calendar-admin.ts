import 'dotenv/config';
import { googleSheetsDatabaseConfigFromEnv, importStateFromGoogleSheetsDatabase } from '../src/googleSheetsDatabase.js';
import {
  checkGoogleCalendarAccess,
  googleCalendarConfigFromEnv,
  reconcileGoogleCalendar,
} from '../src/googleCalendarSync.js';

const command = process.argv[2] || 'check';
const calendarConfig = googleCalendarConfigFromEnv();
if (!calendarConfig) throw new Error('Set GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_FILE in .env');

async function main() {
  const calendar = await checkGoogleCalendarAccess(calendarConfig);
  if (command === 'check') {
    console.log(JSON.stringify({ passed: true, enabled: calendarConfig.enabled, calendar }, null, 2));
    return;
  }
  if (command === 'sync') {
    if (!calendarConfig.enabled) throw new Error('Set GOOGLE_CALENDAR_ENABLED=true before synchronization');
    const databaseConfig = googleSheetsDatabaseConfigFromEnv();
    if (!databaseConfig) throw new Error('Google Sheets database configuration is missing');
    const imported = await importStateFromGoogleSheetsDatabase(databaseConfig);
    if (!imported.initialized || !imported.state) throw new Error('Google Sheets database is not initialized');
    const result = await reconcileGoogleCalendar(calendarConfig, imported.state);
    console.log(JSON.stringify({ calendar, meetings: imported.state.meetings.length, ...result }, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}. Use check or sync.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
