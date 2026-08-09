import { SimulationState, Task, WorkEvent } from './types.js';
import { googleSheetsApiRequest } from './googleSheetsSync.js';

export type GoogleSheetsDatabaseConfig = {
  spreadsheetId: string;
  credentialsFile: string;
  enabled: boolean;
};

type SchemaSheet = { title: string; headers: string[] };

export const DATABASE_SCHEMA_VERSION = 5;

const SCHEMA: SchemaSheet[] = [
  { title: 'meta', headers: ['key', 'value'] },
  { title: 'snapshot', headers: ['chunk_index', 'data'] },
  { title: 'events', headers: ['id', 'name', 'description', 'starts_at', 'ends_at', 'status', 'created_at', 'created_by'] },
  { title: 'users', headers: ['id', 'telegram_id', 'username', 'real_name', 'role', 'registered', 'birthday', 'competencies_json', 'primary_competency', 'faculty_id', 'joined_at', 'last_seen_at', 'avatar_seed'] },
  { title: 'user_avatars', headers: ['user_id', 'chunk_index', 'data'] },
  { title: 'faculties', headers: ['id', 'name'] },
  { title: 'availability_weeks', headers: ['user_id', 'week_start', 'updated_at', 'hard_unavailable_days_json'] },
  { title: 'availability_slots', headers: ['user_id', 'week_start', 'day_index', 'hour'] },
  { title: 'meetings', headers: ['id', 'title', 'type', 'date', 'time', 'duration_hours', 'host_id', 'participants_all', 'competency', 'topic', 'description', 'status', 'google_calendar_event_id'] },
  { title: 'meeting_participants', headers: ['meeting_id', 'user_id', 'kind'] },
  { title: 'tasks', headers: ['id', 'event_id', 'faculty_id', 'title', 'description', 'deadline', 'creator_id', 'competency', 'competencies_json', 'sow', 'status', 'priority', 'created_at', 'completed_at', 'time_spent_minutes', 'tips_json', 'cancelled_at', 'cancelled_by'] },
  { title: 'task_assignees', headers: ['task_id', 'user_id'] },
  { title: 'task_comments', headers: ['task_id', 'user_id', 'executor_comment', 'coordinator_comment', 'completion_comment', 'updated_at', 'history_json'] },
  { title: 'task_reminders', headers: ['task_id', 'id', 'type', 'value', 'unit', 'sent_at', 'last_sent_at'] },
  { title: 'task_log', headers: ['Мероприятие', 'Блоки', 'Задача', 'Описание', 'ТЗ', 'Статус', 'Приоритет', 'Автор', 'Исполнители', 'Назначена', 'Дедлайн', 'Выполнена', 'Затрачено, мин', 'Комментарии исполнителей', 'Комментарии координатора', 'Комментарии при завершении', 'Напоминания', 'ID'] },
  { title: 'bot_messages', headers: ['owner_user_id', 'id', 'sender', 'text', 'timestamp', 'buttons_json'] },
  { title: 'settings', headers: ['key', 'value_json'] },
  { title: 'audit_log', headers: ['timestamp', 'revision', 'action', 'details'] },
];

const DATA_SHEETS = SCHEMA.filter((sheet) => !['meta', 'audit_log'].includes(sheet.title));

export function googleSheetsDatabaseConfigFromEnv(): GoogleSheetsDatabaseConfig | null {
  const spreadsheetId = process.env.GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID?.trim();
  const credentialsFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  if (!spreadsheetId || !credentialsFile) return null;
  return {
    spreadsheetId,
    credentialsFile,
    enabled: process.env.GOOGLE_SHEETS_DATABASE_ENABLED?.trim().toLowerCase() === 'true',
  };
}

const quoteSheet = (title: string) => `'${title.replace(/'/g, "''")}'`;
const columnName = (index: number) => {
  let value = index + 1;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
};
const json = (value: unknown) => JSON.stringify(value ?? null);
const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    if (value === undefined || value === null || value === '') return fallback;
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
const bool = (value: unknown) => value === true || String(value).toLowerCase() === 'true';
const numberOrUndefined = (value: unknown) => {
  const parsed = Number(value);
  return value !== '' && value !== undefined && Number.isFinite(parsed) ? parsed : undefined;
};

