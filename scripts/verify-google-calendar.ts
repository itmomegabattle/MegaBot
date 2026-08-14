import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  buildGoogleCalendarEvent,
  checkGoogleCalendarAccess,
  googleCalendarEventId,
  syncMeetingToGoogleCalendar,
  type GoogleCalendarConfig,
} from '../src/googleCalendarSync.js';
import type { Meeting, SimulationState } from '../src/types.js';

const state = {
  users: [
    { id: 'u1', realName: 'Никита', username: '@nikita' },
    { id: 'u2', realName: 'Анна', username: '@anna' },
  ],
  events: [{ id: 'event-1', name: 'Фестиваль', status: 'active', createdAt: '2026-08-01T00:00:00.000Z' }],
} as Pick<SimulationState, 'users' | 'events'>;
const meeting: Meeting = {
  id: 'm_test_1', title: 'Планёрка', type: 'custom', date: '06.08.26', time: '17:30', duration: 0,
  hostId: 'u1', participants: ['u2'], attendeeIds: ['u1'], competency: 'Продакшн', topic: 'Дедлайны',
  description: 'Сверяем готовность', status: 'scheduled',
};
const event = buildGoogleCalendarEvent(meeting, state);
assert.equal(event.summary, 'Планёрка');
assert.equal(event.start.dateTime, '2026-08-06T17:30:00');
assert.equal(event.end.dateTime, '2026-08-06T18:30:00', 'missing or invalid duration must default to one hour');
assert.match(event.description, /Описание: Сверяем готовность/);
assert.match(event.description, /Повестка: Дедлайны/);
assert.match(event.description, /Организатор: Никита/);
assert.match(event.description, /Участники: Анна/);
assert.match(googleCalendarEventId(meeting.id), /^[a-v0-9]{5,1024}$/);

const setupEvent = buildGoogleCalendarEvent({
  ...meeting,
  id: 'm_setup_1',
  kind: 'setup',
  eventId: 'event-1',
  title: 'Монтаж сцены',
  participants: 'all',
  description: '',
  topic: '',
  competency: '',
}, state);
assert.equal(setupEvent.summary, 'Монтаж сцены');
assert.match(setupEvent.description, /Тип: монтаж площадки/);
assert.match(setupEvent.description, /Мероприятие: Фестиваль/);
assert.match(setupEvent.description, /Формат: монтаж, приглашена вся команда/);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'megabot-calendar-'));
const credentialsFile = path.join(tempRoot, 'service-account.json');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const requests: { method?: string; url?: string; body: any }[] = [];
const storedEvents = new Set<string>();
const deletedEvents = new Set<string>();
const server = http.createServer(async (request, response) => {
  let rawBody = '';
  for await (const chunk of request) rawBody += chunk;
  const body = rawBody && request.headers['content-type']?.includes('json') ? JSON.parse(rawBody) : rawBody;
  requests.push({ method: request.method, url: request.url, body });
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/token') return response.end(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }));
  assert.equal(request.headers.authorization, 'Bearer test-token');
  if (request.method === 'GET' && request.url?.startsWith('/calendar/v3/calendars/')) {
    return response.end(JSON.stringify({ id: 'team@group.calendar.google.com', summary: 'Команда', timeZone: 'Europe/Moscow' }));
  }
  const eventId = request.url?.split('/events/')[1];
  if (request.method === 'PATCH' && eventId) {
    if (deletedEvents.has(eventId)) {
      response.statusCode = 410;
      return response.end(JSON.stringify({ error: { message: 'Resource has been deleted' } }));
    }
    if (!storedEvents.has(eventId)) {
      response.statusCode = 404;
      return response.end(JSON.stringify({ error: { message: 'Not found' } }));
    }
    return response.end(JSON.stringify({ id: eventId }));
  }
  if (request.method === 'POST' && request.url?.endsWith('/events')) {
    storedEvents.add(body.id);
    return response.end(JSON.stringify({ id: body.id, htmlLink: 'https://calendar.google.com/event' }));
  }
  if (request.method === 'DELETE' && eventId) {
    storedEvents.delete(eventId);
    deletedEvents.add(eventId);
    response.statusCode = 204;
    return response.end();
  }
  response.statusCode = 500;
  return response.end(JSON.stringify({ error: 'Unexpected request' }));
});

try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake Calendar server did not start');
  await writeFile(credentialsFile, JSON.stringify({
    client_email: 'calendar-test@example.invalid',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: `http://127.0.0.1:${address.port}/token`,
  }), 'utf8');
  const config: GoogleCalendarConfig = {
    calendarId: 'team@group.calendar.google.com', credentialsFile, enabled: true, timeZone: 'Europe/Moscow',
    apiBase: `http://127.0.0.1:${address.port}/calendar/v3`,
  };
  const calendar = await checkGoogleCalendarAccess(config);
  assert.equal(calendar.summary, 'Команда');
  const created = await syncMeetingToGoogleCalendar(config, meeting, state);
  assert.equal('created' in created && created.created, true);
  const createdRequest = requests.find((request) => request.method === 'POST' && request.url?.endsWith('/events'));
  assert.ok(createdRequest);
  assert.doesNotMatch(String(createdRequest.body.description || ''), /Подтвердили участие/);
  const updated = await syncMeetingToGoogleCalendar(config, { ...meeting, googleCalendarEventId: created.eventId }, state);
  assert.equal('created' in updated && updated.created, false);
  const deleted = await syncMeetingToGoogleCalendar(config, { ...meeting, status: 'cancelled', googleCalendarEventId: created.eventId }, state);
  assert.equal('deleted' in deleted && deleted.deleted, true);
  const recreated = await syncMeetingToGoogleCalendar(config, { ...meeting, googleCalendarEventId: created.eventId }, state);
  assert.equal('created' in recreated && recreated.created, true);
  assert.notEqual(recreated.eventId, created.eventId, 'a deleted Google Calendar event ID must not be reused');
  assert.equal(requests.filter((request) => request.method === 'POST' && request.url?.endsWith('/events')).length, 2, 'only initial creation and deleted-event recovery may insert');
  console.log('Google Calendar verification passed: access check, one-hour fallback, metadata, idempotent update, cancellation, and deleted-event recovery.');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tempRoot, { recursive: true, force: true });
}
