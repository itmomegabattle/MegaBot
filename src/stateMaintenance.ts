import type { SimulationState, Task, User } from './types.js';

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
  const assignees = [...new Set((task.assignedTo || []).map(String).filter(Boolean))];
  return {
    id: text(task.id),
    title: text(task.title),
    description: text(task.description),
    deadline: text(task.deadline),
    assignedTo: assignees.length ? assignees : null,
    creatorId: optionalText(task.creatorId),
    competency: text(task.competency),
    sow: text(task.sow),
    tips: Array.isArray(task.tips) ? task.tips.map(String) : [],
    status: task.status,
    priority: task.priority,
    createdAt: optionalText(task.createdAt),
    completedAt: optionalText(task.completedAt),
    timeSpentMinutes: Number.isFinite(Number(task.timeSpentMinutes)) ? Number(task.timeSpentMinutes) : undefined,
    facultyId: text(task.facultyId),
    eventId: text(task.eventId),
    reminders: (task.reminders || []).map((reminder) => ({
      id: text(reminder.id), type: reminder.type, value: Number(reminder.value), unit: reminder.unit,
      sentAt: optionalText(reminder.sentAt), lastSentAt: optionalText(reminder.lastSentAt),
    })),
    assigneeNotes: Object.fromEntries(Object.entries(task.assigneeNotes || {}).map(([userId, note]) => [userId, {
      executor: optionalText(note.executor), coordinator: optionalText(note.coordinator), updatedAt: optionalText(note.updatedAt),
    }])),
    completionComments: Object.fromEntries(Object.entries(task.completionComments || {}).map(([userId, comment]) => [userId, text(comment)])),
  };
}

export function sanitizeSimulationState(input: SimulationState): SimulationState {
  const users = (input.users || []).map(cleanUser);
  const userIds = new Set(users.map((user) => user.id));
  return {
    users,
    faculties: (input.faculties || []).map((faculty) => ({ id: text(faculty.id), name: text(faculty.name) })),
    facultyCompetencies: [...new Set((input.facultyCompetencies || []).map(String).filter(Boolean))],
    competencies: [...new Set((input.competencies || []).map(String).filter(Boolean))],
    availabilities: Object.fromEntries(Object.entries(input.availabilities || {})
      .filter(([userId]) => userIds.has(userId))
      .map(([userId, availability]) => [userId, {
        userId,
        slots: Object.fromEntries(Object.entries(availability.slots || {}).map(([day, hours]) => [Number(day), [...new Set((hours || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b)])),
        hardUnavailableDays: [...new Set((availability.hardUnavailableDays || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b),
        updatedAt: text(availability.updatedAt),
        weekStart: optionalText(availability.weekStart),
      }])),
    meetings: (input.meetings || []).map((meeting) => ({
      id: text(meeting.id), title: text(meeting.title), type: meeting.type, date: text(meeting.date), time: text(meeting.time),
      duration: Number(meeting.duration), hostId: text(meeting.hostId),
      participants: meeting.participants === 'all' ? 'all' : [...new Set((meeting.participants || []).map(String).filter(Boolean))],
      attendeeIds: [...new Set((meeting.attendeeIds || []).map(String).filter(Boolean))],
      competency: text(meeting.competency), topic: text(meeting.topic), description: text(meeting.description), status: meeting.status,
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
    settings: {
      teamChatId: optionalText(input.settings?.teamChatId),
      availabilityWeekCount: Math.max(2, Number(input.settings?.availabilityWeekCount || 2)),
      databaseRevision: Math.max(0, Number(input.settings?.databaseRevision || 0)),
    },
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