const humanDateTime = (value: unknown) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(date);
};

export function encodeGoogleSheetsDatabaseSnapshot(state: SimulationState, chunkSize = 40_000) {
  const serializedState = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  const rows: unknown[][] = [];
  for (let offset = 0, index = 0; offset < serializedState.length; offset += chunkSize, index += 1) {
    rows.push([index, serializedState.slice(offset, offset + chunkSize)]);
  }
  return rows;
}

export function decodeGoogleSheetsDatabaseSnapshot(rows: Record<string, unknown>[]) {
  const snapshotText = rows
    .sort((left, right) => Number(left.chunk_index) - Number(right.chunk_index))
    .map((row) => String(row.data || ''))
    .join('');
  return snapshotText ? JSON.parse(Buffer.from(snapshotText, 'base64').toString('utf8')) as SimulationState : null;
}

async function metadata(config: GoogleSheetsDatabaseConfig) {
  return googleSheetsApiRequest(config, '?fields=sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))') as Promise<{
    sheets?: { properties: { sheetId: number; title: string; index: number; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
  }>;
}

export async function initializeGoogleSheetsDatabase(config: GoogleSheetsDatabaseConfig) {
  const initial = await metadata(config);
  const existing = new Map((initial.sheets || []).map((sheet) => [sheet.properties.title, sheet.properties]));
  const requests: any[] = [];

  if ((initial.sheets || []).length === 1 && !SCHEMA.some((sheet) => sheet.title === initial.sheets![0].properties.title)) {
    const source = initial.sheets![0].properties;
    const a1 = await googleSheetsApiRequest(config, `/values/${encodeURIComponent(`${quoteSheet(source.title)}!A1`)}?majorDimension=ROWS`) as { values?: unknown[][] };
    if (!a1.values?.flat().some((value) => String(value || '').trim())) {
      requests.push({ updateSheetProperties: { properties: { sheetId: source.sheetId, title: 'meta' }, fields: 'title' } });
      existing.delete(source.title);
      existing.set('meta', { ...source, title: 'meta' });
    }
  }

  for (const sheet of SCHEMA) {
    if (!existing.has(sheet.title)) {
      requests.push({ addSheet: { properties: { title: sheet.title, gridProperties: { rowCount: 1000, columnCount: Math.max(8, sheet.headers.length), frozenRowCount: 1 } } } });
    }
  }
  if (requests.length) {
    await googleSheetsApiRequest(config, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  }

  const ready = await metadata(config);
  const properties = new Map((ready.sheets || []).map((sheet) => [sheet.properties.title, sheet.properties]));
  const formatRequests: any[] = [];
  const data: { range: string; values: unknown[][] }[] = [];
  for (const sheet of SCHEMA) {
    const property = properties.get(sheet.title);
    if (!property) throw new Error(`Database sheet was not created: ${sheet.title}`);
    const lastColumn = columnName(sheet.headers.length - 1);
    data.push({ range: `${quoteSheet(sheet.title)}!A1:${lastColumn}1`, values: [sheet.headers] });
    formatRequests.push(
      { updateSheetProperties: { properties: { sheetId: property.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId: property.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: sheet.headers.length }, cell: { userEnteredFormat: { backgroundColor: { red: 0, green: 0.4118, blue: 0.8784 }, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat' } },
      { updateDimensionProperties: { range: { sheetId: property.sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 36 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId: property.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: sheet.headers.length }, properties: { pixelSize: 150 }, fields: 'pixelSize' } },
    );
    if (sheet.title === 'task_log') {
      formatRequests.push(
        { setBasicFilter: { filter: { range: { sheetId: property.sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: sheet.headers.length } } } },
        { repeatCell: { range: { sheetId: property.sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: sheet.headers.length }, cell: { userEnteredFormat: { verticalAlignment: 'TOP', wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy' } },
        { updateDimensionProperties: { range: { sheetId: property.sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 5 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId: property.sheetId, dimension: 'COLUMNS', startIndex: 13, endIndex: 17 }, properties: { pixelSize: 240 }, fields: 'pixelSize' } },
      );
    }
  }
  await googleSheetsApiRequest(config, '/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  await googleSheetsApiRequest(config, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: formatRequests }) });
  return { spreadsheetId: config.spreadsheetId, sheets: SCHEMA.map((sheet) => sheet.title), created: requests.length > 0 };
}

function stateRows(state: SimulationState) {
  const snapshotRows = encodeGoogleSheetsDatabaseSnapshot(state);
  const eventRows = (state.events || []).map((item) => [item.id, item.name, item.description || '', item.startsAt || '', item.endsAt || '', item.status, item.createdAt, item.createdBy || '']);
  const userRows = state.users.map((user) => [user.id, user.telegramId || '', user.username, user.realName, user.role, Boolean(user.registered), user.birthday || '', json(user.competencies || []), user.primaryCompetency || '', user.facultyId || '', user.joinedAt || '', user.lastSeenAt || '', user.avatarSeed]);
  const userAvatarRows = state.users.flatMap((user) => {
    const data = user.avatarDataUrl || '';
    const rows: unknown[][] = [];
    for (let offset = 0, index = 0; offset < data.length; offset += 30_000, index += 1) rows.push([user.id, index, data.slice(offset, offset + 30_000)]);
    return rows;
  });
  const facultyRows = (state.faculties || []).map((faculty) => [faculty.id, faculty.name]);
  const availabilityWeekRows: unknown[][] = [];
  const availabilitySlotRows: unknown[][] = [];
  Object.values(state.availabilities || {}).forEach((availability) => {
    availabilityWeekRows.push([availability.userId, availability.weekStart || '', availability.updatedAt || '', json(availability.hardUnavailableDays || [])]);
    Object.entries(availability.slots || {}).forEach(([dayIndex, hours]) => {
      hours.forEach((hour) => availabilitySlotRows.push([availability.userId, availability.weekStart || '', Number(dayIndex), Number(hour)]));
    });
  });
  const meetingRows: unknown[][] = [];
  const meetingParticipantRows: unknown[][] = [];
  state.meetings.forEach((meeting) => {
    meetingRows.push([meeting.id, meeting.title, meeting.type, meeting.date, meeting.time, meeting.duration || 1, meeting.hostId, meeting.participants === 'all', meeting.competency || '', meeting.topic || '', meeting.description || '', meeting.status, meeting.googleCalendarEventId || '']);
    if (Array.isArray(meeting.participants)) meeting.participants.forEach((userId) => meetingParticipantRows.push([meeting.id, userId, 'invited']));
    (meeting.attendeeIds || []).forEach((userId) => meetingParticipantRows.push([meeting.id, userId, 'attending']));
  });
  const taskRows: unknown[][] = [];
  const assigneeRows: unknown[][] = [];
  const commentRows: unknown[][] = [];
  const reminderRows: unknown[][] = [];
  state.tasks.forEach((task) => {
    taskRows.push([task.id, task.eventId || '', task.facultyId || '', task.title, task.description, task.deadline, task.creatorId || '', task.competency || '', json(task.competencies || (task.competency ? [task.competency] : [])), task.sow || '', task.status, task.priority, task.createdAt || '', task.completedAt || '', task.timeSpentMinutes || '', json(task.tips || []), task.cancelledAt || '', task.cancelledBy || '']);
    const assignees = task.assignedTo || [];
    assignees.forEach((userId) => assigneeRows.push([task.id, userId]));
    const commentUserIds = new Set([...Object.keys(task.assigneeNotes || {}), ...Object.keys(task.completionComments || {})]);
    commentUserIds.forEach((userId) => {
      const note = task.assigneeNotes?.[userId];
      commentRows.push([task.id, userId, note?.executor || '', note?.coordinator || '', task.completionComments?.[userId] || '', note?.updatedAt || '', json(note?.history || [])]);
    });
    (task.reminders || []).forEach((reminder) => reminderRows.push([task.id, reminder.id, reminder.type, reminder.value, reminder.unit, reminder.sentAt || '', reminder.lastSentAt || '']));
  });
  const taskLogRows = state.tasks
    .slice()
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
    .map((task) => {
      const event = (state.events || []).find((item) => item.id === task.eventId);
      const creator = state.users.find((user) => user.id === task.creatorId);
      const assignees = (task.assignedTo || []).map((id) => state.users.find((user) => user.id === id)?.realName || id);
      const history = Object.values(task.assigneeNotes || {}).flatMap((note) => note.history || []);
      const commentsBySide = (side: 'executor' | 'coordinator') => history
        .filter((comment) => comment.side === side)
        .map((comment) => `${humanDateTime(comment.createdAt)} · ${state.users.find((user) => user.id === comment.authorId)?.realName || comment.authorId}: ${comment.text}`)
        .join('\n');
      const executorComments = commentsBySide('executor') || Object.entries(task.assigneeNotes || {}).filter(([, note]) => note.executor).map(([id, note]) => `${state.users.find((user) => user.id === id)?.realName || id}: ${note.executor}`).join('\n');
      const coordinatorComments = commentsBySide('coordinator') || Object.entries(task.assigneeNotes || {}).filter(([, note]) => note.coordinator).map(([id, note]) => `${state.users.find((user) => user.id === id)?.realName || id}: ${note.coordinator}`).join('\n');
      const completionComments = Object.entries(task.completionComments || {}).map(([id, comment]) => `${state.users.find((user) => user.id === id)?.realName || id}: ${comment}`).join('\n');
      const reminders = (task.reminders || []).map((reminder) => `${reminder.type === 'repeat' ? 'каждые' : 'за'} ${reminder.value} ${reminder.unit === 'hours' ? 'ч' : 'дн'}`).join(', ');
      return [
        event?.name || 'Без мероприятия', (task.competencies || (task.competency ? [task.competency] : [])).join(', ') || 'Без блока', task.title, task.description, task.sow || '',
        task.status === 'completed' ? 'Выполнено' : task.status === 'cancelled' ? 'Отменена' : task.status === 'open' ? 'Открытая' : 'В работе',
        task.priority === 'critical' ? 'Очень важная' : task.priority === 'important' ? 'Важная' : 'Обычная',
        creator?.realName || 'Не указан', assignees.join(', ') || 'Не назначены', humanDateTime(task.createdAt), task.deadline || '', humanDateTime(task.completedAt),
        task.timeSpentMinutes || '', executorComments, coordinatorComments, completionComments, reminders, task.id,
      ];
    });
  const messageRows: unknown[][] = [];
  Object.entries(state.messages || {}).forEach(([ownerUserId, messages]) => messages.forEach((message) => messageRows.push([ownerUserId, message.id, message.sender, message.text, message.timestamp, json(message.buttons || [])])));
  const settingRows = [
    ['settings', json(state.settings || {})],
    ['competencies', json(state.competencies || [])],
    ['facultyCompetencies', json(state.facultyCompetencies || [])],
  ];
  return new Map<string, unknown[][]>([
    ['snapshot', snapshotRows], ['events', eventRows], ['users', userRows], ['user_avatars', userAvatarRows], ['faculties', facultyRows], ['availability_weeks', availabilityWeekRows],
    ['availability_slots', availabilitySlotRows], ['meetings', meetingRows], ['meeting_participants', meetingParticipantRows],
    ['tasks', taskRows], ['task_assignees', assigneeRows], ['task_comments', commentRows], ['task_reminders', reminderRows], ['task_log', taskLogRows],
    ['bot_messages', messageRows], ['settings', settingRows],
  ]);
}

export async function exportStateToGoogleSheetsDatabase(config: GoogleSheetsDatabaseConfig, state: SimulationState, action = 'snapshot') {
  await initializeGoogleSheetsDatabase(config);
  const revision = Number(state.settings?.databaseRevision || 0);
  const rows = stateRows(state);
  await googleSheetsApiRequest(config, '/values:batchUpdate', { method: 'POST', body: JSON.stringify({
    valueInputOption: 'RAW',
    data: [{ range: `${quoteSheet('meta')}!A1:B7`, values: [
      ['key', 'value'],
      ['schema_version', DATABASE_SCHEMA_VERSION],
      ['data_present', true],
      ['revision', revision],
      ['synced_at', new Date().toISOString()],
      ['source', 'megabot'],
      ['sync_state', 'writing'],
    ] }],
  }) });
  const clearRanges = DATA_SHEETS.map((sheet) => `${quoteSheet(sheet.title)}!A2:Z`);
  await googleSheetsApiRequest(config, '/values:batchClear', { method: 'POST', body: JSON.stringify({ ranges: clearRanges }) });
  const data: { range: string; values: unknown[][] }[] = [];
  for (const sheet of DATA_SHEETS) {
    const values = rows.get(sheet.title) || [];
    if (values.length) data.push({ range: `${quoteSheet(sheet.title)}!A2`, values });
  }
  data.push({ range: `${quoteSheet('meta')}!A1:B7`, values: [
    ['key', 'value'],
    ['schema_version', DATABASE_SCHEMA_VERSION],
    ['data_present', true],
    ['revision', revision],
    ['synced_at', new Date().toISOString()],
    ['source', 'megabot'],
    ['sync_state', 'ready'],
  ] });
  await googleSheetsApiRequest(config, '/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });
  await googleSheetsApiRequest(config, `/values/${encodeURIComponent(`${quoteSheet('audit_log')}!A:D`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: [[new Date().toISOString(), revision, action, `tasks=${state.tasks.length};users=${state.users.length};events=${state.events?.length || 0}`]] }),
  });
  return { revision, counts: { users: state.users.length, events: state.events?.length || 0, meetings: state.meetings.length, tasks: state.tasks.length } };
}

export async function clearGoogleSheetsDatabaseAuditLog(config: GoogleSheetsDatabaseConfig) {
  await googleSheetsApiRequest(config, '/values:batchClear', {
    method: 'POST',
    body: JSON.stringify({ ranges: [`${quoteSheet('audit_log')}!A2:D`] }),
  });
}

function objects(values: unknown[][] | undefined) {
  if (!values?.length) return [] as Record<string, unknown>[];
  const headers = values[0].map(String);
  return values.slice(1).filter((row) => row.some((value) => value !== '' && value !== undefined)).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

export async function importStateFromGoogleSheetsDatabase(config: GoogleSheetsDatabaseConfig) {
  await initializeGoogleSheetsDatabase(config);
  const ranges = SCHEMA.filter((sheet) => sheet.title !== 'audit_log').map((sheet) => `${quoteSheet(sheet.title)}!A:Z`);
  const response = await googleSheetsApiRequest(config, `/values:batchGet?majorDimension=ROWS&${ranges.map((range) => `ranges=${encodeURIComponent(range)}`).join('&')}`) as { valueRanges?: { range: string; values?: unknown[][] }[] };
  const valuesByTitle = new Map<string, unknown[][]>();
  (response.valueRanges || []).forEach((valueRange, index) => valuesByTitle.set(SCHEMA.filter((sheet) => sheet.title !== 'audit_log')[index].title, valueRange.values || []));
  const metaRows = objects(valuesByTitle.get('meta'));
  const meta = Object.fromEntries(metaRows.map((row) => [String(row.key), row.value]));
  if (!bool(meta.data_present)) return { initialized: false, revision: 0, state: null, counts: null };
  if (String(meta.sync_state || '') !== 'ready') return { initialized: false, revision: Number(meta.revision || 0), state: null, counts: null };
  if (![1, 2, 3, 4, DATABASE_SCHEMA_VERSION].includes(Number(meta.schema_version))) throw new Error(`Unsupported Google Sheets database schema: ${meta.schema_version}`);

  const snapshotState = decodeGoogleSheetsDatabaseSnapshot(objects(valuesByTitle.get('snapshot')));
  if (snapshotState) {
    const state = snapshotState;
    state.settings ||= {};
    state.settings.databaseRevision = Number(meta.revision || 0);
    return {
      initialized: true,
      revision: Number(meta.revision || 0),
      state,
      counts: { users: state.users?.length || 0, events: state.events?.length || 0, meetings: state.meetings?.length || 0, tasks: state.tasks?.length || 0 },
    };
  }

  const avatarChunks = objects(valuesByTitle.get('user_avatars'));
  const avatarByUser = new Map<string, string>();
  [...new Set(avatarChunks.map((row) => String(row.user_id)))].forEach((userId) => {
    avatarByUser.set(userId, avatarChunks.filter((row) => String(row.user_id) === userId).sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index)).map((row) => String(row.data || '')).join(''));
  });
  const users = objects(valuesByTitle.get('users')).map((row) => ({
    id: String(row.id), telegramId: String(row.telegram_id || '') || undefined, username: String(row.username || ''), realName: String(row.real_name || ''),
    role: String(row.role || 'organizer') as any, registered: bool(row.registered), birthday: String(row.birthday || '') || undefined,
    competencies: parseJson<string[]>(row.competencies_json, []), primaryCompetency: String(row.primary_competency || ''), facultyId: String(row.faculty_id || ''),
    joinedAt: String(row.joined_at || ''), lastSeenAt: String(row.last_seen_at || ''), avatarSeed: String(row.avatar_seed || row.id), avatarDataUrl: avatarByUser.get(String(row.id)) || undefined,
  }));
  const events = objects(valuesByTitle.get('events')).map((row) => ({
    id: String(row.id), name: String(row.name), description: String(row.description || ''), startsAt: String(row.starts_at || ''), endsAt: String(row.ends_at || ''),
    status: String(row.status) as WorkEvent['status'], createdAt: String(row.created_at || ''), createdBy: String(row.created_by || ''),
  }));
  const faculties = objects(valuesByTitle.get('faculties')).map((row) => ({ id: String(row.id), name: String(row.name) }));
  const availabilities: SimulationState['availabilities'] = {};
  objects(valuesByTitle.get('availability_weeks')).forEach((row) => {
    availabilities[String(row.user_id)] = { userId: String(row.user_id), weekStart: String(row.week_start || ''), updatedAt: String(row.updated_at || ''), hardUnavailableDays: parseJson<number[]>(row.hard_unavailable_days_json, []), slots: {} };
  });
  objects(valuesByTitle.get('availability_slots')).forEach((row) => {
    const availability = availabilities[String(row.user_id)] || { userId: String(row.user_id), weekStart: String(row.week_start || ''), updatedAt: '', hardUnavailableDays: [], slots: {} };
    const dayIndex = Number(row.day_index);
    if (!availability.slots[dayIndex]) availability.slots[dayIndex] = [];
    availability.slots[dayIndex].push(Number(row.hour));
    availabilities[availability.userId] = availability;
  });
  const participantRows = objects(valuesByTitle.get('meeting_participants'));
  const meetings = objects(valuesByTitle.get('meetings')).map((row) => ({
    id: String(row.id), title: String(row.title), type: String(row.type) as any, date: String(row.date), time: String(row.time), duration: Number(row.duration_hours || 1), hostId: String(row.host_id),
    participants: bool(row.participants_all) ? 'all' as const : participantRows.filter((item) => item.meeting_id === row.id && item.kind === 'invited').map((item) => String(item.user_id)),
    attendeeIds: participantRows.filter((item) => item.meeting_id === row.id && item.kind === 'attending').map((item) => String(item.user_id)),
    competency: String(row.competency || ''), topic: String(row.topic || ''), description: String(row.description || ''), status: String(row.status) as any,
    googleCalendarEventId: String(row.google_calendar_event_id || '') || undefined,
  }));
  const assignees = objects(valuesByTitle.get('task_assignees'));
  const comments = objects(valuesByTitle.get('task_comments'));
  const reminders = objects(valuesByTitle.get('task_reminders'));
  const tasks = objects(valuesByTitle.get('tasks')).map((row) => {
    const taskComments = comments.filter((item) => item.task_id === row.id);
    const assignedTo = assignees.filter((item) => item.task_id === row.id).map((item) => String(item.user_id));
    return {
      id: String(row.id), eventId: String(row.event_id || ''), facultyId: String(row.faculty_id || ''), title: String(row.title), description: String(row.description || ''), deadline: String(row.deadline || ''),
      creatorId: String(row.creator_id || ''), competency: String(row.competency || ''), competencies: parseJson<string[]>(row.competencies_json, String(row.competency || '') ? [String(row.competency)] : []), sow: String(row.sow || ''), status: String(row.status) as Task['status'], priority: String(row.priority) as Task['priority'],
      createdAt: String(row.created_at || ''), completedAt: String(row.completed_at || ''), cancelledAt: String(row.cancelled_at || '') || undefined, cancelledBy: String(row.cancelled_by || '') || undefined, timeSpentMinutes: numberOrUndefined(row.time_spent_minutes), tips: parseJson<string[]>(row.tips_json, []),
      assignedTo: assignedTo.length ? assignedTo : null,
      assigneeNotes: Object.fromEntries(taskComments.map((item) => [String(item.user_id), { executor: String(item.executor_comment || ''), coordinator: String(item.coordinator_comment || ''), updatedAt: String(item.updated_at || ''), history: parseJson(item.history_json, []) }])),
      completionComments: Object.fromEntries(taskComments.filter((item) => String(item.completion_comment || '')).map((item) => [String(item.user_id), String(item.completion_comment)])),
      reminders: reminders.filter((item) => item.task_id === row.id).map((item) => ({ id: String(item.id), type: String(item.type) as any, value: Number(item.value), unit: String(item.unit) as any, sentAt: String(item.sent_at || '') || undefined, lastSentAt: String(item.last_sent_at || '') || undefined })),
    } as Task;
  });
  const messages: SimulationState['messages'] = {};
  objects(valuesByTitle.get('bot_messages')).forEach((row) => {
    const owner = String(row.owner_user_id);
    if (!messages[owner]) messages[owner] = [];
    messages[owner].push({ id: String(row.id), userId: owner, sender: String(row.sender) as any, text: String(row.text || ''), timestamp: String(row.timestamp || ''), buttons: parseJson<any[]>(row.buttons_json, []) });
  });
  const settingRows = Object.fromEntries(objects(valuesByTitle.get('settings')).map((row) => [String(row.key), parseJson(row.value_json, null)]));
  const state: SimulationState = {
    users, faculties, facultyCompetencies: (settingRows.facultyCompetencies as string[]) || [], competencies: (settingRows.competencies as string[]) || [],
    availabilities, meetings, events, tasks, messages, settings: { ...((settingRows.settings as SimulationState['settings']) || {}), databaseRevision: Number(meta.revision || 0) },
  };
  return { initialized: true, revision: Number(meta.revision || 0), state, counts: { users: users.length, events: events.length, meetings: meetings.length, tasks: tasks.length } };
}

export async function googleSheetsDatabaseSheetUrl(config: GoogleSheetsDatabaseConfig, title: string) {
  const sheets = await metadata(config);
  const sheet = sheets.sheets?.find((item) => item.properties.title === title);
  if (!sheet) throw new Error(`Google Sheets database sheet not found: ${title}`);
  return `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit#gid=${sheet.properties.sheetId}`;
}

export function compareDatabaseStateCounts(left: SimulationState, right: SimulationState) {
  const counts = (state: SimulationState) => ({
    users: state.users.length,
    events: state.events?.length || 0,
    meetings: state.meetings.length,
    meetingParticipants: state.meetings.reduce((sum, meeting) => sum + (Array.isArray(meeting.participants) ? meeting.participants.length : 0) + (meeting.attendeeIds?.length || 0), 0),
    tasks: state.tasks.length,
    taskAssignees: state.tasks.reduce((sum, task) => sum + (task.assignedTo?.length || 0), 0),
    taskComments: state.tasks.reduce((sum, task) => sum + new Set([...Object.keys(task.assigneeNotes || {}), ...Object.keys(task.completionComments || {})]).size, 0),
    taskReminders: state.tasks.reduce((sum, task) => sum + (task.reminders?.length || 0), 0),
    availabilities: Object.keys(state.availabilities || {}).length,
    availabilitySlots: Object.values(state.availabilities || {}).reduce((sum, availability) => sum + Object.values(availability.slots || {}).reduce((slotSum, hours) => slotSum + hours.length, 0), 0),
    messages: Object.values(state.messages || {}).reduce((sum, items) => sum + items.length, 0),
  });
  const source = counts(left);
  const destination = counts(right);
  return { passed: Object.keys(source).every((key) => source[key as keyof typeof source] === destination[key as keyof typeof destination]), source, destination };
}
