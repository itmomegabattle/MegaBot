import crypto from 'crypto';
import fs from 'fs';
import { AvailabilitySettings, normalizeAvailabilityConfig } from './availabilityConfig.js';

export type GoogleSheetsConfig = {
  spreadsheetId: string;
  credentialsFile: string;
  webhookSecret: string;
  primarySheetTitle: string;
  primarySheetId?: number;
  templateSheetTitle: string;
  scanRange: string;
  nameAliases: Record<string, string>;
};

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type SheetUser = {
  id: string;
  realName: string;
  telegramId?: string;
  registered?: boolean;
  lastSeenAt?: string;
};
type SheetAvailability = {
  userId: string;
  slots: Record<number, number[]>;
  hardUnavailableDays?: number[];
  outWeekIndexes?: number[];
  weekStart?: string;
  updatedAt: string;
};

type SheetGrid = {
  title: string;
  sheetId: number;
  formatted: unknown[][];
  raw: unknown[][];
  rowTelegramIds: Map<number, string>;
};

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
let tokenCache: { value: string; expiresAt: number; key: string } | null = null;

export function googleSheetsConfigFromEnv(): GoogleSheetsConfig | null {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const credentialsFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  if (!spreadsheetId || !credentialsFile) return null;
  const nameAliases = Object.fromEntries((process.env.GOOGLE_SHEETS_NAME_ALIASES || '')
    .split(',')
    .map((entry) => entry.split('=').map((part) => part.trim()))
    .filter((entry) => entry.length === 2 && entry[0] && entry[1]));
  return {
    spreadsheetId,
    credentialsFile,
    webhookSecret: process.env.GOOGLE_SHEETS_WEBHOOK_SECRET?.trim() || '',
    primarySheetTitle: process.env.GOOGLE_SHEETS_PRIMARY_SHEET_TITLE?.trim() || 'ОСНОВА',
    primarySheetId: Number.isInteger(Number(process.env.GOOGLE_SHEETS_PRIMARY_SHEET_ID)) ? Number(process.env.GOOGLE_SHEETS_PRIMARY_SHEET_ID) : undefined,
    templateSheetTitle: process.env.GOOGLE_SHEETS_TEMPLATE_SHEET_TITLE?.trim() || 'ШАБЛОН НЕДЕЛИ',
    scanRange: process.env.GOOGLE_SHEETS_SCAN_RANGE?.trim() || 'A1:ZZ200',
    nameAliases,
  };
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url');
}

function loadCredentials(config: Pick<GoogleSheetsConfig, 'credentialsFile'>): ServiceAccountCredentials {
  const parsed = JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8')) as ServiceAccountCredentials;
  if (!parsed.client_email || !parsed.private_key) throw new Error('Google service account JSON is incomplete');
  return parsed;
}

async function accessToken(config: Pick<GoogleSheetsConfig, 'credentialsFile'>) {
  const credentials = loadCredentials(config);
  const cacheKey = `${credentials.client_email}:${config.credentialsFile}`;
  if (tokenCache && tokenCache.key === cacheKey && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: GOOGLE_SCOPE,
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url')}`;
  const response = await fetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(body.error_description || `Google token request failed: ${response.status}`);
  tokenCache = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000, key: cacheKey };
  return body.access_token;
}

