import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectLegacySnapshot, legacyPreflightReport } from './legacy-snapshot-validation.js';
import { writeDatabaseRecoveryRecord } from '../src/databaseRecoveryJournal.js';
import { reserveIdempotency, completeIdempotency } from '../src/idempotency.js';
import type { SimulationState } from '../src/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'megabot-legacy-snapshot-'));
const state = { users: [{ id: 'synthetic', username: 'synthetic', realName: 'Synthetic User', avatarSeed: 'synthetic', role: 'organizer', telegramId: '123456789', privateText: 'DO_NOT_PRINT_SOURCE' }], meetings: [], tasks: [],
  competencies: ['Разработка'], facultyCompetencies: ['Помощь'],
  availabilities: {}, messages: {}, settings: { databaseRevision: 7 } };
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checksum = digest(state);
const event = { id: 'event', name: 'Source event', status: 'active' };
const backup = JSON.stringify(state, null, 2);
try {
  const report = inspectLegacySnapshot(backup, checksum, 7);
  assert.equal(report.counts.users, 1);
  assert.deepEqual(report.state, state);
  assert.deepEqual(inspectLegacySnapshot(backup, checksum, 7), report);
  const safe = legacyPreflightReport({ ...report, futurePrivateProjection: { secret: 'PRIVATE_FUTURE_FIELD' } } as typeof report);
  assert.deepEqual(Object.keys(safe).sort(), ['format', 'passed', 'dryRun', 'integrityOnly', 'sourceKind', 'revision',
    'checksum', 'fileChecksum', 'counts', 'fingerprintFormat', 'entityHashes', 'availabilityProjectionSummary',
    'identityProjectionSummary', 'meetingProjectionSummary', 'taskProjectionSummary', 'runtimeInventory'].sort());
  assert.equal(safe.format, 'legacy-preflight-v1');
  assert.deepEqual(legacyPreflightReport(report), safe);
  for (const privateValue of ['PRIVATE_FUTURE_FIELD', 'DO_NOT_PRINT_SOURCE', 'synthetic'])
    assert.ok(!JSON.stringify(safe).includes(privateValue));
  const sourceA = { ...state, users: [...state.users, { ...state.users[0], id: 'other', telegramId: '456', privateText: 'other' }] };
  const sourceB = { ...sourceA, users: [...sourceA.users].reverse().map(row => Object.fromEntries(Object.entries(row).reverse())) };
  const inspect = (value: unknown) => inspectLegacySnapshot(JSON.stringify(value, null, 2), digest(value), 7);
  for (const text of ['\u0000', '\uD800', '\uDC00', 'valid\uD800tail']) {
    for (const extra of [{ extension: { text } }, { extension: { [text]: 'value' } },
      { users: [{ ...state.users[0], realName: text }] }])
      assert.throws(() => inspect({ ...state, ...extra }), /unsupported_postgres_text/);
    const recovery = { format: 1, revision: 7, checksum, state, extra: text };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(recovery), checksum, 7), /unsupported_postgres_text/);
  }
  const unicodeSource = { ...state, extension: { 'Emoji 🐈': ['Ёжик', 'e\u0301', '\\u0000', '\uD7FF\uE000', 'line\n\ttab'] } };
  assert.deepEqual(inspect(unicodeSource).state, unicodeSource);
  for (const name of [undefined, null, 1, '', '   '])
    assert.throws(() => inspect({ ...state, faculties: [{ id: 'faculty', name }] }), /invalid_legacy_faculty_name/);
  assert.throws(() => inspect({ ...state, faculties: [{ id: 'one', name: 'Same' }, { id: 'two', name: 'Same' }] }), /duplicate_legacy_faculty_name/);
  const distinctFaculties = { ...state, faculties: [{ id: 'one', name: 'Same' }, { id: 'two', name: 'same' }, { id: 'three', name: ' Same ' }] };
  assert.deepEqual(inspect(distinctFaculties).state, distinctFaculties);
  for (const [startsAt, endsAt] of [['31.12.2026', '2027-01-01'], ['2026-10-09', '9.10.2026'], ['', '2026-01-01'], ['2026-01-01', '']]) {
    const source = { ...state, events: [{ ...event, startsAt, endsAt }] };
    assert.deepEqual(inspect(source).state, source);
  }
  assert.throws(() => inspect({ ...state, events: [{ ...event, startsAt: '2027-01-01', endsAt: '31.12.2026' }] }), /reversed_legacy_event_dates/);
  const deactivated = { ...state, users: [{ ...state.users[0], active: false, deactivatedBy: 'PRIVATE_DELETED_ADMIN' }] };
  const deactivation = inspect(deactivated);
  assert.equal(deactivation.identityProjectionSummary.inactiveWithoutTimestamp, 1);
  assert.equal(deactivation.counts.legacyMissingTaskAuthors, 0);
  assert.deepEqual(deactivation.identityProjection.historicalAuthors, [{ entity: 'user', entityId: 'synthetic',
    field: 'deactivatedBy', sourceAuthorId: 'PRIVATE_DELETED_ADMIN', userId: null, legacySource: true }]);
  assert.deepEqual(deactivation.state, deactivated);
  assert.ok(!JSON.stringify(legacyPreflightReport(deactivation)).includes('PRIVATE_DELETED_ADMIN'));
  assert.equal(inspect({ ...state, users: [{ ...state.users[0], active: false, deactivatedAt: '2020-01-01T00:00:00.000Z', deactivatedBy: 'synthetic' }] })
    .identityProjection.historicalAuthors[0].userId, 'synthetic');
  assert.equal(inspect({ ...state, users: [{ ...state.users[0], active: true, deactivatedAt: '2020-01-01T00:00:00.000Z' }] })
    .identityProjectionSummary.contradictoryActiveRows, 1);
  assert.equal(inspect({ ...state, users: [{ ...state.users[0], primaryCompetency: 'Разработка' }] })
    .identityProjectionSummary.primaryOutsideMembershipRows, 1);
  assert.equal(inspect({ ...state, users: [{ ...state.users[0], primaryCompetency: 'Разработка', competencies: ['Разработка'] }] })
    .identityProjectionSummary.primaryOutsideMembershipRows, 0);
  assert.throws(() => inspect({ ...state, users: [{ ...state.users[0], deactivatedBy: 1 }] }), /invalid_historical_author/);
  const hashes = inspect(sourceA).entityHashes;
  assert.deepEqual(inspect(sourceB).entityHashes, hashes);
  assert.notEqual(inspect(sourceB).checksum, inspect(sourceA).checksum);
  const changed = { ...sourceA, users: sourceA.users.map(row => ({ ...row, privateText: row.privateText + 'changed' })) };
  assert.notEqual(inspect(changed).entityHashes.users, hashes.users);
  assert.equal(inspect(changed).entityHashes.settings, hashes.settings);
  assert.deepEqual(sourceA.users[0], state.users[0]);
  const reorderedCatalog = { ...state, competencies: ['one', 'two'] };
  assert.notEqual(inspect(reorderedCatalog).entityHashes.competencies, inspect({ ...reorderedCatalog, competencies: ['two', 'one'] }).entityHashes.competencies);
  const file = writeDatabaseRecoveryRecord(root, state as unknown as SimulationState);
  const original = fs.readFileSync(file, 'utf8');
  assert.equal(inspectLegacySnapshot(original, checksum, 7).sourceKind, 'recovery-record-v1');
  assert.throws(() => inspectLegacySnapshot(backup, '0'.repeat(64), 7), /checksum_mismatch/);
  for (const revision of [-1, 8, 7.1, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => inspectLegacySnapshot(backup, checksum, revision));
  for (const raw of ['{bad', 'null', '[]', backup + '\n', backup.replace('"databaseRevision": 7', '"databaseRevision": 6, "databaseRevision": 7')])
    assert.throws(() => inspectLegacySnapshot(raw, checksum, 7));
  const envelope = JSON.parse(original);
  for (const change of [{ format: 2 }, { revision: 8 }, { checksum: '0'.repeat(64) }])
    assert.throws(() => inspectLegacySnapshot(JSON.stringify({ ...envelope, ...change }), checksum, 7));
  for (const change of [{ users: [{ id: 'same' }, { id: 'same' }] }, { users: [{ id: '' }] }, { users: {} },
    { tasks: null }, { messages: [] }, { availabilities: null }, { events: [{ id: 1 }] },
    { competencies: [{ id: 'not-a-legacy-string' }] }, { facultyCompetencies: ['same', 'same'] },
    { users: [{ ...state.users[0], id: 'one', telegramId: '1' }, { ...state.users[0], id: 'two', telegramId: '1' }] },
    ...[1, -1, '', '01', '+1', ' 1', '1.0', '9223372036854775808'].map(telegramId => ({ users: [{ ...state.users[0], id: 'one', telegramId }] }))]) {
    const invalid = { ...state, ...change };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  const meeting = { id: 'meeting', date: '2026-10-09', time: '00:00', duration: 2, status: 'scheduled',
    hostId: 'synthetic', participants: 'all', attendeeIds: ['synthetic'], rsvpByUser: { synthetic: 'no' } };
  const temporalSource = { ...state, users: [{ ...state.users[0], active: false }], meetings: [{ ...meeting,
    duration: 0.5, audiencePolicy: 'snapshot', audienceUserIds: ['synthetic'], googleCalendarEventId: 'PRIVATE_CALENDAR_ID' }] };
  const temporal = inspect(temporalSource);
  assert.deepEqual(temporal.meetingProjection[0], { sourceId: 'meeting', startsAt: '2026-10-08T21:00:00.000Z',
    zoneId: 'Europe/Moscow', sourceOffsetMinutes: 180, targetClockCompatible: true,
    durationMinutes: 30, kind: 'meeting', status: 'scheduled', hostId: 'synthetic',
    sourceCalendarEventId: 'PRIVATE_CALENDAR_ID', audienceUserIds: ['synthetic'], targetTemporalCompatible: true });
  assert.deepEqual(temporal.state, temporalSource);
  assert.equal(inspect({ ...state, meetings: [meeting] }).meetingProjectionSummary.unresolvedAudiences, 1);
  const historicalSetup = { ...state, meetings: [{ ...meeting, kind: 'setup', duration: 13, status: 'cancelled' }] };
  assert.equal(inspect(historicalSetup).meetingProjection[0].durationMinutes, 780);
  assert.equal(inspect(historicalSetup).meetingProjectionSummary.incompatibleTemporalRows, 1);
  const historicalClock = inspect({ ...state, meetings: [{ ...meeting, date: '2010-07-01', time: '12:00' }] });
  assert.equal(historicalClock.meetingProjection[0].startsAt, '2010-07-01T09:00:00.000Z');
  assert.equal(historicalClock.meetingProjection[0].targetClockCompatible, false);
  assert.equal(historicalClock.meetingProjectionSummary.incompatibleTemporalRows, 1);
  for (const change of [{ audiencePolicy: 'unknown' }, { audiencePolicy: 'snapshot' },
    { audiencePolicy: 'snapshot', audienceUserIds: [] }, { googleCalendarEventId: 123 }])
    assert.throws(() => inspect({ ...state, meetings: [{ ...meeting, ...change }] }));
  for (const change of [{}, { participants: ['synthetic'], audienceUserIds: ['synthetic'] }, { eventId: 'event' }]) {
    const valid = { ...state, events: [event], meetings: [{ ...meeting, ...change }] };
    assert.equal(inspectLegacySnapshot(JSON.stringify(valid, null, 2), digest(valid), 7).counts.meetings, 1);
  }
  for (const change of [{ hostId: 'missing' }, { participants: null }, { participants: ['missing'] },
    { participants: ['synthetic', 'synthetic'] }, { attendeeIds: ['missing'] }, { audienceUserIds: ['missing'] },
    { attendeeIds: ['synthetic', 'synthetic'] }, { rsvpByUser: null }, { rsvpByUser: { missing: 'yes' } },
    { rsvpByUser: { synthetic: 'unanswered' } }, { eventId: 'missing' }]) {
    const invalid = { ...state, meetings: [{ ...meeting, ...change }] };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  const largeId = { ...state, users: [{ ...state.users[0], telegramId: '9223372036854775807' }] };
  for (const birthday of ['29.02', '01.01', '29.02.2000', '2000-02-29', '31.12.1999']) {
    const value = { ...state, users: [{ ...state.users[0], birthday }] };
    const result = inspect(value);
    assert.deepEqual(result.state, value);
    assert.equal(result.counts.birthdaysWithoutYear, birthday.length === 5 ? 1 : 0);
    assert.equal(result.counts.birthdaysWithYear, birthday.length === 5 ? 0 : 1);
    assert.equal(result.identityProjection.birthdays[0].year, birthday.length === 5 ? null : birthday.includes('1999') ? 1999 : 2000);
    assert.equal(result.identityProjection.birthdays[0].day, Number(birthday.includes('-') ? birthday.slice(-2) : birthday.slice(0, 2)));
  }
  for (const birthday of ['29.02.1900', '31.04', '00.01', '01.13', '01.01.99', '01.01.1899', '01.01.2101', ' 01.01', '1.1', null, 101])
    assert.throws(() => inspect({ ...state, users: [{ ...state.users[0], birthday }] }));
  assert.equal(inspectLegacySnapshot(JSON.stringify(largeId, null, 2), digest(largeId), 7).counts.users, 1);
  for (const role of ['admin', 'organizer', 'faculty_responsible', 'faculty_helper']) {
    const competency = role.startsWith('faculty_') ? 'Помощь' : 'Разработка';
    const valid = { ...state, faculties: [{ id: 'faculty', name: 'Faculty' }], users: [{ ...state.users[0], role, facultyId: 'faculty',
      competencies: [competency], primaryCompetency: competency, active: false, registered: false }] };
    assert.deepEqual(inspect(valid).state, valid);
  }
  for (const change of [{ role: 'owner' }, { role: ['admin'] }, { realName: null }, { registered: 'false' },
    { active: 0 }, { facultyId: 'missing' }, { primaryCompetency: 'missing' },
    { competencies: ['missing'] }, { competencies: ['Разработка', 'Разработка'] }]) {
    assert.throws(() => inspect({ ...state, users: [{ ...state.users[0], ...change }] }));
  }
  for (const change of [{ date: '29.02.2028' }, { date: '2000-02-29', status: 'completed', duration: 0.5 },
    { date: '2020-01-01', status: 'cancelled', kind: 'setup', duration: 13, time: '23:59' }, { time: '9:05', kind: 'vibe' }]) {
    const valid = { ...state, meetings: [{ ...meeting, ...change }] };
    assert.equal(inspectLegacySnapshot(JSON.stringify(valid, null, 2), digest(valid), 7).counts.meetings, 1);
  }
  for (const change of [...['09.10', '09.10.26', '2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-10-09 '].map(date => ({ date })),
    ...['24:00', '12:60', '12:00:00', '12:0', ' 12:00'].map(time => ({ time })),
    ...[0, -1, '2', 0.001, Number.MAX_SAFE_INTEGER].map(duration => ({ duration })),
    { status: 'past' }, { kind: 'unknown' }, { status: ['scheduled'] }, { kind: ['meeting'] }]) {
    const invalid = { ...state, meetings: [{ ...meeting, ...change }] };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/legacy-snapshot-dry-run.ts', ...args], { encoding: 'utf8' });
  const incompatibleFile = path.join(root, 'postgres-text.json');
  const incompatible = { ...state, extension: { text: 'PRIVATE_UNICODE_SOURCE\u0000' } };
  const incompatibleBytes = Buffer.from(JSON.stringify(incompatible, null, 2));
  fs.writeFileSync(incompatibleFile, incompatibleBytes);
  const rejectedText = run(['--dry-run', incompatibleFile, '--checksum', digest(incompatible), '--revision', '7']);
  assert.equal(rejectedText.status, 1);
  assert.equal(rejectedText.stdout, '');
  assert.deepEqual(JSON.parse(rejectedText.stderr), { passed: false, code: 'unsupported_postgres_text' });
  assert.deepEqual(fs.readFileSync(incompatibleFile), incompatibleBytes);
  const temporalFile = path.join(root, 'temporal.json');
  fs.writeFileSync(temporalFile, JSON.stringify(temporalSource, null, 2));
  const temporalCli = run(['--dry-run', temporalFile, '--checksum', digest(temporalSource), '--revision', '7']);
  assert.equal(temporalCli.status, 0, temporalCli.stderr);
  assert.deepEqual(JSON.parse(temporalCli.stdout).meetingProjectionSummary, temporal.meetingProjectionSummary);
  assert.ok(!Object.hasOwn(JSON.parse(temporalCli.stdout), 'meetingProjection'));
  assert.ok(!temporalCli.stdout.includes('PRIVATE_CALENDAR_ID'));
  const scheduleSettings = { ...state.settings, availabilityWeekCount: 5, availabilityActiveDays: [0, 6],
    availabilityStartHour: 0, availabilityEndHour: 23, availabilityWeekStart: '2020-12-28',
    availabilityWeekNames: ['Old label'], availabilityWeekMetadata: { '2020-12-28': { name: 'Archive', description: 'Keep history' } } };
  const scheduled = { ...state, settings: scheduleSettings };
  assert.deepEqual(inspect(scheduled).state, scheduled);
  for (const change of [{ availabilityWeekCount: '5' }, { availabilityWeekCount: 6 }, { availabilityActiveDays: [] },
    { availabilityActiveDays: [0, 0] }, { availabilityActiveDays: [7] }, { availabilityEndHour: 24 },
    { availabilityStartHour: 23, availabilityEndHour: 0 }, { availabilityWeekStart: '2020-12-29' },
    { availabilityWeekMetadata: null }, { availabilityWeekMetadata: { '2020-12-29': { name: 'bad' } } },
    { availabilityWeekNames: [1] }, { availabilityWeekStart: '', availabilityWeekMetadata: {} }])
    assert.throws(() => inspect({ ...scheduled, settings: { ...scheduleSettings, ...change } }));
  const idempotencyState = structuredClone(state) as unknown as SimulationState;
  const idemInput = { actorId: 'synthetic', key: 'PRIVATE_IDEMPOTENCY_KEY', operation: 'create', bodyHash: 'a'.repeat(64) };
  assert.equal(reserveIdempotency(idempotencyState, idemInput, new Date('2020-01-01T00:00:00.000Z')).kind, 'reserved');
  assert.equal(completeIdempotency(idempotencyState, idemInput.actorId, idemInput.key, 201, { private: 'PRIVATE_CACHED_RESPONSE' }, new Date('2020-01-01T00:00:01.000Z')), true);
  assert.equal(reserveIdempotency(idempotencyState, { ...idemInput, actorId: 'historical-other' }, new Date('2020-01-01T00:00:00.000Z')).kind, 'reserved');
  assert.deepEqual(inspect(idempotencyState).state, idempotencyState);
  assert.deepEqual(inspect(idempotencyState).runtimeInventory.collections.idempotencyRecords.byStatus, { completed: 1, processing: 1 });
  const idemRecord = idempotencyState.settings!.idempotencyRecords![0];
  for (const records of [null, [idemRecord, { ...idemRecord, operation: 'different' }],
    ...[{ bodyHash: 'wrong' }, { status: 'retry' }, { completedAt: '' }, { responseStatus: 600 }, { actorId: '' }]
      .map(change => [{ ...idemRecord, ...change }])])
    assert.throws(() => inspect({ ...state, settings: { ...state.settings, idempotencyRecords: records } }));
  const idemFile = path.join(root, 'idempotency.json');
  fs.writeFileSync(idemFile, JSON.stringify(idempotencyState, null, 2));
  const idemCli = run(['--dry-run', idemFile, '--checksum', digest(idempotencyState), '--revision', '7']);
  assert.equal(idemCli.status, 0, idemCli.stderr);
  assert.equal(JSON.parse(idemCli.stdout).runtimeInventory.replayAllowed, false);
  assert.ok(!idemCli.stdout.includes('PRIVATE_IDEMPOTENCY_KEY'));
  assert.ok(!idemCli.stdout.includes('PRIVATE_CACHED_RESPONSE'));
  const runtimeTime = '2020-01-01T00:00:00.000Z';
  const delivery = { id: 'delivery', dedupeKey: 'delivery-key', chatId: '123', category: 'legacy', text: 'PRIVATE_RUNTIME_TEXT',
    intendedAt: runtimeTime, availableAt: runtimeTime, updatedAt: runtimeTime, attempts: 1, status: 'unknown' };
  const inbox = { updateId: 1, chatKey: 'private-chat', payload: { privateText: 'PRIVATE_INBOX_PAYLOAD' },
    receivedAt: runtimeTime, availableAt: runtimeTime, updatedAt: runtimeTime, attempts: 1, status: 'processing' };
  const pending = { id: 'pending', text: 'PRIVATE_PENDING_TEXT', silent: true, createdAt: runtimeTime, attempts: 0 };
  const runtime = { ...state, settings: { ...state.settings, notificationDeliveries:
    ['planned', 'sending', 'sent', 'retry', 'failed', 'unknown', 'cancelled', 'expired'].map((status, index) => ({ ...delivery, id: `delivery-${index}`, dedupeKey: `key-${index}`, status })),
    telegramInbox: [inbox], pendingImportantNotifications: [pending] } };
  const runtimeResult = inspect(runtime);
  assert.deepEqual(runtimeResult.state, runtime);
  assert.equal(runtimeResult.runtimeInventory.replayAllowed, false);
  assert.equal(runtimeResult.runtimeInventory.collections.notificationDeliveries.byStatus.unknown, 1);
  assert.equal(runtimeResult.runtimeInventory.collections.notificationDeliveries.byStatus.sending, 1);
  assert.deepEqual(inspect(runtime).runtimeInventory, runtimeResult.runtimeInventory);
  for (const change of [{ notificationDeliveries: null }, { notificationDeliveries: [delivery, delivery] },
    { notificationDeliveries: [delivery, { ...delivery, id: 'other' }] },
    ...[{ attempts: -1 }, { status: 'claimed' }, { chatId: 123 }, { availableAt: 'bad' }].map(change => ({ notificationDeliveries: [{ ...delivery, ...change }] })),
    { telegramInbox: [inbox, inbox] }, { telegramInbox: [{ ...inbox, updateId: '1' }] }, { telegramInbox: [{ ...inbox, payload: [] }] },
    { pendingImportantNotifications: [{ ...pending, silent: 'true' }] }])
    assert.throws(() => inspect({ ...runtime, settings: { ...runtime.settings, ...change } }));
  const runtimeFile = path.join(root, 'runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2));
  const runtimeCli = run(['--dry-run', runtimeFile, '--checksum', digest(runtime), '--revision', '7']);
  assert.equal(runtimeCli.status, 0, runtimeCli.stderr);
  assert.deepEqual(JSON.parse(runtimeCli.stdout).runtimeInventory, runtimeResult.runtimeInventory);
  for (const privateValue of ['PRIVATE_RUNTIME_TEXT', 'PRIVATE_INBOX_PAYLOAD', 'PRIVATE_PENDING_TEXT', 'private-chat'])
    assert.ok(!runtimeCli.stdout.includes(privateValue));
  const message = { id: 'message', userId: 'synthetic', sender: 'bot', text: 'history', timestamp: '2020-01-01T00:00:00.000Z', buttons: [{ text: 'Old button', action: 'legacy_callback' }] };
  const messageState = { ...state, messages: { synthetic: [message] } };
  assert.deepEqual(inspectLegacySnapshot(JSON.stringify(messageState, null, 2), digest(messageState), 7).state, messageState);
  for (const change of [{ userId: 'missing' }, { sender: 'admin' }, { timestamp: 12 }, { text: null },
    { buttons: [{ text: 'button', action: 1 }] }, { buttons: null }, { id: '' }]) {
    const invalid = { ...state, messages: { synthetic: [{ ...message, ...change }] } };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  for (const messages of [{ missing: [message] }, { synthetic: [message, message] }, { synthetic: {} }]) {
    const invalid = { ...state, messages };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  const task = { id: 'task', title: 'Historical task', description: '', sow: '', tips: ['Preserve order'], priority: 'normal',
    deadline: '2020-01-01', status: 'completed', assignedTo: ['synthetic'], creatorId: 'deleted-author',
    assigneeNotes: { synthetic: { executor: 'preserve', history: [{ id: 'comment', authorId: null, side: 'executor', text: 'history' }] } },
    completionComments: { synthetic: 'done' }, reminders: [{ id: 'reminder', type: 'repeat', unit: 'hours', value: 2, sentAt: '2020-01-01T00:00:00.000Z' }] };
  for (const change of [{ title: null }, { description: 1 }, { sow: undefined }, { priority: 'urgent' },
    { tips: null }, { tips: [1] }, { version: -1 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { assignmentMode: 'individual' }, { timeSpentMinutes: null }, { timeSpentMinutes: -1 }, { timeSpentMinutes: 0.5 },
    { timeSpentMinutes: 2147483648 }, { competency: 1 }, { competencies: null }, { competencies: ['same', 'same'] },
    { competencies: [''] }, { reminders: [{ ...task.reminders[0], value: 2147483648 }] }])
    assert.throws(() => inspect({ ...state, tasks: [{ ...task, ...change }] }));
  assert.throws(() => inspect({ ...state, tasks: [task, { ...task, id: 'other-task' }] }), /invalid_task_reminder/);
  const edgeTask = { ...task, version: 0, assignmentMode: 'shared', timeSpentMinutes: 2147483647, priority: 'critical',
    tips: ['second', '', 'first'], reminders: [{ ...task.reminders[0], value: 2147483647 }] };
  assert.deepEqual(inspect({ ...state, tasks: [edgeTask] }).state.tasks, [edgeTask]);
  assert.equal(inspect({ ...state, tasks: [{ ...edgeTask, timeSpentMinutes: 0, version: Number.MAX_SAFE_INTEGER }] }).counts.tasks, 1);
  const deadlineSource = { ...state, tasks: [{ ...task, deadline: '31.12.2026', createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-12-01T00:00:00.000Z' }] };
  const deadlines = inspect(deadlineSource);
  assert.equal(deadlines.taskProjection[0].dueAt, '2026-12-31T20:59:59.999Z');
  assert.equal(deadlines.taskProjection[0].legacyDeadline, '31.12.2026');
  assert.equal(deadlines.taskProjection[0].targetHistoryComplete, true);
  assert.equal(deadlines.taskProjection[0].targetClockCompatible, true);
  assert.deepEqual(deadlines.state, deadlineSource);
  assert.deepEqual(inspect(deadlineSource).taskProjectionSummary, deadlines.taskProjectionSummary);
  const leapDeadline = inspect({ ...deadlineSource, tasks: [{ ...deadlineSource.tasks[0], deadline: '2028-02-29' }] });
  assert.equal(leapDeadline.taskProjection[0].dueAt, '2028-02-29T20:59:59.999Z');
  assert.equal(inspect({ ...state, tasks: [task] }).taskProjectionSummary.incompleteHistoryRows, 1);
  const cancelledTask = { ...deadlineSource.tasks[0], status: 'cancelled', completedAt: '', cancelledAt: '2026-12-01T00:00:00.000Z' };
  assert.equal(inspect({ ...state, tasks: [cancelledTask] }).taskProjection[0].targetHistoryComplete, true);
  assert.equal(inspect({ ...state, tasks: [{ ...cancelledTask, completedAt: '2026-12-01T00:00:00.000Z' }] }).taskProjectionSummary.incompleteHistoryRows, 1);
  assert.equal(inspect({ ...state, tasks: [{ ...task, deadline: '2010-07-01' }] }).taskProjectionSummary.clockReviewRows, 1);
  const deadlineFile = path.join(root, 'deadlines.json');
  fs.writeFileSync(deadlineFile, JSON.stringify(deadlineSource, null, 2));
  const deadlineCli = run(['--dry-run', deadlineFile, '--checksum', digest(deadlineSource), '--revision', '7']);
  assert.equal(deadlineCli.status, 0, deadlineCli.stderr);
  assert.deepEqual(JSON.parse(deadlineCli.stdout).taskProjectionSummary, deadlines.taskProjectionSummary);
  assert.ok(!Object.hasOwn(JSON.parse(deadlineCli.stdout), 'taskProjection'));
  for (const status of ['open', 'assigned', 'waiting', 'in_progress', 'completed', 'cancelled']) {
    const valid = { ...state, tasks: [{ ...task, status }] };
    const result = inspectLegacySnapshot(JSON.stringify(valid, null, 2), digest(valid), 7);
    assert.deepEqual(result.state, valid);
    assert.equal(result.counts.legacyMissingTaskAuthors, 2);
  }
  for (const change of [{ assignedTo: ['missing'] }, { assignedTo: ['synthetic', 'synthetic'] }, { assignedTo: 'synthetic' },
    { status: 'done' }, { creatorId: 123 }, { completionComments: { missing: 'text' } },
    { completionComments: { synthetic: 5 } }, { assigneeNotes: null },
    { assigneeNotes: { synthetic: { history: [{ id: 'same', text: 'x', side: 'executor' }, { id: 'same', text: 'y', side: 'executor' }] } } },
    { reminders: [{ id: 'r', type: 'repeat', unit: 'minutes', value: 2 }] },
    { reminders: [{ id: 'r', type: 'repeat', unit: 'hours', value: 0 }] },
    { reminders: [task.reminders[0], task.reminders[0]] }, { eventId: 'missing' }, { facultyId: 'missing' }, { eventId: null }]) {
    const invalid = { ...state, tasks: [{ ...task, ...change }] };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  const linkedTask = { ...state, events: [event], faculties: [{ id: 'faculty', name: 'Faculty' }], tasks: [{ ...task, eventId: 'event', facultyId: 'faculty' }] };
  assert.deepEqual(inspectLegacySnapshot(JSON.stringify(linkedTask, null, 2), digest(linkedTask), 7).state, linkedTask);
  const attribution = inspect(linkedTask);
  assert.deepEqual(attribution.identityProjection.historicalAuthors.find(row => row.entity === 'task'), {
    entity: 'task', entityId: 'task', field: 'creatorId', sourceAuthorId: 'deleted-author', userId: null, legacySource: true });
  assert.equal(attribution.identityProjection.historicalAuthors.find(row => row.entity === 'task_comment')?.userId, null);
  assert.deepEqual(inspect(linkedTask).identityProjectionSummary, attribution.identityProjectionSummary);
  const knownAuthor = { ...linkedTask, tasks: [{ ...task, creatorId: 'synthetic' }], users: [{ ...state.users[0], active: false }] };
  assert.equal(inspect(knownAuthor).identityProjection.historicalAuthors.find(row => row.entity === 'task')?.userId, 'synthetic');
  assert.notEqual(inspect(knownAuthor).identityProjectionSummary.checksum, attribution.identityProjectionSummary.checksum);
  const unlinkedTask = { ...state, tasks: [{ ...task, eventId: '', facultyId: '' }] };
  assert.equal(inspectLegacySnapshot(JSON.stringify(unlinkedTask, null, 2), digest(unlinkedTask), 7).counts.tasks, 1);
  for (const invalidTime of ['2026-02-30T00:00:00.000Z', '2026-10-09', '2026-10-09T12:00:00',
    '2026-10-09T12:00:00.000+03:00', '2026-10-09T24:00:00.000Z', '', null]) {
    const invalid = { ...state, messages: { synthetic: [{ ...message, timestamp: invalidTime }] } };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  for (const change of [{ completedAt: '09.10' }, { assigneeNotes: { synthetic: { updatedAt: 'bad' } } },
    { reminders: [{ ...task.reminders[0], lastSentAt: 'bad' }] }]) {
    const invalid = { ...state, tasks: [{ ...task, ...change }] };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  const availability = { userId: 'synthetic', weekStart: '2020-12-28', slots: { 0: [0, 23], 34: [17] },
    hardUnavailableDays: [1], outWeekIndexes: [1], weekVersions: { '2020-12-28': 2, '2021-01-04': 3 } };
  const dated = { ...state, availabilities: { synthetic: availability } };
  const datedRaw = JSON.stringify(dated, null, 2);
  const archived = { ...state, events: [{ ...event, status: 'archived', createdBy: 'historical-missing', startsAt: '09.10.2020', endsAt: '' }] };
  assert.deepEqual(inspectLegacySnapshot(JSON.stringify(archived, null, 2), digest(archived), 7).state, archived);
  for (const date of ['09.10', '09.10.20', '2026-02-29', '2020-01-01T00:00:00.000Z', null, '']) {
    const invalidTask = { ...state, tasks: [{ ...task, deadline: date }] };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalidTask, null, 2), digest(invalidTask), 7));
    if (date !== '') {
      const invalidEvent = { ...state, events: [{ ...event, startsAt: date }] };
      assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalidEvent, null, 2), digest(invalidEvent), 7));
    }
  }
  for (const change of [{ name: '' }, { status: 'cancelled' }, { startsAt: 1 }, { createdBy: null }]) {
    const invalid = { ...state, events: [{ ...event, ...change }] };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  const avatar = 'data:image/png;base64,' + 'A'.repeat(60_000);
  const withAvatar = { ...state, users: [{ ...state.users[0], avatarDataUrl: avatar }] };
  assert.equal(inspectLegacySnapshot(JSON.stringify(withAvatar, null, 2), digest(withAvatar), 7).counts.avatars, 1);
  assert.deepEqual(inspectLegacySnapshot(JSON.stringify(withAvatar, null, 2), digest(withAvatar), 7).state, withAvatar);
  for (const avatarDataUrl of [null, 1, 'https://example.invalid/avatar', 'data:image/svg+xml;base64,AA', avatar.repeat(6)]) {
    const invalid = { ...state, users: [{ ...state.users[0], avatarDataUrl }] };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  assert.deepEqual(inspectLegacySnapshot(datedRaw, digest(dated), 7).state, dated);
  assert.equal(JSON.stringify(dated, null, 2), datedRaw);
  const overflow = { ...dated, availabilities: { synthetic: { ...availability, weekStart: '9999-12-27' } } };
  assert.throws(() => inspect(overflow), /availability_date_overflow/);
  const projection = inspect(dated);
  assert.deepEqual(projection.availabilityProjection, [{ userId: 'synthetic', anchor: '2020-12-28',
    slots: [{ date: '2020-12-28', hours: [0, 23] }, { date: '2021-01-31', hours: [17] }],
    hardUnavailableDates: ['2020-12-29'], outWeekStarts: ['2021-01-04'],
    weekVersions: { '2020-12-28': 2, '2021-01-04': 3 } }]);
  assert.equal(projection.availabilityProjectionSummary.slots, 3);
  const permuted = { ...dated, availabilities: { synthetic: { ...availability, slots: { 34: [17], 0: [23, 0] } } } };
  assert.deepEqual(inspect(permuted).availabilityProjectionSummary, projection.availabilityProjectionSummary);
  assert.equal(JSON.stringify(dated, null, 2), datedRaw);
  for (const change of [{ userId: 'missing' }, { weekStart: '' }, { weekStart: '2026-02-30' }, { weekStart: '2026-10-06' },
    { slots: { 35: [17] } }, { slots: { '01': [17] } }, { slots: { '2020-12-28': [17] } },
    { slots: { 0: [24] } }, { slots: { 0: ['17'] } }, { slots: { 0: [17, 17] } },
    { hardUnavailableDays: [0] }, { outWeekIndexes: [0] }, { outWeekIndexes: [5] },
    { hardUnavailableDays: [1, 1] }, { hardUnavailableDays: null }, { outWeekIndexes: null },
    { weekStart: undefined, updatedAt: '2020-12-28T12:00:00Z' },
    { weekVersions: { '2020-12-29': 1 } }, { weekVersions: { '2020-12-28': -1 } }]) {
    const invalid = { ...state, availabilities: { synthetic: { ...availability, ...change } } };
    assert.throws(() => inspectLegacySnapshot(JSON.stringify(invalid, null, 2), digest(invalid), 7));
  }
  const missingAvailabilityUser = { ...state, availabilities: { missing: { ...availability, userId: 'missing' } } };
  assert.throws(() => inspectLegacySnapshot(JSON.stringify(missingAvailabilityUser, null, 2), digest(missingAvailabilityUser), 7));
  const args = ['--dry-run', file, '--checksum', checksum, '--revision', '7'];
  const success = run(args);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).integrityOnly, true);
  assert.equal(JSON.parse(success.stdout).format, 'legacy-preflight-v1');
  assert.deepEqual(JSON.parse(success.stdout), legacyPreflightReport(inspectLegacySnapshot(original, checksum, 7)));
  assert.deepEqual(JSON.parse(success.stdout).entityHashes, report.entityHashes);
  assert.equal(JSON.parse(success.stdout).fingerprintFormat, 'legacy-source-entities-v1');
  assert.ok(!Object.hasOwn(JSON.parse(success.stdout), 'availabilityProjection'));
  assert.ok(!Object.hasOwn(JSON.parse(success.stdout), 'identityProjection'));
  const attributionFile = path.join(root, 'attribution.json');
  fs.writeFileSync(attributionFile, JSON.stringify(linkedTask, null, 2));
  const attributionCli = run(['--dry-run', attributionFile, '--checksum', digest(linkedTask), '--revision', '7']);
  assert.equal(attributionCli.status, 0, attributionCli.stderr);
  assert.deepEqual(JSON.parse(attributionCli.stdout).identityProjectionSummary, attribution.identityProjectionSummary);
  assert.ok(!Object.hasOwn(JSON.parse(attributionCli.stdout), 'identityProjection'));
  assert.ok(!attributionCli.stdout.includes('deleted-author'));
  const datedFile = path.join(root, 'dated.json');
  fs.writeFileSync(datedFile, datedRaw);
  const datedCli = run(['--dry-run', datedFile, '--checksum', digest(dated), '--revision', '7']);
  assert.equal(datedCli.status, 0, datedCli.stderr);
  const datedReport = JSON.parse(datedCli.stdout);
  assert.deepEqual(datedReport.availabilityProjectionSummary, projection.availabilityProjectionSummary);
  assert.ok(!Object.hasOwn(datedReport, 'availabilityProjection'));
  assert.ok(!datedCli.stdout.includes('synthetic'));
  assert.equal(fs.readFileSync(datedFile, 'utf8'), datedRaw);
  assert.ok(!success.stdout.includes('DO_NOT_PRINT_SOURCE'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  for (const rejected of [[], args.slice(1), ['--apply', ...args.slice(1)], [...args.slice(0, 3), '0'.repeat(64), ...args.slice(4)]]) {
    const failed = run(rejected);
    assert.equal(failed.status, 1);
    assert.ok(!failed.stderr.includes('DO_NOT_PRINT_SOURCE'));
  }
  const invalidUtf8 = path.join(root, 'invalid-utf8.json');
  fs.writeFileSync(invalidUtf8, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
  assert.equal(run(['--dry-run', invalidUtf8, ...args.slice(2)]).status, 1);
  const bomFile = path.join(root, 'bom.json');
  const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(original)]);
  fs.writeFileSync(bomFile, bomBytes);
  assert.equal(run(['--dry-run', bomFile, ...args.slice(2)]).status, 1);
  assert.deepEqual(fs.readFileSync(bomFile), bomBytes);
  const unicodeState = { ...state, users: [{ ...state.users[0], realName: 'Ёжик 🐈 e\u0301' }] };
  const unicodeFile = path.join(root, 'unicode.json');
  const unicodeBytes = Buffer.from(JSON.stringify(unicodeState, null, 2));
  fs.writeFileSync(unicodeFile, unicodeBytes);
  const unicodeCli = run(['--dry-run', unicodeFile, '--checksum', digest(unicodeState), '--revision', '7']);
  assert.equal(unicodeCli.status, 0, unicodeCli.stderr);
  assert.equal(JSON.parse(unicodeCli.stdout).fileChecksum, crypto.createHash('sha256').update(unicodeBytes).digest('hex'));
  assert.deepEqual(fs.readFileSync(unicodeFile), unicodeBytes);
  console.log('Legacy snapshot integrity: writer compatibility, checksums/revisions, invalid inputs, safe read-only CLI passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
