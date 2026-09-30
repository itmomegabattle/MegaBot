import { normalizeMeetingKind } from './meetingKind.js';
import { normalizedMeetingRsvps } from './meetingRsvp.js';
import type { Availability, SimulationState, Task, User } from './types.js';
import { alignAvailabilityToWeek, currentAvailabilityWeekStart, filterSlotsByAvailabilityConfig, normalizeAvailabilityConfig } from './availabilityConfig.js';
import { snapshotMeetingAudienceUserIds } from './audiencePolicy.js';

const text = (value: unknown) => value == null ? '' : String(value);
const optionalText = (value: unknown) => text(value) || undefined;

export function mergePrimarySheetAvailability(
  previous: Availability | undefined,
  imported: Availability & { coveredOutWeekIndexes?: number[] },
  weekStart = currentAvailabilityWeekStart(),
): Availability {
  const aligned = alignAvailabilityToWeek(previous, weekStart);
  // A Google request can straddle midnight. Wait for a fresh import in that case.
  if (imported.weekStart !== weekStart) {
    return { ...previous, ...aligned, userId: imported.userId, updatedAt: previous?.updatedAt || imported.updatedAt };
  }
  const coveredDays = new Set(Object.keys(imported.slots || {})
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0));
  const slots = { ...aligned.slots };
  coveredDays.forEach((day) => {
    const hours = imported.slots?.[day] || [];
    if (hours.length) slots[day] = [...hours];
    else delete slots[day];
  });
  const hardUnavailableDays = aligned.hardUnavailableDays.filter((day) => (
    !coveredDays.has(day) || !(imported.slots?.[day] || []).length
  ));
  for (const day of imported.hardUnavailableDays || []) {
    if (coveredDays.has(day) && !hardUnavailableDays.includes(day)) hardUnavailableDays.push(day);
  }
  const coveredOutWeeks = new Set(imported.coveredOutWeekIndexes || []);
  const outWeekIndexes = aligned.outWeekIndexes.filter((index) => !coveredOutWeeks.has(index));
  for (const index of imported.outWeekIndexes || []) {
    if (coveredOutWeeks.has(index) && !outWeekIndexes.includes(index)) outWeekIndexes.push(index);
  }
  const { coveredOutWeekIndexes: _coveredOutWeekIndexes, ...importedAvailability } = imported;
  return {
    ...previous,
    ...importedAvailability,
    slots,
    hardUnavailableDays: hardUnavailableDays.sort((a, b) => a - b),
    outWeekIndexes: outWeekIndexes.sort((a, b) => a - b),
  };
}

function cleanUser(user: User): User {
  const role = ['admin', 'organizer', 'faculty_responsible', 'faculty_helper'].includes(String(user.role)) ? user.role : 'organizer';
  const competencies = [...new Set((user.competencies || []).map(String).filter(Boolean))];
  const primaryCompetency = text(user.primaryCompetency || competencies[0]);
  return {
    id: text(user.id),
    username: text(user.username),
    realName: text(user.realName),
    role,
    avatarSeed: text(user.avatarSeed || user.id),
    avatarDataUrl: /^data:image\/(?:jpeg|png|webp);base64,/i.test(text(user.avatarDataUrl)) && text(user.avatarDataUrl).length <= 300_000
      ? text(user.avatarDataUrl)
      : undefined,
    birthday: optionalText(user.birthday),
    telegramId: optionalText(user.telegramId),
    registered: Boolean(user.registered),
    competencies: primaryCompetency && !competencies.includes(primaryCompetency) ? [primaryCompetency, ...competencies] : competencies,
    primaryCompetency,
    facultyId: text(user.facultyId),
    joinedAt: text(user.joinedAt),
    lastSeenAt: text(user.lastSeenAt),
    active: user.active !== false && !user.deactivatedAt,
    deactivatedAt: optionalText(user.deactivatedAt),
    deactivatedBy: optionalText(user.deactivatedBy),
  };
}