export async function googleSheetsApiRequest(config: Pick<GoogleSheetsConfig, 'spreadsheetId' | 'credentialsFile'>, path: string, init: RequestInit = {}) {
  const token = await accessToken(config);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google Sheets API ${response.status}: ${JSON.stringify(body)}`);
  return body as any;
}

async function googleRequest(config: GoogleSheetsConfig, path: string, init: RequestInit = {}) {
  return googleSheetsApiRequest(config, path, init);
}

function quotedSheet(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

const WEEK_SHEET_RE = /^Неделя (\d{4}-\d{2}-\d{2})$/;

function addDays(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function sheetMetadata(config: GoogleSheetsConfig) {
  return googleRequest(config, '?fields=sheets.properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount))') as Promise<{
    sheets: { properties: { sheetId: number; title: string; index: number; hidden?: boolean; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
  }>;
}

type TelegramIdMetadata = {
  metadataId: number;
  metadataKey: string;
  metadataValue?: string;
  location?: { dimensionRange?: { sheetId?: number; dimension?: string; startIndex?: number; endIndex?: number } };
};

async function telegramIdMetadata(config: GoogleSheetsConfig): Promise<TelegramIdMetadata[]> {
  const result = await googleRequest(config, '/developerMetadata:search', {
    method: 'POST',
    body: JSON.stringify({ dataFilters: [{ developerMetadataLookup: { metadataKey: 'megabotTelegramId' } }] }),
  }) as { matchedDeveloperMetadata?: { developerMetadata?: TelegramIdMetadata }[] };
  return (result.matchedDeveloperMetadata || [])
    .map((match) => match.developerMetadata)
    .filter((item): item is TelegramIdMetadata => Boolean(item));
}

export async function listGoogleSheets(config: GoogleSheetsConfig) {
  const metadata = await sheetMetadata(config);
  return metadata.sheets.map((sheet) => sheet.properties);
}

export async function inspectGoogleSheetRange(config: GoogleSheetsConfig, a1Range: string) {
  const range = encodeURIComponent(a1Range);
  const [formulas, formatted] = await Promise.all([
    googleRequest(config, `/values/${range}?majorDimension=ROWS&valueRenderOption=FORMULA`),
    googleRequest(config, `/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`),
  ]);
  return { range: a1Range, formulas: formulas.values || [], values: formatted.values || [] };
}

export async function inspectActiveWeekLayouts(config: GoogleSheetsConfig, users: SheetUser[]) {
  const grids = await readActiveWeekGrids(config);
  const weekStart = currentMoscowWeekStart();
  return grids.map((grid) => {
    const layout = discover(grid, users, weekStart, config.nameAliases);
    return {
      sheet: grid.title,
      dateRow: layout.dateRow + 1,
      hourRow: layout.hourRow + 1,
      topRows: grid.formatted.slice(0, 4).map((row, rowIndex) => ({ row: rowIndex + 1, values: row.map((value, col) => value === '' || value == null ? null : `${columnName(col)}=${String(value)}`).filter(Boolean) })),
      columns: layout.columnHours.map((hour, col) => hour === null ? null : ({ column: columnName(col), date: layout.columnDates[col], hour })).filter(Boolean),
    };
  });
}

async function readGrid(config: GoogleSheetsConfig, title = config.primarySheetTitle): Promise<SheetGrid> {
  const metadata = await sheetMetadata(config);
  const sheet = title === config.primarySheetTitle && config.primarySheetId !== undefined
    ? metadata.sheets.find((item) => item.properties.sheetId === config.primarySheetId)
    : metadata.sheets.find((item) => item.properties.title === title);
  if (!sheet) throw new Error(`Google sheet not found: ${title}`);
  const actualTitle = sheet.properties.title;
  const range = encodeURIComponent(`${quotedSheet(actualTitle)}!${config.scanRange}`);
  const [formatted, raw] = await Promise.all([
    googleRequest(config, `/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`),
    googleRequest(config, `/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`),
  ]);
  const rowTelegramIds = new Map<number, string>();
  (await telegramIdMetadata(config)).forEach((item) => {
    const range = item.location?.dimensionRange;
    if (item.metadataKey === 'megabotTelegramId' && range?.sheetId === sheet.properties.sheetId && range.dimension === 'ROWS' && range.startIndex !== undefined && item.metadataValue) {
      rowTelegramIds.set(range.startIndex, item.metadataValue);
    }
  });
  return { title: actualTitle, sheetId: sheet.properties.sheetId, formatted: formatted.values || [], raw: raw.values || [], rowTelegramIds };
}

async function readActiveWeekGrids(config: GoogleSheetsConfig) {
  return [await readGrid(config)];
}

function normalizeName(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function parseHour(value: unknown) {
  const match = String(value || '').match(/(?:^|\s)(\d{1,2}):(?:00|0)(?:$|\s)/);
  const hour = match ? Number(match[1]) : NaN;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function moscowDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function currentMoscowWeekStart() {
  const p = moscowDateParts();
  const localNoonUtc = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  const day = localNoonUtc.getUTCDay() || 7;
  localNoonUtc.setUTCDate(localNoonUtc.getUTCDate() - day + 1);
  return localNoonUtc.toISOString().slice(0, 10);
}

function parseHeaderDate(value: unknown, anchorWeekStart: string) {
  if (typeof value === 'number' && value > 20_000) {
    return new Date(Date.UTC(1899, 11, 30 + value)).toISOString().slice(0, 10);
  }
  const text = String(value || '').trim();
  const match = text.match(/(?:^|\s)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const anchor = new Date(`${anchorWeekStart}T12:00:00Z`);
  const candidates = [anchor.getUTCFullYear() - 1, anchor.getUTCFullYear(), anchor.getUTCFullYear() + 1]
    .map((year) => new Date(Date.UTC(year, month - 1, day, 12)));
  candidates.sort((a, b) => Math.abs(a.getTime() - anchor.getTime()) - Math.abs(b.getTime() - anchor.getTime()));
  return candidates[0].toISOString().slice(0, 10);
}

function dayIndexFor(dateIso: string, weekStart: string) {
  return Math.round((new Date(`${dateIso}T12:00:00Z`).getTime() - new Date(`${weekStart}T12:00:00Z`).getTime()) / 86_400_000);
}

function discover(grid: SheetGrid, users: SheetUser[], weekStart = currentMoscowWeekStart(), nameAliases: Record<string, string> = {}) {
  const headerDateRows = Math.min(8, grid.formatted.length);
  const maxCols = Math.max(...grid.formatted.slice(0, headerDateRows).map((row) => row.length), 0);
  const columnDates: (string | null)[] = Array(maxCols).fill(null);
  const columnHours: (number | null)[] = Array(maxCols).fill(null);
  let dateRow = -1;
  let hourRow = -1;
  let bestDateCount = 0;
  let bestTextDateCount = 0;
  let bestHourCount = 0;
  for (let row = 0; row < headerDateRows; row += 1) {
    const dates = (grid.formatted[row] || []).map((value) => parseHeaderDate(value, weekStart)).filter(Boolean).length;
    const textDates = (grid.formatted[row] || []).filter((value) => typeof value === 'string' && /\d{1,2}[./-]\d{1,2}/.test(value)).length;
    const hours = (grid.formatted[row] || []).map(parseHour).filter((value) => value !== null).length;
    if (textDates > bestTextDateCount
      || (textDates === bestTextDateCount && dates > bestDateCount)
      || (textDates === bestTextDateCount && dates === bestDateCount && row > dateRow)) {
      bestTextDateCount = textDates; bestDateCount = dates; dateRow = row;
    }
    if (hours > bestHourCount) { bestHourCount = hours; hourRow = row; }
  }
  if (dateRow < 0 || hourRow < 0) throw new Error('Could not discover date/time headers in the primary sheet');
  let carriedDate: string | null = null;
  for (let col = 0; col < maxCols; col += 1) {
    const explicitDate = parseHeaderDate(grid.formatted[dateRow]?.[col], weekStart);
    if (explicitDate) carriedDate = explicitDate;
    const hour = parseHour(grid.formatted[hourRow]?.[col]);
    columnDates[col] = hour === null ? null : carriedDate;
    columnHours[col] = hour;
  }
  const userByName = new Map(users.map((user) => [normalizeName(user.realName), user]));
  const userByTelegramId = new Map(users.filter((user) => user.telegramId).map((user) => [String(user.telegramId), user]));
  const normalizedAliases = new Map(Object.entries(nameAliases).map(([name, telegramId]) => [normalizeName(name), telegramId]));
  const rows: { rowIndex: number; name: string; user?: SheetUser; matchSource?: string }[] = [];
  const allRows: { rowIndex: number; name: string; user?: SheetUser; matchSource?: string }[] = [];
  let startedPeople = false;
  for (let row = hourRow + 1; row < grid.formatted.length; row += 1) {
    const name = String(grid.formatted[row]?.[0] || '').trim();
    if (!name) {
      if (startedPeople) break;
      continue;
    }
    startedPeople = true;
    const normalized = normalizeName(name);
    const storedTelegramId = String(grid.rowTelegramIds.get(row) || '').trim();
    const idUser = storedTelegramId ? userByTelegramId.get(storedTelegramId) : undefined;
    const exactUser = userByName.get(normalized);
    const aliasUser = userByTelegramId.get(String(normalizedAliases.get(normalized) || ''));
    const user = idUser || exactUser || aliasUser;
    const matchSource = idUser ? 'telegram_id' : exactUser ? 'exact_normalized_name' : aliasUser ? 'confirmed_alias' : undefined;
    allRows.push({ rowIndex: row, name, user, matchSource });
    if (user) rows.push({ rowIndex: row, name, user, matchSource });
  }
  let outColumn = -1;
  for (let row = 0; row < headerDateRows && outColumn < 0; row += 1) {
    outColumn = (grid.formatted[row] || []).findIndex((value) => (
      String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ') === 'я в ауте'
    ));
  }
  return { dateRow, hourRow, outColumn, columnDates, columnHours, rows, allRows };
}

function isSelected(value: unknown) {
  if (value === true || value === 1) return true;
  const normalized = String(value || '').trim().toLocaleLowerCase('ru-RU');
  return normalized === 'true' || normalized === 'истина' || normalized === 'да' || normalized === '1' || normalized === '✓' || normalized === '✅';
}

export async function importAvailabilitiesFromSheet(config: GoogleSheetsConfig, users: SheetUser[], changedRow?: number, changedSheetTitle?: string) {
  const grids = changedSheetTitle ? [await readGrid(config, changedSheetTitle)] : await readActiveWeekGrids(config);
  const weekStart = currentMoscowWeekStart();
  const now = new Date().toISOString();
  const byUser = new Map<string, SheetAvailability>();
  const allMatches: { sheet: string; sheetRow: number; sheetName: string; userId?: string; telegramId?: string }[] = [];
  let activeColumns = 0;
  for (const grid of grids) {
    const layout = discover(grid, users, weekStart, config.nameAliases);
    for (const row of layout.rows) {
      allMatches.push({ sheet: grid.title, sheetRow: row.rowIndex + 1, sheetName: row.name, userId: row.user?.id, telegramId: row.user?.telegramId });
      if (!row.user || (changedRow && row.rowIndex + 1 !== changedRow)) continue;
      const availability = byUser.get(row.user.id) || { userId: row.user.id, slots: {}, hardUnavailableDays: [], outWeekIndexes: [], weekStart, updatedAt: now };
      if (layout.outColumn >= 0 && isSelected(grid.raw[row.rowIndex]?.[layout.outColumn])) {
        availability.outWeekIndexes = [0];
      }
      for (let col = 0; col < layout.columnHours.length; col += 1) {
        const hour = layout.columnHours[col];
        const date = layout.columnDates[col];
        if (hour === null || !date) continue;
        const dayIndex = dayIndexFor(date, weekStart);
        if (dayIndex < 0 || dayIndex >= 35) continue;
        activeColumns += 1;
        if (!availability.slots[dayIndex]) availability.slots[dayIndex] = [];
        if (isSelected(grid.raw[row.rowIndex]?.[col])) availability.slots[dayIndex].push(hour);
      }
      byUser.set(row.user.id, availability);
    }
  }
  if (!activeColumns) throw new Error('Active sheets do not contain current or future week headers yet');
  const imported = [...byUser.values()];
  imported.forEach((availability) => {
    if (availability.outWeekIndexes?.includes(0)) {
      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) delete availability.slots[dayIndex];
    }
    Object.values(availability.slots).forEach((hours) => hours.sort((a, b) => a - b));
  });
  return { imported, matches: allMatches };
}

function columnName(index: number) {
  let value = index + 1;
  let result = '';
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}

export async function exportAvailabilityToSheet(config: GoogleSheetsConfig, users: SheetUser[], availability: SheetAvailability) {
  const grids = await readActiveWeekGrids(config);
  const weekStart = availability.weekStart || currentMoscowWeekStart();
  const data: { range: string; values: boolean[][] }[] = [];
  let matchedRow = 0;
  for (const grid of grids) {
    const layout = discover(grid, users, weekStart, config.nameAliases);
    const row = layout.rows.find((item) => item.user?.id === availability.userId);
    if (!row) continue;
    matchedRow = row.rowIndex + 1;
    if (layout.outColumn >= 0) data.push({
      range: `${quotedSheet(grid.title)}!${columnName(layout.outColumn)}${row.rowIndex + 1}`,
      values: [[Boolean(availability.outWeekIndexes?.includes(0))]],
    });
    for (let col = 0; col < layout.columnHours.length; col += 1) {
      const hour = layout.columnHours[col];
      const date = layout.columnDates[col];
      if (hour === null || !date) continue;
      const dayIndex = dayIndexFor(date, weekStart);
      if (dayIndex < 0 || dayIndex >= 35) continue;
      const outForWeek = availability.outWeekIndexes?.includes(Math.floor(dayIndex / 7));
      data.push({ range: `${quotedSheet(grid.title)}!${columnName(col)}${row.rowIndex + 1}`, values: [[!outForWeek && Boolean(availability.slots[dayIndex]?.includes(hour))]] });
    }
  }
  if (!matchedRow) throw new Error(`User ${availability.userId} was not matched to a row in Google Sheets`);
  if (!data.length) throw new Error('No writable availability cells were discovered for the requested week');
  await googleRequest(config, '/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  return { updatedCells: data.length, sheetRow: matchedRow };
}

export async function exportAvailabilitiesToSheet(config: GoogleSheetsConfig, users: SheetUser[], availabilities: Record<string, SheetAvailability>) {
  const grids = await readActiveWeekGrids(config);
  const weekStart = currentMoscowWeekStart();
  const data: { range: string; values: boolean[][] }[] = [];
  for (const grid of grids) {
    const layout = discover(grid, users, weekStart, config.nameAliases);
    for (const row of layout.rows) {
      if (!row.user) continue;
      const availability = availabilities[row.user.id];
      if (layout.outColumn >= 0) data.push({
        range: `${quotedSheet(grid.title)}!${columnName(layout.outColumn)}${row.rowIndex + 1}`,
        values: [[Boolean(availability?.outWeekIndexes?.includes(0))]],
      });
      for (let col = 0; col < layout.columnHours.length; col += 1) {
        const hour = layout.columnHours[col];
        const date = layout.columnDates[col];
        if (hour === null || !date) continue;
        const dayIndex = dayIndexFor(date, availability?.weekStart || weekStart);
        if (dayIndex < 0 || dayIndex >= 35) continue;
        data.push({
          range: `${quotedSheet(grid.title)}!${columnName(col)}${row.rowIndex + 1}`,
          values: [[!availability?.outWeekIndexes?.includes(Math.floor(dayIndex / 7)) && Boolean(availability?.slots[dayIndex]?.includes(hour))]],
        });
      }
    }
  }
  for (let offset = 0; offset < data.length; offset += 500) {
    await googleRequest(config, '/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: data.slice(offset, offset + 500) }),
    });
  }
  return { updatedCells: data.length };
}

export async function buildUserMappingReport(config: GoogleSheetsConfig, users: SheetUser[]) {
  const grid = await readGrid(config);
  const layout = discover(grid, users, currentMoscowWeekStart(), config.nameAliases);
  const matchedIds = new Set(layout.rows.map((row) => row.user?.id).filter(Boolean));
  return {
    sheet: grid.title,
    matches: layout.rows.map((row) => ({
      sheetRow: row.rowIndex + 1,
      sheetName: row.name,
      appName: row.user?.realName,
      telegramId: row.user?.telegramId || '',
      registered: Boolean(row.user?.registered),
      lastSeenAt: row.user?.lastSeenAt || '',
      confidence: row.matchSource,
    })),
    unmatchedSheetUsers: layout.allRows.filter((row) => !row.user).map((row) => ({ sheetRow: row.rowIndex + 1, sheetName: row.name })),
    unmatchedAppUsers: users.filter((user) => !matchedIds.has(user.id)),
  };
}

export function verifySheetsWebhook(secret: string, timestamp: string, body: Buffer, signature: string) {
  if (!secret || !timestamp || !signature) return false;
  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > 5 * 60_000) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body.toString('utf8')}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex')); } catch { return false; }
}

export async function ensureTemplateSheet(config: GoogleSheetsConfig, users: SheetUser[]) {
  const metadata = await sheetMetadata(config);
  const existing = metadata.sheets.find((item) => item.properties.title === config.templateSheetTitle);
  if (existing) return { created: false, sheetId: existing.properties.sheetId };
  const source = config.primarySheetId !== undefined
    ? metadata.sheets.find((item) => item.properties.sheetId === config.primarySheetId)
    : metadata.sheets.find((item) => item.properties.title === config.primarySheetTitle);
  if (!source) throw new Error(`Primary sheet not found: ${config.primarySheetTitle}`);
  const duplicated = await googleRequest(config, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ duplicateSheet: { sourceSheetId: source.properties.sheetId, newSheetName: config.templateSheetTitle, insertSheetIndex: metadata.sheets.length } }] }),
  });
  const grid = await readGrid(config, config.templateSheetTitle);
  const layout = discover(grid, users, currentMoscowWeekStart(), config.nameAliases);
  const ranges: string[] = [];
  for (const row of layout.allRows) {
    for (let col = 0; col < layout.columnHours.length; col += 1) {
      if (layout.columnHours[col] !== null && layout.columnDates[col]) ranges.push(`${quotedSheet(grid.title)}!${columnName(col)}${row.rowIndex + 1}`);
    }
  }
  if (ranges.length) await googleRequest(config, '/values:batchClear', { method: 'POST', body: JSON.stringify({ ranges }) });
  return { created: true, sheetId: duplicated.replies?.[0]?.duplicateSheet?.properties?.sheetId, clearedCells: ranges.length };
}

function findPrimarySheet(metadata: Awaited<ReturnType<typeof sheetMetadata>>, config: GoogleSheetsConfig) {
  return config.primarySheetId !== undefined
    ? metadata.sheets.find((sheet) => sheet.properties.sheetId === config.primarySheetId)
    : metadata.sheets.find((sheet) => sheet.properties.title === config.primarySheetTitle);
}

export async function backupPrimarySheet(config: GoogleSheetsConfig, label = 'РЕЗЕРВ ОСНОВА') {
  const metadata = await sheetMetadata(config);
  const source = findPrimarySheet(metadata, config);
  if (!source) throw new Error(`Primary sheet not found by id/title: ${config.primarySheetId ?? config.primarySheetTitle}`);
  const title = label.slice(0, 100);
  const previous = metadata.sheets.find((sheet) => sheet.properties.title === title && sheet.properties.sheetId !== source.properties.sheetId);
  const requests: unknown[] = [];
  if (previous) requests.push({ deleteSheet: { sheetId: previous.properties.sheetId } });
  requests.push({ duplicateSheet: {
    sourceSheetId: source.properties.sheetId,
    newSheetName: title,
    insertSheetIndex: metadata.sheets.length - (previous ? 1 : 0),
  } });
  const duplicated = await googleRequest(config, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  const duplicateReply = duplicated.replies?.find((reply: any) => reply?.duplicateSheet);
  const backupSheetId = Number(duplicateReply?.duplicateSheet?.properties?.sheetId);
  if (!Number.isInteger(backupSheetId)) throw new Error('Google Sheets did not return the backup sheet ID');
  const verifiedMetadata = await sheetMetadata(config);
  const verifiedBackup = verifiedMetadata.sheets.find((sheet) => (
    sheet.properties.sheetId === backupSheetId && sheet.properties.title === title
  ));
  if (!verifiedBackup) throw new Error(`Backup verification failed: ${title}`);
  return {
    sourceSheetId: source.properties.sheetId,
    sourceTitle: source.properties.title,
    backupSheetId,
    backupTitle: title,
    verified: true,
  };
}

function availabilityRegions(grid: SheetGrid, layout: ReturnType<typeof discover>) {
  if (!layout.allRows.length) throw new Error(`No participant rows were discovered in ${grid.title}`);
  const slotColumns = layout.columnHours
    .map((hour, col) => (hour !== null && layout.columnDates[col] ? col : -1))
    .filter((col) => col >= 0);
  if (!slotColumns.length) throw new Error(`No availability columns were discovered in ${grid.title}`);
  const columnRegions: { start: number; end: number }[] = [];
  for (const col of slotColumns) {
    const current = columnRegions[columnRegions.length - 1];
    if (current && current.end === col) current.end = col + 1;
    else columnRegions.push({ start: col, end: col + 1 });
  }
  const startRow = Math.min(...layout.allRows.map((row) => row.rowIndex));
  const endRow = Math.max(...layout.allRows.map((row) => row.rowIndex)) + 1;
  return columnRegions.map((region) => ({ ...region, startRow, endRow }));
}

async function ensurePrimaryCheckboxes(
  config: GoogleSheetsConfig,
  grid: SheetGrid,
  layout: ReturnType<typeof discover>,
) {
  const regions = availabilityRegions(grid, layout);
  if (layout.outColumn >= 0 && layout.allRows.length) {
    regions.unshift({
      start: layout.outColumn,
      end: layout.outColumn + 1,
      startRow: Math.min(...layout.allRows.map((row) => row.rowIndex)),
      endRow: Math.max(...layout.allRows.map((row) => row.rowIndex)) + 1,
    });
  }
  await googleRequest(config, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: regions.map((region) => ({ setDataValidation: {
      range: {
        sheetId: grid.sheetId,
        startRowIndex: region.startRow,
        endRowIndex: region.endRow,
        startColumnIndex: region.start,
        endColumnIndex: region.end,
      },
      rule: { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true },
    } })) }),
  });
  const data = regions.map((region) => ({
    range: `${quotedSheet(grid.title)}!${columnName(region.start)}${region.startRow + 1}:${columnName(region.end - 1)}${region.endRow}`,
    values: Array.from({ length: region.endRow - region.startRow }, (_, rowOffset) => (
      Array.from({ length: region.end - region.start }, (_, colOffset) => (
        isSelected(grid.raw[region.startRow + rowOffset]?.[region.start + colOffset])
      ))
    )),
  }));
  await googleRequest(config, '/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  return { regions: regions.length, checkboxCells: regions.reduce((sum, region) => (
    sum + (region.endRow - region.startRow) * (region.end - region.start)
  ), 0) };
}

export async function persistTelegramIdBindings(config: GoogleSheetsConfig, users: SheetUser[]) {
  const metadata = await sheetMetadata(config);
  const currentWeek = currentMoscowWeekStart();
  const selected = metadata.sheets.filter((sheet) => (
    sheet.properties.sheetId === config.primarySheetId
    || sheet.properties.title === config.templateSheetTitle
    || (config.primarySheetId === undefined && sheet.properties.title === config.primarySheetTitle)
  ));
  const requests: unknown[] = [];
  const bindings: { sheet: string; row: number; telegramId: string; name: string }[] = [];
  for (const sheet of selected) {
    const grid = await readGrid(config, sheet.properties.title);
    const layout = discover(grid, users, currentWeek, config.nameAliases);
    for (const row of layout.rows) {
      const telegramId = String(row.user?.telegramId || '').trim();
      if (!telegramId) continue;
      if (String(grid.rowTelegramIds.get(row.rowIndex) || '').trim() !== telegramId) {
        requests.push({ createDeveloperMetadata: { developerMetadata: {
          metadataKey: 'megabotTelegramId', metadataValue: telegramId, visibility: 'DOCUMENT',
          location: { dimensionRange: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: row.rowIndex, endIndex: row.rowIndex + 1 } },
        } } });
      }
      bindings.push({ sheet: grid.title, row: row.rowIndex + 1, telegramId, name: row.name });
    }
  }
  if (requests.length) await googleRequest(config, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  return { writtenBindings: requests.length, bindings };
}

async function preparePrimaryWeekSheet(
  config: GoogleSheetsConfig,
  users: SheetUser[],
  settings?: AvailabilitySettings,
  precreatedBackup: Awaited<ReturnType<typeof backupPrimarySheet>> | null = null,
) {
  const currentWeek = currentMoscowWeekStart();
  const grid = await readGrid(config);
  const layout = discover(grid, users, currentWeek, config.nameAliases);
  const availabilityConfig = normalizeAvailabilityConfig(settings);
  const desiredDayOffsets = Array.from({ length: availabilityConfig.weekCount }, (_, weekIndex) => (
    availabilityConfig.activeDays.map((day) => weekIndex * 7 + day)
  )).flat();
  const desiredSlots = desiredDayOffsets.flatMap((dayOffset) => availabilityConfig.hours.map((hour) => ({
    day: dayOffset % 7,
    dayOffset,
    date: addDays(currentWeek, dayOffset),
    hour,
  })));
  const fixedDayStarts = Array.from({ length: availabilityConfig.weekCount * 7 }, (_, dayOffset) => 3 + dayOffset * 10);
  const fixedDayCapacity = 9;
  const populatedColumnCount = Math.max(0, ...grid.raw.map((row) => row.length));
  const useFixedDayLayout = populatedColumnCount >= 74 && availabilityConfig.hours.length <= fixedDayCapacity;
  const existingSlotColumns = layout.columnHours.map((hour, col) => hour !== null && layout.columnDates[col] ? col : -1).filter((col) => col >= 0);
  if (!existingSlotColumns.length && !useFixedDayLayout) throw new Error(`No availability columns were discovered in ${grid.title}`);
  const firstSlotColumn = useFixedDayLayout ? fixedDayStarts[0] : Math.min(...existingSlotColumns);
  const desiredDates = desiredDayOffsets.map((dayOffset) => addDays(currentWeek, dayOffset));
  const currentSlots = existingSlotColumns.map((col) => ({ col, date: layout.columnDates[col], hour: layout.columnHours[col] }));
  const desiredSlotColumns = useFixedDayLayout
    ? desiredDayOffsets.flatMap((dayOffset) => availabilityConfig.hours.map((hour, hourIndex) => ({
      col: fixedDayStarts[dayOffset] + hourIndex,
      date: addDays(currentWeek, dayOffset),
      hour,
    })))
    : desiredSlots.map((slot, index) => ({ ...slot, col: firstSlotColumn + index }));
  const layoutChanged = currentSlots.length !== desiredSlots.length || desiredSlots.some((slot, index) => (
    currentSlots[index]?.col !== desiredSlotColumns[index]?.col
    || currentSlots[index]?.date !== slot.date
    || currentSlots[index]?.hour !== slot.hour
  ));
  const rotated = currentSlots.some((slot) => !desiredDates.includes(String(slot.date)));
  let backup = precreatedBackup;
  if (layoutChanged) {
    backup ||= await backupPrimarySheet(config, `РЕЗЕРВ ${grid.title}`);
    const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const lastParticipantRow = Math.max(...layout.allRows.map((row) => row.rowIndex)) + 1;
    const oldValues = new Map<string, boolean>();
    for (const row of layout.allRows) for (const col of existingSlotColumns) oldValues.set(`${row.rowIndex}:${layout.columnDates[col]}:${layout.columnHours[col]}`, isSelected(grid.raw[row.rowIndex]?.[col]));
    if (useFixedDayLayout) {
      const metadata = await sheetMetadata(config);
      const sheet = metadata.sheets.find((item) => item.properties.sheetId === grid.sheetId);
      const currentColumnCount = Number(sheet?.properties.gridProperties?.columnCount || 0);
      const requiredColumnCount = fixedDayStarts.at(-1)! + fixedDayCapacity + 1;
      const requests: any[] = [];
      if (currentColumnCount < requiredColumnCount) requests.push({ appendDimension: {
        sheetId: grid.sheetId,
        dimension: 'COLUMNS',
        length: requiredColumnCount - currentColumnCount,
      } });
      requests.push({ unmergeCells: { range: {
        sheetId: grid.sheetId,
        startRowIndex: layout.dateRow,
        endRowIndex: layout.dateRow + 1,
        startColumnIndex: fixedDayStarts[0],
        endColumnIndex: requiredColumnCount,
      } } });
      for (let weekIndex = 1; weekIndex < availabilityConfig.weekCount; weekIndex += 1) {
        requests.push({ copyPaste: {
          source: {
            sheetId: grid.sheetId,
            startRowIndex: 0,
            endRowIndex: lastParticipantRow,
            startColumnIndex: fixedDayStarts[0],
            endColumnIndex: fixedDayStarts[0] + 70,
          },
          destination: {
            sheetId: grid.sheetId,
            startRowIndex: 0,
            endRowIndex: lastParticipantRow,
            startColumnIndex: fixedDayStarts[weekIndex * 7],
            endColumnIndex: fixedDayStarts[weekIndex * 7] + 70,
          },
          pasteType: 'PASTE_FORMAT',
          pasteOrientation: 'NORMAL',
        } });
        requests.push({ copyPaste: {
          source: {
            sheetId: grid.sheetId,
            startRowIndex: 0,
            endRowIndex: lastParticipantRow,
            startColumnIndex: fixedDayStarts[0],
            endColumnIndex: fixedDayStarts[0] + 70,
          },
          destination: {
            sheetId: grid.sheetId,
            startRowIndex: 0,
            endRowIndex: lastParticipantRow,
            startColumnIndex: fixedDayStarts[weekIndex * 7],
            endColumnIndex: fixedDayStarts[weekIndex * 7] + 70,
          },
          pasteType: 'PASTE_FORMULA',
          pasteOrientation: 'NORMAL',
        } });
      }
      for (let dayOffset = 0; dayOffset < availabilityConfig.weekCount * 7; dayOffset += 1) {
        const start = fixedDayStarts[dayOffset];
        const active = availabilityConfig.activeDays.includes(dayOffset % 7);
        requests.push({ updateDimensionProperties: {
          range: { sheetId: grid.sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: start + fixedDayCapacity + 1 },
          properties: { hiddenByUser: !active },
          fields: 'hiddenByUser',
        } });
        if (!active) continue;
        if (availabilityConfig.hours.length > 1) requests.push({ mergeCells: { range: {
          sheetId: grid.sheetId,
          startRowIndex: layout.dateRow,
          endRowIndex: layout.dateRow + 1,
          startColumnIndex: start,
          endColumnIndex: start + availabilityConfig.hours.length,
        }, mergeType: 'MERGE_ALL' } });
        if (availabilityConfig.hours.length < fixedDayCapacity) requests.push({ updateDimensionProperties: {
          range: { sheetId: grid.sheetId, dimension: 'COLUMNS', startIndex: start + availabilityConfig.hours.length, endIndex: start + fixedDayCapacity },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        } });
      }
      try {
        await googleRequest(config, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
      } catch (error: any) {
        const structuralRequests = requests.filter((request) => !request.updateDimensionProperties);
        if (!String(error?.message || error).includes('protected cell or object') || structuralRequests.length === requests.length) throw error;
        await googleRequest(config, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: structuralRequests }) });
      }
      await googleRequest(config, '/values:batchClear', { method: 'POST', body: JSON.stringify({
        ranges: fixedDayStarts.map((start) => `${quotedSheet(grid.title)}!${columnName(start)}${layout.dateRow + 1}:${columnName(start + fixedDayCapacity - 1)}${lastParticipantRow}`),
      }) });
      const data: { range: string; values: unknown[][] }[] = [];
      for (const dayOffset of desiredDayOffsets) {
        const start = fixedDayStarts[dayOffset];
        const date = addDays(currentWeek, dayOffset);
        const [, month, dateDay] = date.split('-');
        data.push({ range: `${quotedSheet(grid.title)}!${columnName(start)}${layout.dateRow + 1}`, values: [[`${dateDay}.${month} ${weekdays[dayOffset % 7]}`]] });
        data.push({ range: `${quotedSheet(grid.title)}!${columnName(start)}${layout.hourRow + 1}`, values: [availabilityConfig.hours.map((hour) => `${String(hour).padStart(2, '0')}:00`)] });
        for (const row of layout.allRows) data.push({
          range: `${quotedSheet(grid.title)}!${columnName(start)}${row.rowIndex + 1}`,
          values: [availabilityConfig.hours.map((hour) => oldValues.get(`${row.rowIndex}:${date}:${hour}`) || false)],
        });
      }
      await googleRequest(config, '/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      });
    } else {
    const lastExistingColumn = Math.max(...existingSlotColumns);
    const lastDesiredColumn = firstSlotColumn + desiredSlots.length - 1;
    const lastColumn = Math.max(lastExistingColumn, lastDesiredColumn);
    const metadata = await sheetMetadata(config);
    const sheet = metadata.sheets.find((item) => item.properties.sheetId === grid.sheetId);
    const currentColumnCount = Number(sheet?.properties.gridProperties?.columnCount || 0);
    const requests: any[] = [];
    if (currentColumnCount <= lastDesiredColumn) requests.push({ appendDimension: { sheetId: grid.sheetId, dimension: 'COLUMNS', length: lastDesiredColumn - currentColumnCount + 1 } });
    requests.push({ unmergeCells: { range: { sheetId: grid.sheetId, startRowIndex: layout.dateRow, endRowIndex: layout.dateRow + 1, startColumnIndex: firstSlotColumn, endColumnIndex: lastColumn + 1 } } });
    requests.push({ copyPaste: {
      source: { sheetId: grid.sheetId, startRowIndex: layout.dateRow, endRowIndex: Math.max(...layout.allRows.map((row) => row.rowIndex)) + 1, startColumnIndex: firstSlotColumn, endColumnIndex: firstSlotColumn + 1 },
      destination: { sheetId: grid.sheetId, startRowIndex: layout.dateRow, endRowIndex: Math.max(...layout.allRows.map((row) => row.rowIndex)) + 1, startColumnIndex: firstSlotColumn, endColumnIndex: lastDesiredColumn + 1 },
      pasteType: 'PASTE_FORMAT', pasteOrientation: 'NORMAL',
    } });
    for (const day of availabilityConfig.activeDays) {
      const dayOffset = availabilityConfig.activeDays.indexOf(day) * availabilityConfig.hours.length;
      if (availabilityConfig.hours.length > 1) requests.push({ mergeCells: { range: { sheetId: grid.sheetId, startRowIndex: layout.dateRow, endRowIndex: layout.dateRow + 1, startColumnIndex: firstSlotColumn + dayOffset, endColumnIndex: firstSlotColumn + dayOffset + availabilityConfig.hours.length }, mergeType: 'MERGE_ALL' } });
    }
    await googleRequest(config, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
    await googleRequest(config, '/values:batchClear', { method: 'POST', body: JSON.stringify({ ranges: [`${quotedSheet(grid.title)}!${columnName(firstSlotColumn)}${layout.dateRow + 1}:${columnName(lastColumn)}${lastParticipantRow}`] }) });
    const hourHeader = desiredSlots.map((slot) => `${String(slot.hour).padStart(2, '0')}:00`);
    const data = [
      ...desiredDayOffsets.map((dayOffset, dayIndex) => {
        const date = addDays(currentWeek, dayOffset);
        const [, month, dateDay] = date.split('-');
        return { range: `${quotedSheet(grid.title)}!${columnName(firstSlotColumn + dayIndex * availabilityConfig.hours.length)}${layout.dateRow + 1}`, values: [[`${dateDay}.${month} ${weekdays[dayOffset % 7]}`]] };
      }),
      { range: `${quotedSheet(grid.title)}!${columnName(firstSlotColumn)}${layout.hourRow + 1}`, values: [hourHeader] },
      ...layout.allRows.map((row) => ({ range: `${quotedSheet(grid.title)}!${columnName(firstSlotColumn)}${row.rowIndex + 1}`, values: [desiredSlots.map((slot) => oldValues.get(`${row.rowIndex}:${slot.date}:${slot.hour}`) || false)] })),
    ];
    await googleRequest(config, '/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
    }
  }
  const refreshedGrid = layoutChanged ? await readGrid(config) : grid;
  const refreshedLayout = layoutChanged ? discover(refreshedGrid, users, currentWeek, config.nameAliases) : layout;
  const checkboxes = await ensurePrimaryCheckboxes(config, refreshedGrid, refreshedLayout);
  const metadata = await sheetMetadata(config);
  const legacySheets = metadata.sheets.filter((sheet) => WEEK_SHEET_RE.test(sheet.properties.title));
  const visibleLegacySheets = legacySheets.filter((sheet) => !sheet.properties.hidden);
  if (visibleLegacySheets.length) {
    await googleRequest(config, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: visibleLegacySheets.map((sheet) => ({ updateSheetProperties: {
        properties: { sheetId: sheet.properties.sheetId, hidden: true },
        fields: 'hidden',
      } })) }),
    });
  }
  const userBindings = await persistTelegramIdBindings(config, users);
  return {
    primary: grid.title,
    primarySheetId: grid.sheetId,
    currentWeek,
    dates: desiredDates,
    rotated,
    layoutChanged,
    activeDays: availabilityConfig.activeDays,
    hours: availabilityConfig.hours,
    backup,
    checkboxes,
    hiddenLegacySheets: visibleLegacySheets.map((sheet) => sheet.properties.title),
    preservedLegacySheets: legacySheets.map((sheet) => sheet.properties.title),
    userBindings,
  };
}

let primaryWeekMaintenance: Promise<Awaited<ReturnType<typeof preparePrimaryWeekSheet>>> | null = null;

export async function ensurePrimaryWeekSheet(config: GoogleSheetsConfig, users: SheetUser[], settings?: AvailabilitySettings) {
  if (!primaryWeekMaintenance) {
    primaryWeekMaintenance = preparePrimaryWeekSheet(config, users, settings).finally(() => {
      primaryWeekMaintenance = null;
    });
  }
  return primaryWeekMaintenance;
}

export async function migratePrimaryWeekSheet(config: GoogleSheetsConfig, users: SheetUser[], settings?: AvailabilitySettings) {
  const backup = await backupPrimarySheet(config);
  return preparePrimaryWeekSheet(config, users, settings, backup);
}

/** Backward-compatible entry point: the horizon remains an app setting, while Sheets uses only ОСНОВА. */
export async function ensureManagedWeekSheets(config: GoogleSheetsConfig, users: SheetUser[], _weekCount: number) {
  return ensurePrimaryWeekSheet(config, users);
}
