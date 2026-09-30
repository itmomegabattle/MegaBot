import type { Meeting, Task, User } from './types.js';

export function isFacultyAudienceUser(user?: Pick<User, 'role'>) {
  return user?.role === 'faculty_responsible' || user?.role === 'faculty_helper';
}

export function isActiveAudienceUser(user?: Pick<User, 'active'>) {
  return Boolean(user) && user!.active !== false;
}

export function activeCoreTeamUsers(users: User[]) {
  return users.filter((user) => isActiveAudienceUser(user) && !isFacultyAudienceUser(user));
}

export function activeFacultyUsers(users: User[], facultyId?: string) {
  return users.filter((user) => (
    isActiveAudienceUser(user)
    && isFacultyAudienceUser(user)
    && (!facultyId || facultyId === 'all' || user.facultyId === facultyId)
  ));
}

function uniqueUsers(users: User[]) {
  return [...new Map(users.map((user) => [user.id, user])).values()];
}

export function snapshotMeetingAudienceUserIds(
  users: User[],
  participants: Meeting['participants'],
  hostId: string,
) {
  const coreUsers = activeCoreTeamUsers(users);
  const requestedIds = participants === 'all' ? undefined : new Set(participants);
  return uniqueUsers(coreUsers.filter((user) => (
    participants === 'all' || requestedIds!.has(user.id) || user.id === hostId
  ))).map((user) => user.id);
}

export function resolveMeetingAudienceUsers(users: User[], meeting: Pick<Meeting, 'participants' | 'hostId' | 'audiencePolicy' | 'audienceUserIds'>) {
  const allowed = new Map(activeCoreTeamUsers(users).map((user) => [user.id, user]));
  const ids = meeting.audiencePolicy === 'snapshot'
    ? meeting.audienceUserIds || []
    : snapshotMeetingAudienceUserIds(users, meeting.participants, meeting.hostId);
  return uniqueUsers(ids.map((id) => allowed.get(id)).filter(Boolean) as User[]);
}

export function resolveTaskAudienceUsers(users: User[], task: Pick<Task, 'assignedTo' | 'facultyId'>) {
  const scopedUsers = task.facultyId
    ? activeFacultyUsers(users, task.facultyId)
    : activeCoreTeamUsers(users);
  const assignedIds = new Set(task.assignedTo || []);
  return task.assignedTo?.length
    ? scopedUsers.filter((user) => assignedIds.has(user.id))
    : scopedUsers;
}

export function sanitizeTaskAssigneeIds(users: User[], requestedIds: unknown[], facultyId?: string) {
  const allowedIds = new Set((facultyId
    ? activeFacultyUsers(users, facultyId)
    : activeCoreTeamUsers(users)).map((user) => user.id));
  return [...new Set(requestedIds.map(String).filter((id) => allowedIds.has(id)))];
}
