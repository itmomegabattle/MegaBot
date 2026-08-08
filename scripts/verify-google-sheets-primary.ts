import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensurePrimaryWeekSheet, migratePrimaryWeekSheet, currentMoscowWeekStart, type GoogleSheetsConfig } from '../src/googleSheetsSync.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-sheets-primary-'));
const credentialsFile = path.join(tempRoot, 'service-account.json');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
await writeFile(credentialsFile, JSON.stringify({
  client_email: 'test@example.invalid',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
}), 'utf8');

const config: GoogleSheetsConfig = {
  spreadsheetId: 'spreadsheet-test',
  credentialsFile,
  webhookSecret: 'test',
  primarySheetTitle: 'старое название не используется',
  primarySheetId: 432131861,
  templateSheetTitle: 'ШАБЛОН НЕДЕЛИ',
  scanRange: 'A1:Z20',
  nameAliases: {},
};
const currentWeek = currentMoscowWeekStart();
const previousWeek = new Date(`${currentWeek}T12:00:00Z`);
previousWeek.setUTCDate(previousWeek.getUTCDate() - 7);
const previousWeekIso = previousWeek.toISOString().slice(0, 10);
const addDays = (dateIso: string, days: number) => {
  const date = new Date(`${dateIso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const shortDate = (dateIso: string, day: number) => {
  const [, month, date] = addDays(dateIso, day).split('-');
  return `${date}.${month} ${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][day]}`;
};

const formatted: unknown[][] = [
  ['ОСНОВА'],
  ['', ...Array.from({ length: 14 }, (_, index) => (index % 2 === 0 ? shortDate(previousWeekIso, index / 2) : ''))],
  ['Время', ...Array.from({ length: 14 }, (_, index) => `${16 + (index % 2)}:00`)],
  ['Алиса Тестовая', ...Array.from({ length: 14 }, (_, index) => (index % 3 === 0 ? 'TRUE' : 'FALSE'))],
  ['Борис Тестовый', ...Array.from({ length: 14 }, () => '')],
];
const raw: unknown[][] = formatted.map((row) => [...row]);
const sheets = [
  { properties: { sheetId: 432131861, title: 'ОСНОВА', index: 0, hidden: false, gridProperties: { rowCount: 20, columnCount: 26 } } },
  { properties: { sheetId: 2001, title: `Неделя ${currentWeek}`, index: 1, hidden: false, gridProperties: { rowCount: 20, columnCount: 26 } } },
  { properties: { sheetId: 2002, title: `Неделя ${addDays(currentWeek, 7)}`, index: 2, hidden: false, gridProperties: { rowCount: 20, columnCount: 26 } } },
];
const calls: { url: string; body?: any }[] = [];
let nextSheetId = 3000;
const testSettings = { availabilityActiveDays: [0, 1, 2, 3, 4], availabilityStartHour: 17, availabilityEndHour: 18 };
const columnIndex = (letters: string) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
const rangeStart = (range: string) => {
  const match = range.match(/!([A-Z]+)(\d+)/);
  if (!match) throw new Error(`Invalid test range: ${range}`);
  return { col: columnIndex(match[1]), row: Number(match[2]) - 1 };
};
const rangeBounds = (range: string) => {
  const match = range.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)/);
  if (!match) throw new Error(`Invalid test range: ${range}`);
  return {
    startCol: columnIndex(match[1]), startRow: Number(match[2]) - 1,
    endCol: columnIndex(match[3]) + 1, endRow: Number(match[4]),
  };
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') {
    calls.push({ url });
    return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
  }
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, body });
  if (url.includes('developerMetadata:search')) {
    return new Response(JSON.stringify({ matchedDeveloperMetadata: [] }), { status: 200 });
  }
  if (url.includes('/values/') && !url.includes('batch')) {
    const values = url.includes('UNFORMATTED_VALUE') ? raw : formatted;
    return new Response(JSON.stringify({ values }), { status: 200 });
  }
  if (url.includes('/values:batchClear')) {
    for (const range of body.ranges) {
      const bounds = rangeBounds(range);
      for (let row = bounds.startRow; row < bounds.endRow; row += 1) for (let col = bounds.startCol; col < bounds.endCol; col += 1) {
        raw[row] ||= []; formatted[row] ||= [];
        raw[row][col] = ''; formatted[row][col] = '';
      }
    }
    return new Response(JSON.stringify({ clearedRanges: body.ranges }), { status: 200 });
  }
  if (url.includes('/values:batchUpdate')) {
    body.data.forEach((item: any) => {
      const start = rangeStart(item.range);
      item.values.forEach((rowValues: unknown[], rowOffset: number) => rowValues.forEach((value, colOffset) => {
        const row = start.row + rowOffset;
        const col = start.col + colOffset;
        raw[row] ||= []; formatted[row] ||= [];
        raw[row][col] = value;
        formatted[row][col] = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : value;
      }));
    });
    return new Response(JSON.stringify({ totalUpdatedCells: 1 }), { status: 200 });
  }
  if (url.endsWith(':batchUpdate')) {
    for (const request of body.requests || []) {
      if (request.duplicateSheet) {
        sheets.push({ properties: {
          sheetId: nextSheetId++, title: request.duplicateSheet.newSheetName,
          index: sheets.length, hidden: false, gridProperties: { rowCount: 20, columnCount: 26 },
        } });
      }
      if (request.updateSheetProperties) {
        const sheet = sheets.find((item) => item.properties.sheetId === request.updateSheetProperties.properties.sheetId);
        if (sheet) sheet.properties.hidden = Boolean(request.updateSheetProperties.properties.hidden);
      }
    }
    const duplicate = body.requests?.find((request: any) => request.duplicateSheet);
    return new Response(JSON.stringify({ replies: duplicate ? [{ duplicateSheet: { properties: sheets[sheets.length - 1].properties } }] : [] }), { status: 200 });
  }
  if (url.includes('?fields=sheets.properties')) {
    return new Response(JSON.stringify({ sheets }), { status: 200 });
  }
  throw new Error(`Unexpected Google API request in test: ${url}`);
};

try {
  const users = [
    { id: 'u_alice', realName: 'Алиса Тестовая' },
    { id: 'u_bob', realName: 'Борис Тестовый' },
  ];
  const first = await ensurePrimaryWeekSheet(config, users, testSettings);
  assert.equal(first.primary, 'ОСНОВА');
  assert.equal(first.rotated, true);
  assert.ok(first.backup?.backupTitle.startsWith('РЕЗЕРВ ОСНОВА '));
  assert.equal(first.backup?.verified, true);
  assert.deepEqual(first.hiddenLegacySheets, [`Неделя ${currentWeek}`, `Неделя ${addDays(currentWeek, 7)}`]);
  const duplicateIndex = calls.findIndex((call) => call.body?.requests?.some((request: any) => request.duplicateSheet));
  const clearIndex = calls.findIndex((call) => call.url.includes('/values:batchClear'));
  const layoutWriteIndex = calls.findIndex((call, index) => index > clearIndex && call.body?.valueInputOption === 'RAW');
  assert.ok(duplicateIndex >= 0 && duplicateIndex < clearIndex && clearIndex < layoutWriteIndex);
  const validationRequest = calls.find((call) => call.body?.requests?.some((request: any) => request.setDataValidation));
  assert.ok(validationRequest);
  assert.ok(validationRequest.body.requests.every((request: any) => (
    request.setDataValidation.rule.condition.type === 'BOOLEAN'
    && request.setDataValidation.rule.showCustomUi === true
  )));
  const rawCheckboxWrite = calls.find((call) => call.body?.valueInputOption === 'RAW' && call.body.data.every((item: any) => item.values.flat().every((value: unknown) => typeof value === 'boolean')));
  assert.ok(rawCheckboxWrite?.body.data.every((item: any) => item.values.flat().every((value: unknown) => typeof value === 'boolean')));
  assert.ok(!calls.some((call) => call.body?.requests?.some((request: any) => (
    request.duplicateSheet?.newSheetName?.startsWith('Неделя ')
  ))));

  calls.length = 0;
  const second = await ensurePrimaryWeekSheet(config, users, testSettings);
  assert.equal(second.rotated, false);
  assert.equal(second.backup, null);
  assert.ok(!calls.some((call) => call.url.includes('/values:batchClear')));
  assert.ok(!calls.some((call) => call.body?.requests?.some((request: any) => request.duplicateSheet)));

  calls.length = 0;
  const migration = await migratePrimaryWeekSheet(config, users, testSettings);
  assert.equal(migration.backup?.verified, true);
  assert.equal(calls.filter((call) => call.body?.requests?.some((request: any) => request.duplicateSheet)).length, 1);
  assert.ok(!calls.some((call) => call.url.includes('/values:batchClear')));

  formatted.length = 0;
  raw.length = 0;
  const fixedRows = Array.from({ length: 5 }, () => Array(74).fill(''));
  fixedRows[2][0] = 'МегаОрги';
  fixedRows[2][1] = 'Статус';
  fixedRows[2][2] = 'Я в ауте';
  fixedRows[2][73] = 'Тэг';
  [8, 14, 20, 26, 32].forEach((start, day) => {
    fixedRows[2][start] = shortDate(currentWeek, day);
    [17, 18, 19, 20, 21, 22].forEach((hour, offset) => { fixedRows[3][start + offset] = `${hour}:00`; });
  });
  fixedRows[4][0] = 'Алиса Тестовая';
  fixedRows[4][73] = '@alice';
  formatted.push(...fixedRows.map((row) => [...row]));
  raw.push(...fixedRows.map((row) => [...row]));
  sheets[0].properties.gridProperties.columnCount = 74;
  calls.length = 0;
  const repairedFixedLayout = await ensurePrimaryWeekSheet(config, users, {
    availabilityActiveDays: [0, 1, 2, 3, 4], availabilityStartHour: 17, availabilityEndHour: 22,
  });
  assert.equal(repairedFixedLayout.layoutChanged, true);
  const fixedLayoutBatch = calls.find((call) => call.body?.requests?.some((request: any) => request.updateDimensionProperties));
  assert.ok(fixedLayoutBatch?.body.requests.some((request: any) => (
    request.mergeCells?.range?.startColumnIndex === 3 && request.mergeCells?.range?.endColumnIndex === 9
  )));
  assert.ok(fixedLayoutBatch?.body.requests.some((request: any) => (
    request.updateDimensionProperties?.range?.startIndex === 53
    && request.updateDimensionProperties?.properties?.hiddenByUser === true
  )));
  const fixedValuesWrite = calls.find((call) => call.body?.valueInputOption === 'RAW' && call.body.data.some((item: any) => item.range.includes('!D3')));
  assert.ok(fixedValuesWrite?.body.data.some((item: any) => item.range.includes('!N3')));
  assert.ok(fixedValuesWrite?.body.data.some((item: any) => item.range.includes('!AR3')));
  console.log('Google Sheets primary-sheet verification passed: backup-before-rotation, ОСНОВА-only sync, checkboxes, legacy hiding, and idempotency.');
} finally {
  globalThis.fetch = originalFetch;
  await rm(tempRoot, { recursive: true, force: true });
}
