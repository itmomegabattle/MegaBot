import type { SimulationState, Task, User } from './types.js';

export type OrphanReference = {
  entity: 'availability' | 'event' | 'meeting' | 'message' | 'task';
  entityId: string;
  field: string;
  userId: string;
};

export type UserDeactivationImpact = {
  activeTaskIds: string[];
  hostedScheduledMeetingIds: string[];
};

export function isUserActive(user?: User) {
  return Boolean(user && user.active !== false && !user.deactivatedAt);
}

function isUnfinishedTask(task: Task) {
  return task.status !== 'completed' && task.status !== 'cancelled';
}

export function userDeactivationImpact(state: SimulationState, userId: string): UserDeactivationImpact {
  return {
    activeTaskIds: state.tasks
      .filter((task) => isUnfinishedTask(task) && (task.assignedTo || []).includes(userId))
      .map((task) => task.id),
    hostedScheduledMeetingIds: state.meetings
      .filter((meeting) => meeting.status === 'scheduled' && meeting.hostId === userId)
      .map((meeting) => meeting.id),
  };
}

export function deactivateUser(
  state: SimulationState,
  userId: string,
  actorId: string,
  confirmedTaskRelease = false,
) {
  const user = state.users.find((candidate) => candidate.id === userId);
  if (!user) return { ok: false as const, status: 404, error: 'Участник не найден' };
  if (!isUserActive(user)) return { ok: true as const, user, impact: userDeactivationImpact(state, userId) };

  if (user.role === 'admin') {
    const activeAdminCount = state.users.filter((candidate) => candidate.role === 'admin' && isUserActive(candidate)).length;
    if (activeAdminCount <= 1) {
      return { ok: false as const, status: 409, error: 'Нельзя деактивировать последнего активного администратора' };
    }
  }

  const impact = userDeactivationImpact(state, userId);
  if (impact.hostedScheduledMeetingIds.length) {
    return {
      ok: false as const,
      status: 409,
      error: 'Сначала назначьте другого организатора для будущих встреч',
      code: 'scheduled_meetings_require_reassignment',
      impact,
    };
  }
  if (impact.activeTaskIds.length && !confirmedTaskRelease) {
    return {
      ok: false as const,
      status: 409,
      error: 'У участника есть незавершённые задачи. Подтвердите возврат этих задач в работу.',
      code: 'active_tasks_require_confirmation',
      impact,
    };
  }

  if (confirmedTaskRelease) {
    state.tasks.forEach((task) => {
      if (!isUnfinishedTask(task) || !(task.assignedTo || []).includes(userId)) return;
      const remaining = (task.assignedTo || []).filter((id) => id !== userId);
      task.assignedTo = remaining.length ? remaining : null;
      if (!remaining.length) task.status = 'open';
      task.version = Number(task.version || 1) + 1;
    });
  }

  user.active = false;
  user.deactivatedAt = new Date().toISOString();
  user.deactivatedBy = actorId;
  user.registered = false;
  return { ok: true as const, user, impact };
}

export function findOrphanUserReferences(state: SimulationState): OrphanReference[] {
  const userIds = new Set(state.users.map((user) => user.id));
  const orphans: OrphanReference[] = [];
  const add = (entity: OrphanReference['entity'], entityId: string, field: string, userId?: string) => {
    if (userId && !userIds.has(userId)) orphans.push({ entity, entityId, field, userId });
  };

  Object.entries(state.availabilities || {}).forEach(([userId]) => add('availability', userId, 'userId', userId));
  Object.entries(state.messages || {}).forEach(([userId, messages]) => {
    add('message', userId, 'ownerId', userId);
    messages.forEach((message) => add('message', message.id, 'userId', message.userId));
  });
  (state.events || []).forEach((event) => add('event', event.id, 'createdBy', event.createdBy));
  state.meetings.forEach((meeting) => {
    add('meeting', meeting.id, 'hostId', meeting.hostId);
    if (meeting.participants !== 'all') meeting.participants.forEach((id) => add('meeting', meeting.id, 'participants', id));
    (meeting.attendeeIds || []).forEach((id) => add('meeting', meeting.id, 'attendeeIds', id));
    Object.keys(meeting.rsvpByUser || {}).forEach((id) => add('meeting', meeting.id, 'rsvpByUser', id));
  });
  state.tasks.forEach((task) => {
    add('task', task.id, 'creatorId', task.creatorId);
    add('task', task.id, 'completedBy', task.completedBy);
    add('task', task.id, 'cancelledBy', task.cancelledBy);
    (task.assignedTo || []).forEach((id) => add('task', task.id, 'assignedTo', id));
    Object.entries(task.assigneeNotes || {}).forEach(([ownerId, note]) => {
      add('task', task.id, 'assigneeNotes', ownerId);
      (note.history || []).forEach((comment) => add('task', task.id, 'assigneeNotes.history.authorId', comment.authorId));
    });
    Object.keys(task.completionComments || {}).forEach((id) => add('task', task.id, 'completionComments', id));
  });
  return orphans;
}
