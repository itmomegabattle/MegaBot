import assert from 'node:assert/strict';
import {
  activeCoreTeamUsers,
  activeFacultyUsers,
  resolveMeetingAudienceUsers,
  resolveTaskAudienceUsers,
  sanitizeTaskAssigneeIds,
  snapshotMeetingAudienceUserIds,
} from '../src/audiencePolicy.js';
import type { Meeting, Task, User } from '../src/types.js';

const users = [
  { id: 'admin', role: 'admin', active: true, realName: 'Admin' },
  { id: 'member', role: 'organizer', active: true, realName: 'Member' },
  { id: 'new-member', role: 'organizer', active: true, realName: 'New' },
  { id: 'inactive-member', role: 'organizer', active: false, realName: 'Inactive' },
  { id: 'faculty-a', role: 'faculty_responsible', facultyId: 'fa', active: true, realName: 'Faculty A' },
  { id: 'faculty-b', role: 'faculty_helper', facultyId: 'fb', active: true, realName: 'Faculty B' },
  { id: 'inactive-faculty', role: 'faculty_helper', facultyId: 'fa', active: false, realName: 'Inactive Faculty' },
].map((user) => ({
  username: `@${user.id}`, avatarSeed: user.id, registered: true, competencies: [], primaryCompetency: '',
  ...user,
})) as User[];

assert.deepEqual(activeCoreTeamUsers(users).map((user) => user.id), ['admin', 'member', 'new-member']);
assert.deepEqual(activeFacultyUsers(users, 'fa').map((user) => user.id), ['faculty-a']);

const originalUsers = users.filter((user) => user.id !== 'new-member');
const snapshotIds = snapshotMeetingAudienceUserIds(originalUsers, 'all', 'admin');
assert.deepEqual(snapshotIds, ['admin', 'member']);
const snapshottedMeeting = {
  participants: 'all', hostId: 'admin', audiencePolicy: 'snapshot', audienceUserIds: snapshotIds,
} as Pick<Meeting, 'participants' | 'hostId' | 'audiencePolicy' | 'audienceUserIds'>;
assert.deepEqual(
  resolveMeetingAudienceUsers(users, snapshottedMeeting).map((user) => user.id),
  ['admin', 'member'],
  'new core members must not silently join an existing meeting snapshot',
);
assert.deepEqual(
  snapshotMeetingAudienceUserIds(users, ['member', 'faculty-a', 'inactive-member'], 'admin'),
  ['admin', 'member'],
  'explicit meeting audiences must stay inside the active core team and include the host',
);

const normalOpenTask = { assignedTo: null } as Pick<Task, 'assignedTo' | 'facultyId'>;
assert.deepEqual(resolveTaskAudienceUsers(users, normalOpenTask).map((user) => user.id), ['admin', 'member', 'new-member']);
const normalAssignedTask = { assignedTo: ['member', 'faculty-a'] } as Pick<Task, 'assignedTo' | 'facultyId'>;
assert.deepEqual(resolveTaskAudienceUsers(users, normalAssignedTask).map((user) => user.id), ['member']);
const facultyTask = { assignedTo: null, facultyId: 'fa' } as Pick<Task, 'assignedTo' | 'facultyId'>;
assert.deepEqual(resolveTaskAudienceUsers(users, facultyTask).map((user) => user.id), ['faculty-a']);
assert.deepEqual(sanitizeTaskAssigneeIds(users, ['faculty-a', 'faculty-b', 'member'], 'fa'), ['faculty-a']);
assert.deepEqual(sanitizeTaskAssigneeIds(users, ['faculty-a', 'faculty-b'], 'all'), ['faculty-a', 'faculty-b']);

console.log('Audience policy verification passed: active core, faculty scope, meeting snapshots, and task recipients agree.');
