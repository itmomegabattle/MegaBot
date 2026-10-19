import crypto from 'node:crypto';
import { parseProjectLocalDate, projectDateTimeInstant, projectDateDeadlineInstant, projectClock, PROJECT_TIME_ZONE, PROJECT_UTC_OFFSET_MINUTES } from '../src/projectTime.js';
import { birthdayParts } from '../src/birthdayGift.js';
import { normalizeMeetingKind, meetingDurationError } from '../src/meetingKind.js';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function reject(code: string): never { throw new Error(code); }
function postgresText(value: unknown): void {
  if (typeof value === 'string') {
    for (const character of value) {
      const code = character.codePointAt(0)!;
      if (code === 0 || (code >= 0xD800 && code <= 0xDFFF)) reject('unsupported_postgres_text');
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { postgresText(key); postgresText(child); }
  }
}
/** Explicit output allowlist: new internal projections must never become CLI output by default. */
export function legacyPreflightReport(result: ReturnType<typeof inspectLegacySnapshot>) {
  return { format: 'legacy-preflight-v1', passed: true, dryRun: true, integrityOnly: true,
    sourceKind: result.sourceKind, revision: result.revision, checksum: result.checksum,
    fileChecksum: result.fileChecksum, counts: result.counts, fingerprintFormat: result.fingerprintFormat,
    entityHashes: result.entityHashes, availabilityProjectionSummary: result.availabilityProjectionSummary,
    identityProjectionSummary: result.identityProjectionSummary, meetingProjectionSummary: result.meetingProjectionSummary,
    taskProjectionSummary: result.taskProjectionSummary, runtimeInventory: result.runtimeInventory };
}
function fullDate(value: unknown, optional = false) {
  if (optional && (value === undefined || value === '')) return;
  if (typeof value !== 'string' || !/^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})$/.test(value)) reject('invalid_legacy_date');
  const date = parseProjectLocalDate(value);
  if (!date) reject('invalid_legacy_date');
  return date;
}
function timestamp(value: unknown, optional = true) {
  if (optional && (value === undefined || value === '')) return;
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)) reject('invalid_legacy_timestamp');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) reject('invalid_legacy_timestamp');
}
function matchesMoscowWallClock(instant: Date, date: string, hour: number, minute: number) {
  const source = parseProjectLocalDate(date)!, clock = projectClock(instant);
  return clock.year === source.year && clock.month === source.month && clock.day === source.day
    && clock.hour === hour && clock.minute === minute;
}
function datedAvailability(rows: Record<string, unknown>) {
  return Object.keys(rows).sort().map(userId => {
    const row = rows[userId] as Record<string, unknown>;
    const date = (days: number) => {
      const value = new Date(`${row.weekStart}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + days);
      const result = value.toISOString().slice(0, 10);
      if (!/^[0-9]{4}-/.test(result)) reject('availability_date_overflow');
      return result;
    };
    return { userId, anchor: row.weekStart,
      slots: Object.entries(row.slots as Record<string, number[]>).sort(([a], [b]) => Number(a) - Number(b))
        .map(([day, hours]) => ({ date: date(Number(day)), hours: [...hours].sort((a, b) => a - b) })),
      hardUnavailableDates: ((row.hardUnavailableDays ?? []) as number[]).map(date).sort(),
      outWeekStarts: ((row.outWeekIndexes ?? []) as number[]).map(index => date(index * 7)).sort(),
      weekVersions: { ...(row.weekVersions as Record<string, number> | undefined) } };
  });
}

/** Offline integrity gate, not proof of Sheets readiness or a complete entity validator. */
export function inspectLegacySnapshot(raw: string, expectedChecksum: string, expectedRevision: number) {
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) reject('invalid_expected_source');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { reject('invalid_snapshot_json'); }
  if (!object(parsed)) reject('invalid_snapshot_root');
  const recovery = Object.hasOwn(parsed, 'format');
  // Accept the exact existing writers' formats: this also rejects duplicate JSON keys
  // and lossy number spellings without introducing a second JSON parser.
  if (raw !== JSON.stringify(parsed, null, recovery ? undefined : 2)) reject('noncanonical_snapshot');
  postgresText(parsed); // Check keys and unknown/envelope fields too: reconciliation casts the whole original to jsonb.
  if (recovery && parsed.format !== 1) reject('unsupported_recovery_format');
  const state = recovery ? parsed.state : parsed;
  if (!object(state) || !object(state.settings)) reject('invalid_snapshot_state');
  const revision = state.settings.databaseRevision;
  if (!Number.isSafeInteger(revision) || revision !== expectedRevision) reject('snapshot_revision_mismatch');
  const checksum = digest(JSON.stringify(state));
  if (checksum !== expectedChecksum) reject('snapshot_checksum_mismatch');
  if (recovery && (parsed.revision !== revision || parsed.checksum !== checksum)) reject('recovery_envelope_mismatch');
  const counts: Record<string, number> = {};
  for (const name of ['users', 'meetings', 'tasks', 'events', 'faculties']) {
    const rows = state[name];
    if (rows === undefined && !['users', 'meetings', 'tasks'].includes(name)) continue;
    if (!Array.isArray(rows)) reject('invalid_entity_collection');
    const ids = new Set<string>();
    for (const row of rows) {
      if (!object(row) || typeof row.id !== 'string' || !row.id.trim()) reject('invalid_entity_id');
      if (ids.has(row.id)) reject('duplicate_entity_id');
      ids.add(row.id);
    }
    counts[name] = rows.length;
  }
  const telegramIds = new Set<string>();
  const birthdays: { userId: string; day: number | null; month: number | null; year: number | null }[] = [];
  counts.avatars = 0;
  counts.birthdaysWithYear = 0;
  counts.birthdaysWithoutYear = 0;
  for (const row of state.users as Record<string, unknown>[]) {
    if (row.birthday !== undefined && row.birthday !== '') {
      if (typeof row.birthday !== 'string' || !/^(?:[0-9]{2}\.[0-9]{2}(?:\.[0-9]{4})?|[0-9]{4}-[0-9]{2}-[0-9]{2})$/.test(row.birthday)) reject('invalid_legacy_birthday');
      const birthday = birthdayParts(row.birthday);
      if (!birthday) reject('invalid_legacy_birthday');
      if (birthday.year !== undefined && (birthday.year < 1900 || birthday.year > 2100)) reject('unsupported_target_birthday_year');
      birthdays.push({ userId: row.id as string, day: birthday.day, month: birthday.month, year: birthday.year ?? null });
      counts[birthday.year === undefined ? 'birthdaysWithoutYear' : 'birthdaysWithYear']++;
    } else birthdays.push({ userId: row.id as string, day: null, month: null, year: null });
    if (typeof row.role !== 'string' || !['admin', 'organizer', 'faculty_responsible', 'faculty_helper'].includes(row.role)) reject('invalid_legacy_user_role');
    for (const field of ['username', 'realName', 'avatarSeed'])
      if (typeof row[field] !== 'string') reject('invalid_legacy_user_field');
    for (const field of ['registered', 'active', 'telegramConnected'])
      if (row[field] !== undefined && typeof row[field] !== 'boolean') reject('invalid_legacy_user_flag');
    if (row.avatarDataUrl !== undefined && row.avatarDataUrl !== '') {
      if (typeof row.avatarDataUrl !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,/i.test(row.avatarDataUrl)
        || row.avatarDataUrl.length > 300_000) reject('invalid_legacy_avatar');
      counts.avatars++;
    }
    for (const field of ['joinedAt', 'lastSeenAt', 'deactivatedAt']) timestamp(row[field]);
    const id = row.telegramId;
    if (id === undefined || id === null) continue;
    // The Sheets reader and SimulationState preserve Telegram IDs as decimal strings.
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) reject('invalid_legacy_telegram_id');
    if (telegramIds.has(id)) reject('duplicate_legacy_telegram_id');
    telegramIds.add(id);
  }
  for (const name of ['competencies', 'facultyCompetencies']) {
    const values = state[name];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) reject('invalid_legacy_catalog');
    if (new Set(values).size !== values.length) reject('duplicate_legacy_catalog_entry');
    counts[name] = values.length;
  }
  for (const name of ['availabilities', 'messages']) {
    if (!object(state[name])) reject('invalid_dictionary_collection');
    counts[name] = Object.keys(state[name]).length;
  }
  const userIds = new Set((state.users as Record<string, unknown>[]).map(row => row.id));
  const monday = (value: unknown) => {
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || !parseProjectLocalDate(value)
      || new Date(`${value}T12:00:00Z`).getUTCDay() !== 1) reject('invalid_availability_week_start');
  };
  const indexes = (value: unknown, limit: number) => {
    if (!Array.isArray(value) || value.some(index => typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= limit)) reject('invalid_availability_index');
    if (new Set(value).size !== value.length) reject('duplicate_availability_index');
    return value as number[];
  };
  const settings = state.settings;
  for (const [field, min, max] of [['availabilityWeekCount', 2, 5], ['availabilityStartHour', 0, 23], ['availabilityEndHour', 0, 23]] as const) {
    const value = settings[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)) reject('invalid_legacy_availability_config');
  }
  if (settings.availabilityStartHour !== undefined && settings.availabilityEndHour !== undefined
    && (settings.availabilityStartHour as number) > (settings.availabilityEndHour as number)) reject('reversed_legacy_availability_hours');
  if (settings.availabilityActiveDays !== undefined && indexes(settings.availabilityActiveDays, 7).length === 0) reject('empty_legacy_active_days');
  if (settings.availabilityWeekStart !== undefined && settings.availabilityWeekStart !== '') monday(settings.availabilityWeekStart);
  const metadata = settings.availabilityWeekMetadata;
  if (metadata !== undefined) {
    if (!object(metadata)) reject('invalid_legacy_week_metadata');
    for (const [week, value] of Object.entries(metadata)) {
      monday(week);
      if (!object(value)) reject('invalid_legacy_week_metadata');
      for (const field of ['name', 'description'])
        if (value[field] !== undefined && typeof value[field] !== 'string') reject('invalid_legacy_week_metadata');
    }
  }
  for (const field of ['availabilityWeekNames', 'availabilityWeekDescriptions']) {
    const value = settings[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) reject('invalid_legacy_week_labels');
    if (value.some(item => item !== '') && !settings.availabilityWeekStart && (!object(metadata) || !Object.keys(metadata).length)) reject('ambiguous_legacy_week_labels');
  }
  for (const [userId, availability] of Object.entries(state.availabilities as Record<string, unknown>)) {
    if (!userIds.has(userId) || !object(availability) || availability.userId !== userId) reject('invalid_availability_user');
    // Never call alignAvailabilityToWeek: its today/updatedAt fallback and clipping lose source history.
    monday(availability.weekStart);
    timestamp(availability.updatedAt);
    if (!object(availability.slots)) reject('invalid_availability_slots');
    const unavailable = indexes(availability.hardUnavailableDays === undefined ? [] : availability.hardUnavailableDays, 35);
    const out = indexes(availability.outWeekIndexes === undefined ? [] : availability.outWeekIndexes, 5);
    for (const [day, hours] of Object.entries(availability.slots)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(day) || Number(day) >= 35) reject('invalid_availability_day');
      const values = indexes(hours, 24);
      if (values.length && (unavailable.includes(Number(day)) || out.includes(Math.floor(Number(day) / 7)))) reject('conflicting_availability');
    }
    if (availability.weekVersions !== undefined) {
      if (!object(availability.weekVersions)) reject('invalid_availability_versions');
      for (const [week, version] of Object.entries(availability.weekVersions)) {
        monday(week);
        if (!Number.isSafeInteger(version) || (version as number) < 0) reject('invalid_availability_version');
      }
    }
  }
  const eventIds = new Set(((state.events ?? []) as Record<string, unknown>[]).map(row => row.id));
  const facultyNames = new Set<string>();
  for (const faculty of (state.faculties ?? []) as Record<string, unknown>[]) {
    if (typeof faculty.name !== 'string' || !faculty.name.trim()) reject('invalid_legacy_faculty_name');
    if (facultyNames.has(faculty.name)) reject('duplicate_legacy_faculty_name');
    facultyNames.add(faculty.name); // PostgreSQL uniqueness is exact; no case/whitespace rewriting.
  }
  for (const event of (state.events ?? []) as Record<string, unknown>[]) {
    timestamp(event.createdAt);
    if (typeof event.name !== 'string' || !event.name.trim() || !['active', 'archived'].includes(event.status as string)) reject('invalid_legacy_event');
    for (const field of ['description', 'startsAt', 'endsAt', 'createdBy'])
      if (event[field] !== undefined && typeof event[field] !== 'string') reject('invalid_legacy_event_field');
    const start = fullDate(event.startsAt, true), end = fullDate(event.endsAt, true);
    if (start && end && start.year * 10000 + start.month * 100 + start.day > end.year * 10000 + end.month * 100 + end.day)
      reject('reversed_legacy_event_dates');
  }
  const userRef = (id: unknown) => { if (typeof id !== 'string' || !userIds.has(id)) reject('missing_meeting_user'); };
  const userRefs = (ids: unknown) => {
    if (!Array.isArray(ids)) reject('invalid_meeting_user_list');
    ids.forEach(userRef);
    if (new Set(ids).size !== ids.length) reject('duplicate_meeting_user');
  };
  for (const meeting of state.meetings as Record<string, unknown>[]) {
    // Unlike interactive entry, migration must never infer a missing year from today.
    fullDate(meeting.date);
    if (typeof meeting.time !== 'string' || !/^(?:[01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(meeting.time)) reject('invalid_legacy_meeting_time');
    // Source duration is hours. Preserve historical values rather than imposing current create limits.
    if (typeof meeting.duration !== 'number' || meeting.duration <= 0 || !Number.isSafeInteger(meeting.duration * 60)) reject('invalid_legacy_meeting_duration');
    if (typeof meeting.status !== 'string' || !['scheduled', 'completed', 'cancelled'].includes(meeting.status)) reject('invalid_legacy_meeting_status');
    if (meeting.kind !== undefined && (typeof meeting.kind !== 'string' || !['meeting', 'setup', 'vibe'].includes(meeting.kind))) reject('invalid_legacy_meeting_kind');
    userRef(meeting.hostId);
    if (meeting.participants !== 'all') userRefs(meeting.participants);
    for (const name of ['audienceUserIds', 'attendeeIds'])
      if (Object.hasOwn(meeting, name)) userRefs(meeting[name]);
    if (meeting.audiencePolicy !== undefined && meeting.audiencePolicy !== 'snapshot') reject('invalid_legacy_audience_policy');
    if (meeting.audiencePolicy === 'snapshot') {
      if (!Array.isArray(meeting.audienceUserIds)) reject('missing_snapshot_meeting_audience');
      const members = new Set(meeting.audienceUserIds);
      for (const id of [...((meeting.attendeeIds ?? []) as string[]), ...Object.keys(object(meeting.rsvpByUser) ? meeting.rsvpByUser : {})])
        if (!members.has(id)) reject('legacy_response_outside_snapshot_audience');
    }
    if (meeting.googleCalendarEventId !== undefined && typeof meeting.googleCalendarEventId !== 'string') reject('invalid_legacy_calendar_id');
    if (Object.hasOwn(meeting, 'rsvpByUser')) {
      if (!object(meeting.rsvpByUser)) reject('invalid_legacy_rsvps');
      for (const [id, response] of Object.entries(meeting.rsvpByUser)) {
        userRef(id);
        if (response !== 'yes' && response !== 'no') reject('invalid_legacy_response');
      }
    }
    if (meeting.eventId !== undefined && (typeof meeting.eventId !== 'string' || !eventIds.has(meeting.eventId))) reject('missing_meeting_event');
  }
  counts.legacyMissingTaskAuthors = 0;
  const facultyIds = new Set(((state.faculties ?? []) as Record<string, unknown>[]).map(row => row.id));
  const optionalRef = (id: unknown, ids: Set<unknown>) => {
    if (id !== undefined && id !== '' && (typeof id !== 'string' || !ids.has(id))) reject('missing_legacy_reference');
  };
  for (const user of state.users as Record<string, unknown>[]) {
    const competencyNames = new Set((state[(user.role as string).startsWith('faculty_') ? 'facultyCompetencies' : 'competencies'] ?? []) as string[]);
    optionalRef(user.facultyId, facultyIds);
    optionalRef(user.primaryCompetency, competencyNames);
    if (user.competencies !== undefined) {
      if (!Array.isArray(user.competencies) || new Set(user.competencies).size !== user.competencies.length) reject('invalid_user_competencies');
      for (const name of user.competencies)
        if (typeof name !== 'string' || !competencyNames.has(name)) reject('missing_user_competency');
    }
  }
  const historicalAuthors: { entity: string; entityId: string; field: string; sourceAuthorId: string | null; userId: string | null; legacySource: boolean }[] = [];
  const historicalAuthor = (id: unknown, entity: string, entityId: string, field: string) => {
    if (id !== undefined && id !== null && typeof id !== 'string') reject('invalid_historical_author');
    const userId = id && userIds.has(id) ? id as string : null;
    historicalAuthors.push({ entity, entityId, field, sourceAuthorId: (id ?? null) as string | null, userId, legacySource: true });
    if ((entity === 'task' || entity === 'task_comment') && userId === null) counts.legacyMissingTaskAuthors++;
  };
  for (const user of state.users as Record<string, unknown>[])
    if (Object.hasOwn(user, 'deactivatedBy')) historicalAuthor(user.deactivatedBy, 'user', user.id as string, 'deactivatedBy');
  for (const event of (state.events ?? []) as Record<string, unknown>[])
    historicalAuthor(event.createdBy, 'event', event.id as string, 'createdBy');
  const reminderIds = new Set<string>();
  for (const task of state.tasks as Record<string, unknown>[]) {
    for (const field of ['title', 'description', 'sow'])
      if (typeof task[field] !== 'string') reject('invalid_legacy_task_text');
    if (!['normal', 'important', 'critical'].includes(task.priority as string)) reject('invalid_legacy_task_priority');
    if (!Array.isArray(task.tips) || task.tips.some(tip => typeof tip !== 'string')) reject('invalid_legacy_task_tips');
    if (task.version !== undefined && (!Number.isSafeInteger(task.version) || (task.version as number) < 0)) reject('invalid_legacy_task_version');
    if (task.assignmentMode !== undefined && task.assignmentMode !== 'shared') reject('unsupported_legacy_assignment_mode');
    if (task.timeSpentMinutes !== undefined && (!Number.isInteger(task.timeSpentMinutes)
      || (task.timeSpentMinutes as number) < 0 || (task.timeSpentMinutes as number) > 2147483647)) reject('unsupported_target_task_effort');
    if (task.competency !== undefined && typeof task.competency !== 'string') reject('invalid_legacy_task_competencies');
    if (task.competencies !== undefined && (!Array.isArray(task.competencies)
      || task.competencies.some(name => typeof name !== 'string' || !name.trim())
      || new Set(task.competencies).size !== task.competencies.length)) reject('invalid_legacy_task_competencies');
    fullDate(task.deadline);
    for (const field of ['createdAt', 'completedAt', 'cancelledAt']) timestamp(task[field]);
    optionalRef(task.eventId, eventIds);
    optionalRef(task.facultyId, facultyIds);
    if (typeof task.status !== 'string' || !['open', 'assigned', 'completed', 'waiting', 'in_progress', 'cancelled'].includes(task.status)) reject('invalid_legacy_task_status');
    if (task.assignedTo !== null) userRefs(task.assignedTo);
    historicalAuthor(task.creatorId, 'task', task.id as string, 'creatorId');
    for (const name of ['completedBy', 'cancelledBy']) if (Object.hasOwn(task, name)) historicalAuthor(task[name], 'task', task.id as string, name);
    for (const name of ['assigneeNotes', 'completionComments']) {
      if (task[name] === undefined) continue;
      if (!object(task[name])) reject('invalid_task_comments');
      for (const [owner, value] of Object.entries(task[name])) {
        userRef(owner);
        if (name === 'completionComments') {
          if (typeof value !== 'string') reject('invalid_task_comment');
          continue;
        }
        if (!object(value)) reject('invalid_task_note');
        timestamp(value.updatedAt);
        for (const field of ['executor', 'coordinator'])
          if (value[field] !== undefined && typeof value[field] !== 'string') reject('invalid_task_note');
        if (value.history === undefined) continue;
        if (!Array.isArray(value.history)) reject('invalid_task_history');
        const ids = new Set<string>();
        for (const comment of value.history) {
          if (!object(comment) || typeof comment.id !== 'string' || !comment.id.trim() || ids.has(comment.id)
            || typeof comment.text !== 'string' || !['executor', 'coordinator'].includes(comment.side as string)) reject('invalid_task_history');
          ids.add(comment.id);
          timestamp(comment.createdAt);
          historicalAuthor(comment.authorId, 'task_comment', task.id as string, JSON.stringify([owner, comment.id, 'authorId']));
        }
      }
    }
    if (task.reminders !== undefined) {
      if (!Array.isArray(task.reminders)) reject('invalid_task_reminders');
      for (const reminder of task.reminders) {
        if (!object(reminder) || typeof reminder.id !== 'string' || !reminder.id.trim() || reminderIds.has(reminder.id)
          || !['before_deadline', 'repeat'].includes(reminder.type as string) || !['days', 'hours'].includes(reminder.unit as string)
          || !Number.isInteger(reminder.value) || (reminder.value as number) <= 0 || (reminder.value as number) > 2147483647) reject('invalid_task_reminder');
        reminderIds.add(reminder.id);
        timestamp(reminder.sentAt);
        timestamp(reminder.lastSentAt);
      }
    }
  }
  const messageIds = new Set<string>();
  for (const [owner, messages] of Object.entries(state.messages as Record<string, unknown>)) {
    if (!userIds.has(owner) || !Array.isArray(messages)) reject('invalid_message_owner');
    for (const message of messages) {
      if (!object(message) || message.userId !== owner || typeof message.id !== 'string' || !message.id.trim()
        || messageIds.has(message.id) || typeof message.text !== 'string' || typeof message.timestamp !== 'string'
        || !['user', 'bot'].includes(message.sender as string)) reject('invalid_legacy_message');
      messageIds.add(message.id);
      timestamp(message.timestamp, false);
      if (message.buttons !== undefined && (!Array.isArray(message.buttons) || message.buttons.some(button =>
        !object(button) || typeof button.text !== 'string' || typeof button.action !== 'string'))) reject('invalid_message_buttons');
    }
  }
  counts.botMessages = messageIds.size;
  const runtimeCollections: Record<string, { rows: number; byStatus: Record<string, number>; checksum: string }> = {};
  for (const name of ['pendingImportantNotifications', 'notificationDeliveries', 'telegramInbox']) {
    const rows = state.settings[name];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) reject('invalid_legacy_runtime_collection');
    const ids = new Set<unknown>(), dedupe = new Set<string>();
    const byStatus: Record<string, number> = {};
    for (const row of rows) {
      if (!object(row) || !Number.isSafeInteger(row.attempts) || (row.attempts as number) < 0) reject('invalid_legacy_runtime_row');
      const inbox = name === 'telegramInbox', pending = name === 'pendingImportantNotifications';
      const id = inbox ? row.updateId : row.id;
      if (inbox ? !Number.isSafeInteger(id) || (id as number) < 0 : typeof id !== 'string' || !id.trim()) reject('invalid_legacy_runtime_id');
      if (ids.has(id)) reject('duplicate_legacy_runtime_id');
      ids.add(id);
      const statuses = inbox ? ['received', 'processing', 'retry', 'completed', 'failed'] : ['planned', 'sending', 'sent', 'retry', 'failed', 'unknown', 'cancelled', 'expired'];
      const status = pending ? 'legacy_pending' : row.status;
      if (typeof status !== 'string' || (!pending && !statuses.includes(status))) reject('invalid_legacy_runtime_status');
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      for (const field of pending ? ['createdAt'] : inbox ? ['receivedAt', 'availableAt', 'updatedAt'] : ['intendedAt', 'availableAt', 'updatedAt']) timestamp(row[field], false);
      for (const field of ['lastAttemptAt', 'leasedUntil', 'sentAt', 'expiresAt', 'processedAt']) timestamp(row[field]);
      if (inbox) {
        if (!object(row.payload) || typeof row.chatKey !== 'string' || !row.chatKey) reject('invalid_legacy_inbox_source');
      } else if (typeof row.text !== 'string' || !row.text) reject('invalid_legacy_runtime_text');
      if (pending && typeof row.silent !== 'boolean') reject('invalid_legacy_runtime_silent');
      if (name === 'notificationDeliveries') {
        if (typeof row.chatId !== 'string' || !row.chatId || typeof row.dedupeKey !== 'string' || !row.dedupeKey) reject('invalid_legacy_delivery_source');
        if (dedupe.has(row.dedupeKey)) reject('duplicate_legacy_delivery_dedupe');
        dedupe.add(row.dedupeKey);
      }
    }
    runtimeCollections[name] = { rows: rows.length, byStatus, checksum: digest(JSON.stringify(canonical(rows))) };
  }
  if (settings.idempotencyRecords !== undefined) {
    if (!Array.isArray(settings.idempotencyRecords)) reject('invalid_legacy_idempotency');
    const keys = new Set<string>(), byStatus: Record<string, number> = {};
    for (const record of settings.idempotencyRecords) {
      if (!object(record)) reject('invalid_legacy_idempotency');
      for (const field of ['actorId', 'key', 'operation'])
        if (typeof record[field] !== 'string' || !(record[field] as string).trim()) reject('invalid_legacy_idempotency');
      if (typeof record.bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.bodyHash)
        || !['processing', 'completed'].includes(record.status as string)) reject('invalid_legacy_idempotency');
      const key = JSON.stringify([record.actorId, record.key]);
      if (keys.has(key)) reject('duplicate_legacy_idempotency');
      keys.add(key);
      timestamp(record.createdAt, false);
      timestamp(record.completedAt, record.status !== 'completed');
      if (record.responseStatus !== undefined && (!Number.isInteger(record.responseStatus) || (record.responseStatus as number) < 100 || (record.responseStatus as number) > 599)) reject('invalid_legacy_idempotency_response');
      if (record.status === 'completed' && record.responseStatus === undefined) reject('missing_legacy_idempotency_response');
      const status = record.status as string;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    runtimeCollections.idempotencyRecords = { rows: settings.idempotencyRecords.length, byStatus,
      checksum: digest(JSON.stringify(canonical(settings.idempotencyRecords))) };
  }
  const runtimeInventory = { format: 'legacy-runtime-quarantine-v1', replayAllowed: false, collections: runtimeCollections };
  const entityHashes: Record<string, string> = {};
  for (const name of ['users', 'meetings', 'tasks', 'events', 'faculties', 'competencies', 'facultyCompetencies', 'availabilities', 'messages', 'settings']) {
    if (state[name] === undefined) continue;
    let value = state[name];
    if (['users', 'meetings', 'tasks', 'events', 'faculties'].includes(name)) {
      value = [...value as Record<string, unknown>[]].sort((a, b) => (a.id as string) < (b.id as string) ? -1 : (a.id === b.id ? 0 : 1));
    }
    entityHashes[name] = digest(JSON.stringify(canonical(value)));
  }
  const availabilityProjection = datedAvailability(state.availabilities as Record<string, unknown>);
  const meetingProjection = (state.meetings as Record<string, unknown>[]).map(meeting => {
    const kind = normalizeMeetingKind(meeting.kind);
    const instant = projectDateTimeInstant(meeting.date as string, meeting.time as string);
    if (!instant || !Number.isFinite(instant.getTime())) reject('invalid_legacy_meeting_instant');
    const [hour, minute] = (meeting.time as string).split(':').map(Number);
    const targetClockCompatible = matchesMoscowWallClock(instant, meeting.date as string, hour, minute);
    return { sourceId: meeting.id as string, startsAt: instant.toISOString(), zoneId: PROJECT_TIME_ZONE,
      sourceOffsetMinutes: PROJECT_UTC_OFFSET_MINUTES, targetClockCompatible,
      durationMinutes: (meeting.duration as number) * 60, kind, status: meeting.status, hostId: meeting.hostId,
      sourceCalendarEventId: meeting.googleCalendarEventId ?? null,
      audienceUserIds: meeting.audiencePolicy === 'snapshot' ? [...meeting.audienceUserIds as string[]].sort() : null,
      targetTemporalCompatible: targetClockCompatible && !meetingDurationError(kind, meeting.duration as number) && (kind !== 'setup' || Boolean(meeting.eventId)) };
  }).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  const meetingProjectionSummary = { format: 'legacy-meeting-temporal-v1', meetings: meetingProjection.length,
    unresolvedAudiences: meetingProjection.filter(row => row.audienceUserIds === null).length,
    incompatibleTemporalRows: meetingProjection.filter(row => !row.targetTemporalCompatible).length,
    checksum: digest(JSON.stringify(canonical(meetingProjection))) };
  const taskProjection = (state.tasks as Record<string, unknown>[]).map(task => {
    const due = projectDateDeadlineInstant(task.deadline as string);
    if (!due || !Number.isFinite(due.getTime())) reject('invalid_legacy_task_due_instant');
    const completedAt = task.completedAt || null, cancelledAt = task.cancelledAt || null;
    return { sourceId: task.id as string, legacyDeadline: task.deadline, dueAt: due.toISOString(),
      policy: 'date-only-end-of-day-msk', sourceOffsetMinutes: PROJECT_UTC_OFFSET_MINUTES, status: task.status,
      createdAt: task.createdAt || null, completedAt, cancelledAt,
      targetClockCompatible: matchesMoscowWallClock(due, task.deadline as string, 23, 59),
      targetHistoryComplete: Boolean(task.createdAt) && (task.status === 'completed') === Boolean(completedAt)
        && (task.status === 'cancelled') === Boolean(cancelledAt) };
  }).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  const taskProjectionSummary = { format: 'legacy-task-deadline-v1', policyDecision: 'owner-2026-10-18-end-of-day-msk', tasks: taskProjection.length,
    clockReviewRows: taskProjection.filter(row => !row.targetClockCompatible).length,
    incompleteHistoryRows: taskProjection.filter(row => !row.targetHistoryComplete).length,
    checksum: digest(JSON.stringify(canonical(taskProjection))) };
  birthdays.sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  historicalAuthors.sort((a, b) => {
    const left = JSON.stringify([a.entity, a.entityId, a.field]), right = JSON.stringify([b.entity, b.entityId, b.field]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const identityProjection = { birthdays, historicalAuthors };
  const identityProjectionSummary = { format: 'legacy-identity-attribution-v1', users: birthdays.length,
    authorReferences: historicalAuthors.length, unresolvedAuthors: historicalAuthors.filter(row => row.userId === null).length,
    inactiveWithoutTimestamp: (state.users as Record<string, unknown>[]).filter(row => row.active === false && !row.deactivatedAt).length,
    contradictoryActiveRows: (state.users as Record<string, unknown>[]).filter(row => row.active === true && Boolean(row.deactivatedAt)).length,
    primaryOutsideMembershipRows: (state.users as Record<string, unknown>[]).filter(row => Boolean(row.primaryCompetency)
      && !((row.competencies ?? []) as string[]).includes(row.primaryCompetency as string)).length,
    checksum: digest(JSON.stringify(canonical(identityProjection))) };
  const availabilityProjectionSummary = { format: 'legacy-dated-availability-v1', users: availabilityProjection.length,
    days: availabilityProjection.reduce((sum, row) => sum + row.slots.length, 0),
    slots: availabilityProjection.reduce((sum, row) => sum + row.slots.reduce((total, day) => total + day.hours.length, 0), 0),
    hardUnavailableDays: availabilityProjection.reduce((sum, row) => sum + row.hardUnavailableDates.length, 0),
    outWeeks: availabilityProjection.reduce((sum, row) => sum + row.outWeekStarts.length, 0),
    checksum: digest(JSON.stringify(canonical(availabilityProjection))) };
  return { sourceKind: recovery ? 'recovery-record-v1' : 'sheets-backup-state', revision: expectedRevision,
    checksum, fileChecksum: digest(raw), counts, fingerprintFormat: 'legacy-source-entities-v1', entityHashes,
    availabilityProjectionSummary, availabilityProjection, identityProjectionSummary, identityProjection,
    meetingProjectionSummary, meetingProjection, taskProjectionSummary, taskProjection, runtimeInventory, state };
}
