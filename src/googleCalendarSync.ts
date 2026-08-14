import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Meeting, SimulationState, User } from './types.js';

export type GoogleCalendarConfig = {
  calendarId: string;
  credentialsFile: string;
  enabled: boolean;
  timeZone: string;
  apiBase: string;
};

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type GoogleCalendarEvent = {
  id?: string;
  htmlLink?: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  transparency: 'opaque';
  extendedProperties: { private: { megabotMeetingId: string } };
};

const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
let tokenCache: { value: string; expiresAt: number; key: string } | null = null;

export function googleCalendarConfigFromEnv(environment: NodeJS.ProcessEnv = process.env): GoogleCalendarConfig | null {
  const calendarId = environment.GOOGLE_CALENDAR_ID?.trim();
  const credentialsFile = environment.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  if (!calendarId || !credentialsFile) return null;
  return {
    calendarId,
    credentialsFile,
    enabled: environment.GOOGLE_CALENDAR_ENABLED?.trim().toLowerCase() === 'true',
    timeZone: environment.GOOGLE_CALENDAR_TIME_ZONE?.trim() || 'Europe/Moscow',
    apiBase: (environment.GOOGLE_CALENDAR_API_BASE?.trim() || 'https://www.googleapis.com/calendar/v3').replace(/\/$/, ''),
  };
}

const base64Url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function loadCredentials(config: Pick<GoogleCalendarConfig, 'credentialsFile'>) {
  const parsed = JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8')) as ServiceAccountCredentials;
  if (!parsed.client_email || !parsed.private_key) throw new Error('Google service account JSON is incomplete');
  return parsed;
}

async function accessToken(config: Pick<GoogleCalendarConfig, 'credentialsFile'>) {
  const credentials = loadCredentials(config);
  const cacheKey = `${credentials.client_email}:${config.credentialsFile}:${GOOGLE_CALENDAR_SCOPE}`;
  if (tokenCache && tokenCache.key === cacheKey && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: GOOGLE_CALENDAR_SCOPE,
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
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(body.error_description || `Google token request failed: ${response.status}`);
  tokenCache = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000, key: cacheKey };
  return tokenCache.value;
}