function cleanTask(task: Task): Task {
  const rawAssignees = Array.isArray(task.assignedTo) ? task.assignedTo : task.assignedTo ? [task.assignedTo] : [];
  const rawCompetencies = Array.isArray(task.competencies) ? task.competencies : task.competency ? [task.competency] : [];
  const assignees = [...new Set(rawAssignees.map(String).filter(Boolean))];
  const competencies = [...new Set(rawCompetencies.map(String).filter(Boolean))];
  const assigneeNotes = Object.fromEntries(Object.entries(task.assigneeNotes || {}).map(([userId, note]) => [userId, {
    executor: optionalText(note.executor),
    coordinator: optionalText(note.coordinator),
    updatedAt: optionalText(note.updatedAt),
    history: (note.history || []).map((comment) => ({
      id: text(comment.id),
      authorId: text(comment.authorId),
      side: comment.side === 'coordinator' ? 'coordinator' as const : 'executor' as const,
      text: text(comment.text),
      createdAt: text(comment.createdAt),
    })).filter((comment) => comment.id && comment.authorId && comment.text),
  }]));
  return {
    id: text(task.id),
    version: Math.max(1, Math.floor(Number(task.version) || 1)),
    title: text(task.title),
    description: text(task.description),
    deadline: text(task.deadline),
    assignedTo: assignees.length ? assignees : null,
    creatorId: optionalText(task.creatorId),
    competency: competencies[0] || '',
    competencies,
    sow: text(task.sow),
    tips: Array.isArray(task.tips) ? task.tips.map(String) : [],
    status: task.status,
    priority: task.priority,
    createdAt: optionalText(task.createdAt),
    completedAt: optionalText(task.completedAt),
    assignmentMode: 'shared',
    completedBy: optionalText(task.completedBy),
    cancelledAt: optionalText(task.cancelledAt),
    cancelledBy: optionalText(task.cancelledBy),
    timeSpentMinutes: Number.isFinite(Number(task.timeSpentMinutes)) ? Number(task.timeSpentMinutes) : undefined,
    facultyId: text(task.facultyId),
    eventId: text(task.eventId),
    reminders: (task.reminders || []).map((reminder) => ({
      id: text(reminder.id), type: reminder.type, value: Number(reminder.value), unit: reminder.unit,
      sentAt: optionalText(reminder.sentAt), lastSentAt: optionalText(reminder.lastSentAt),
    })),
    assigneeNotes,
    completionComments: Object.fromEntries(Object.entries(task.completionComments || {}).map(([userId, comment]) => [userId, text(comment)])),
  };
}

