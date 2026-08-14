import type { SimulationState, Task, User } from './types.js';
import { filterSlotsByAvailabilityConfig, normalizeAvailabilityConfig } from './availabilityConfig.js';

const text = (value: unknown) => value == null ? '' : String(value);
const optionalText = (value: unknown) => text(value) || undefined;

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

export function sanitizeSimulationState(input: SimulationState): SimulationState {
  const users = (input.users || []).map(cleanUser);
  const userIds = new Set(users.map((user) => user.id));
  const availabilityConfig = normalizeAvailabilityConfig(input.settings);
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
    databaseRevision: Math.max(0, Number(input.settings?.databaseRevision || 0)),
  };
  return {
    users,
    faculties: (input.faculties || []).map((faculty) => ({ id: text(faculty.id), name: text(faculty.name) })),
    facultyCompetencies: [...new Set((input.facultyCompetencies || []).map(String).filter(Boolean))],
    competencies: [...new Set((input.competencies || []).map(String).filter(Boolean))],
    availabilities: Object.fromEntries(Object.entries(input.availabilities || {})
      .filter(([userId]) => userIds.has(userId))
      .map(([userId, availability]) => [userId, {
        userId,
        slots: filterSlotsByAvailabilityConfig(availability.slots, cleanSettings),
        hardUnavailableDays: [...new Set((availability.hardUnavailableDays || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b),
        outWeekIndexes: [...new Set((availability.outWeekIndexes || []).map(Number).filter((weekIndex) => (
          Number.isInteger(weekIndex) && weekIndex >= 0 && weekIndex < cleanSettings.availabilityWeekCount!
        )))].sort((a, b) => a - b),
        updatedAt: text(availability.updatedAt),
        weekStart: optionalText(availability.weekStart),
      }])),
    meetings: (input.meetings || []).map((meeting) => ({
      id: text(meeting.id), title: text(meeting.title), type: meeting.type, date: text(meeting.date), time: text(meeting.time),
      duration: Number(meeting.duration), hostId: text(meeting.hostId),
      participants: meeting.participants === 'all' ? 'all' : [...new Set((meeting.participants || []).map(String).filter(Boolean))],
      attendeeIds: [...new Set((meeting.attendeeIds || []).map(String).filter(Boolean))],
      competency: text(meeting.competency), topic: text(meeting.topic), description: text(meeting.description), status: meeting.status,
      googleCalendarEventId: optionalText(meeting.googleCalendarEventId),
    })),
    events: (input.events || []).map((event) => ({
      id: text(event.id), name: text(event.name), description: optionalText(event.description), startsAt: optionalText(event.startsAt),
      endsAt: optionalText(event.endsAt), status: event.status, createdAt: text(event.createdAt), createdBy: optionalText(event.createdBy),
    })),
    tasks: (input.tasks || []).map(cleanTask),
    messages: Object.fromEntries(Object.entries(input.messages || {}).filter(([userId]) => userIds.has(userId)).map(([userId, messages]) => [userId, (messages || []).map((message) => ({
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
    settings: { ...state.settings, databaseRevision: Number(state.settings?.databaseRevision || 0) + 1 },
  };
}