async function calendarRequest(config: GoogleCalendarConfig, path: string, init: RequestInit = {}, acceptedStatuses: number[] = []) {
  const token = await accessToken(config);
  const response = await fetch(`${config.apiBase}${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new Error(`Google Calendar API ${response.status}: ${JSON.stringify(body)}`);
  }
  return { status: response.status, body };
}

function isoDate(dateValue: string) {
  const short = String(dateValue || '').match(/^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/);
  if (short) {
    const year = short[3].length === 2 ? 2000 + Number(short[3]) : Number(short[3]);
    return `${year}-${short[2]}-${short[1]}`;
  }
  const iso = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  throw new Error(`Unsupported meeting date: ${dateValue}`);
}

function addMinutes(localDateTime: string, minutes: number) {
  const date = new Date(`${localDateTime}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Unsupported meeting date/time: ${localDateTime}`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 19);
}

export function googleCalendarEventId(meetingId: string) {
  return `megabot${crypto.createHash('sha256').update(meetingId).digest('hex').slice(0, 32)}`;
}

const userLabel = (user?: User) => user ? `${user.realName}${user.username ? ` (${user.username})` : ''}` : 'не указан';

export function buildGoogleCalendarEvent(meeting: Meeting, state: Pick<SimulationState, 'users' | 'events'>, timeZone = 'Europe/Moscow'): GoogleCalendarEvent {
  const date = isoDate(meeting.date);
  const time = /^\d{2}:\d{2}$/.test(meeting.time) ? meeting.time : `0${meeting.time}`.slice(-5);
  const startDateTime = `${date}T${time}:00`;
  const duration = Number.isFinite(Number(meeting.duration)) && Number(meeting.duration) > 0 ? Number(meeting.duration) : 1;
  const invitedIds = meeting.participants === 'all' ? state.users.map((user) => user.id) : meeting.participants;
  const invited = invitedIds.map((id) => state.users.find((user) => user.id === id)).filter(Boolean) as User[];
  const workEvent = (state.events || []).find((item) => item.id === meeting.eventId);
  const isSetup = meeting.kind === 'setup';
  const description = [
    isSetup && 'Тип: монтаж площадки',
    isSetup && `Мероприятие: ${workEvent?.name || 'не указано'}`,
    meeting.description && `Описание: ${meeting.description}`,
    meeting.topic && `Повестка: ${meeting.topic}`,
    meeting.competency && `Направление: ${meeting.competency}`,
    `Формат: ${isSetup ? 'монтаж, приглашена вся команда' : meeting.type === 'general' ? 'общее собрание' : 'выбранные участники'}`,
    `Организатор: ${userLabel(state.users.find((user) => user.id === meeting.hostId))}`,
    `Участники: ${meeting.participants === 'all' ? 'вся команда' : invited.map(userLabel).join(', ') || 'не указаны'}`,
    `MegaBot ID: ${meeting.id}`,
  ].filter(Boolean).join('\n');
  return {
    summary: meeting.title,
    description,
    start: { dateTime: startDateTime, timeZone },
    end: { dateTime: addMinutes(startDateTime, Math.round(duration * 60)), timeZone },
    transparency: 'opaque',
    extendedProperties: { private: { megabotMeetingId: meeting.id } },
  };
}

export async function checkGoogleCalendarAccess(config: GoogleCalendarConfig) {
  const result = await calendarRequest(config, `/calendars/${encodeURIComponent(config.calendarId)}?fields=id%2Csummary%2CtimeZone`);
  return result.body;
}

export async function syncMeetingToGoogleCalendar(config: GoogleCalendarConfig, meeting: Meeting, state: Pick<SimulationState, 'users' | 'events'>) {
  if (!config.enabled) return { skipped: true as const };
  let eventId = meeting.googleCalendarEventId || googleCalendarEventId(meeting.id);
  let eventPath = `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`;
  if (meeting.status === 'cancelled') {
    await calendarRequest(config, eventPath, { method: 'DELETE' }, [404, 410]);
    return { deleted: true as const, eventId };
  }
  const event = buildGoogleCalendarEvent(meeting, state, config.timeZone);
  const patched = await calendarRequest(config, eventPath, { method: 'PATCH', body: JSON.stringify(event) }, [404, 410]);
  if (patched.status !== 404 && patched.status !== 410) return { created: false as const, eventId, event: patched.body };
  // Google keeps a tombstone for deleted event IDs and returns 410 forever.
  // Generate a fresh deterministic-format ID so a manually deleted meeting can
  // be recreated and the replacement ID persisted back to the database.
  if (patched.status === 410) {
    eventId = googleCalendarEventId(`${meeting.id}:${crypto.randomUUID()}`);
    eventPath = `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`;
  }
  const inserted = await calendarRequest(config, `/calendars/${encodeURIComponent(config.calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify({ ...event, id: eventId }),
  }, [409]);
  if (inserted.status === 409) {
    const retried = await calendarRequest(config, eventPath, { method: 'PATCH', body: JSON.stringify(event) });
    return { created: false as const, eventId, event: retried.body };
  }
  return { created: true as const, eventId, event: inserted.body };
}

export async function reconcileGoogleCalendar(config: GoogleCalendarConfig, state: SimulationState) {
  const result = { passed: true, created: 0, updated: 0, deleted: 0, failed: [] as { meetingId: string; error: string }[] };
  for (const meeting of state.meetings) {
    try {
      const synced = await syncMeetingToGoogleCalendar(config, meeting, state);
      if ('skipped' in synced) continue;
      meeting.googleCalendarEventId = synced.eventId;
      if ('deleted' in synced) result.deleted += 1;
      else if (synced.created) result.created += 1;
      else result.updated += 1;
    } catch (error) {
      result.passed = false;
      result.failed.push({ meetingId: meeting.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