export function sanitizeSimulationState(input: SimulationState, baseWeekStart = currentAvailabilityWeekStart()): SimulationState {
  const users = (input.users || []).map(cleanUser);
  const availabilityConfig = normalizeAvailabilityConfig(input.settings, baseWeekStart);
  const requestedWeekCount = Number(input.settings?.availabilityWeekCount);
  const cleanSettings: SimulationState['settings'] = {
    teamChatId: optionalText(input.settings?.teamChatId),
    teamImportantThreadId: Number.isInteger(Number(input.settings?.teamImportantThreadId))
      && Number(input.settings?.teamImportantThreadId) > 0
      ? Number(input.settings?.teamImportantThreadId)
      : undefined,
    availabilityWeekCount: Number.isInteger(requestedWeekCount) && requestedWeekCount >= 2 && requestedWeekCount <= 5 ? requestedWeekCount : 2,
    availabilityActiveDays: availabilityConfig.activeDays,
    availabilityStartHour: availabilityConfig.startHour,
    availabilityEndHour: availabilityConfig.endHour,
    availabilityWeekNames: availabilityConfig.weekNames,
    availabilityWeekDescriptions: availabilityConfig.weekDescriptions,
    availabilityWeekMetadata: availabilityConfig.weekMetadata,
    availabilityWeekStart: baseWeekStart,
    pendingImportantNotifications: (input.settings?.pendingImportantNotifications || [])
      .filter((item) => item && text(item.id) && text(item.text))
      .map((item) => ({
        id: text(item.id), text: text(item.text), silent: Boolean(item.silent),
        createdAt: text(item.createdAt) || new Date().toISOString(),
        attempts: Math.max(0, Number(item.attempts || 0)),
        lastAttemptAt: optionalText(item.lastAttemptAt),
      })),
    notificationDeliveries: (input.settings?.notificationDeliveries || [])
      .filter((item) => item && text(item.id) && text(item.dedupeKey) && text(item.chatId) && text(item.text))
      .map((item) => ({
        id: text(item.id), dedupeKey: text(item.dedupeKey), category: text(item.category) || 'notification',
        recipientId: optionalText(item.recipientId), chatId: text(item.chatId), text: text(item.text),
        replyMarkup: item.replyMarkup && typeof item.replyMarkup === 'object' && !Array.isArray(item.replyMarkup)
          ? item.replyMarkup : undefined,
        messageThreadId: Number.isInteger(Number(item.messageThreadId)) && Number(item.messageThreadId) > 0
          ? Number(item.messageThreadId) : undefined,
        disableNotification: Boolean(item.disableNotification), disableWebPagePreview: Boolean(item.disableWebPagePreview),
        intendedAt: text(item.intendedAt) || new Date().toISOString(),
        availableAt: text(item.availableAt) || text(item.intendedAt) || new Date().toISOString(),
        expiresAt: optionalText(item.expiresAt),
        status: (['planned', 'sending', 'sent', 'retry', 'failed', 'unknown', 'cancelled', 'expired'].includes(item.status)
          ? item.status : 'planned') as import('./types.js').NotificationDeliveryStatus,
        attempts: Math.max(0, Number(item.attempts || 0)), leaseToken: optionalText(item.leaseToken),
        leasedUntil: optionalText(item.leasedUntil), lastAttemptAt: optionalText(item.lastAttemptAt),
        lastErrorCode: optionalText(item.lastErrorCode), lastErrorMessage: optionalText(item.lastErrorMessage),
        telegramMessageId: Number.isInteger(Number(item.telegramMessageId)) ? Number(item.telegramMessageId) : undefined,
        sentAt: optionalText(item.sentAt), updatedAt: text(item.updatedAt) || new Date().toISOString(),
      })),
    telegramInbox: (input.settings?.telegramInbox || [])
      .filter((item) => item && Number.isSafeInteger(Number(item.updateId)) && Number(item.updateId) >= 0
        && item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload))
      .map((item) => ({
        updateId: Number(item.updateId), chatKey: text(item.chatKey) || 'unknown',
        payload: item.payload as Record<string, unknown>,
        status: (['received', 'processing', 'retry', 'completed', 'failed'].includes(item.status)
          ? item.status : 'received') as import('./types.js').TelegramInboxStatus,
        receivedAt: text(item.receivedAt) || new Date().toISOString(),
        availableAt: text(item.availableAt) || text(item.receivedAt) || new Date().toISOString(),
        attempts: Math.max(0, Number(item.attempts || 0)), leaseToken: optionalText(item.leaseToken),
        leasedUntil: optionalText(item.leasedUntil), lastAttemptAt: optionalText(item.lastAttemptAt),
        lastError: optionalText(item.lastError), processedAt: optionalText(item.processedAt),
        updatedAt: text(item.updatedAt) || new Date().toISOString(),
      })),
    databaseRevision: Math.max(0, Number(input.settings?.databaseRevision || 0)),
    idempotencyRecords: (input.settings?.idempotencyRecords || [])
      .filter((record) => record && text(record.key) && text(record.actorId) && text(record.operation) && /^[a-f0-9]{64}$/.test(text(record.bodyHash)))
      .map((record) => ({
        key: text(record.key), actorId: text(record.actorId), operation: text(record.operation), bodyHash: text(record.bodyHash),
        status: record.status === 'completed' ? 'completed' as const : 'processing' as const,
        responseStatus: Number.isInteger(Number(record.responseStatus)) ? Number(record.responseStatus) : undefined,
        responseBody: record.responseBody,
        createdAt: text(record.createdAt), completedAt: optionalText(record.completedAt),
      })),
  };
  return {
    users,
    faculties: (input.faculties || []).map((faculty) => ({ id: text(faculty.id), name: text(faculty.name) })),
    facultyCompetencies: [...new Set((input.facultyCompetencies || []).map(String).filter(Boolean))],
    competencies: [...new Set((input.competencies || []).map(String).filter(Boolean))],
    availabilities: Object.fromEntries(Object.entries(input.availabilities || {})
      .map(([userId, availability]) => {
        const aligned = alignAvailabilityToWeek(availability, baseWeekStart, availabilityConfig.weekCount);
        return [userId, {
          userId,
          slots: filterSlotsByAvailabilityConfig(aligned.slots, cleanSettings),
          hardUnavailableDays: [...new Set(aligned.hardUnavailableDays)].sort((a, b) => a - b),
          outWeekIndexes: [...new Set(aligned.outWeekIndexes)].sort((a, b) => a - b),
          weekVersions: Object.fromEntries(availabilityConfig.weekStarts.map((weekStart) => [
            weekStart,
            Math.max(0, Math.floor(Number(availability.weekVersions?.[weekStart] || 0))),
          ])),
          updatedAt: text(availability.updatedAt),
          weekStart: baseWeekStart,
        }];
      })),
    meetings: (input.meetings || []).map((meeting) => {
      const rsvpByUser = normalizedMeetingRsvps(meeting);
      const participants = meeting.participants === 'all'
        ? 'all' as const
        : [...new Set((meeting.participants || []).map(String).filter(Boolean))];
      const audienceUserIds = meeting.audiencePolicy === 'snapshot'
        ? [...new Set((meeting.audienceUserIds || []).map(String).filter(Boolean))]
        : snapshotMeetingAudienceUserIds(users, participants, text(meeting.hostId));
      return {
        id: text(meeting.id), title: text(meeting.title), kind: normalizeMeetingKind(meeting.kind),
        eventId: optionalText(meeting.eventId), type: meeting.type, date: text(meeting.date), time: text(meeting.time),
        duration: Number(meeting.duration), hostId: text(meeting.hostId),
        participants,
        audiencePolicy: 'snapshot' as const,
        audienceUserIds,
        attendeeIds: Object.entries(rsvpByUser).filter(([, response]) => response === 'yes').map(([userId]) => userId),
        rsvpByUser,
        competency: text(meeting.competency), topic: text(meeting.topic), description: text(meeting.description), status: meeting.status,
        googleCalendarEventId: optionalText(meeting.googleCalendarEventId),
      };
    }),
    events: (input.events || []).map((event) => ({
      id: text(event.id), name: text(event.name), description: optionalText(event.description), startsAt: optionalText(event.startsAt),
      endsAt: optionalText(event.endsAt), status: event.status, createdAt: text(event.createdAt), createdBy: optionalText(event.createdBy),
    })),
    tasks: (input.tasks || []).map(cleanTask),
    messages: Object.fromEntries(Object.entries(input.messages || {}).map(([userId, messages]) => [userId, (messages || []).map((message) => ({
      id: text(message.id), userId, sender: message.sender, text: text(message.text), timestamp: text(message.timestamp),
      buttons: (message.buttons || []).map((button) => ({ text: text(button.text), action: text(button.action) })),
    }))])),
    settings: cleanSettings,
  };
}

export function resetOperationalData(input: SimulationState): SimulationState {
  const state = sanitizeSimulationState({ ...input, availabilities: {}, meetings: [], events: [], tasks: [], messages: {} });
  return {
    ...state,
    users: state.users.map((user) => ({ ...user, joinedAt: '', lastSeenAt: '' })),
    availabilities: {},
    meetings: [],
    events: [],
    tasks: [],
    messages: {},
    settings: { ...state.settings, pendingImportantNotifications: [], databaseRevision: Number(state.settings?.databaseRevision || 0) + 1 },
  };
}
