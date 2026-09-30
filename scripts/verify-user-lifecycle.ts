import assert from 'node:assert/strict';
import { deactivateUser, findOrphanUserReferences, isUserActive } from '../src/userLifecycle.js';
import type { SimulationState } from '../src/types.js';

const baseState = (): SimulationState => ({
  users: [
    { id: 'admin-1', username: '@admin1', realName: 'Admin One', role: 'admin', avatarSeed: 'a', registered: true },
    { id: 'admin-2', username: '@admin2', realName: 'Admin Two', role: 'admin', avatarSeed: 'b', registered: true },
    { id: 'member', username: '@member', realName: 'Member', role: 'organizer', avatarSeed: 'm', registered: true },
  ],
  faculties: [], facultyCompetencies: [], competencies: [], availabilities: {}, messages: {}, events: [],
  meetings: [{ id: 'past-meeting', title: 'History', type: 'custom', date: '01.01.25', time: '10:00', duration: 60, hostId: 'member', participants: ['member'], attendeeIds: ['member'], status: 'completed' }],
  tasks: [{
    id: 'active-task', version: 1, title: 'Active', description: '', deadline: '31.12.30', assignedTo: ['member'], creatorId: 'member',
    sow: '', tips: [], status: 'assigned', priority: 'normal', assigneeNotes: { member: { history: [{ id: 'comment', authorId: 'member', side: 'executor', text: 'Done', createdAt: '2026-09-28T00:00:00.000Z' }] } },
  }, {
    id: 'history-task', version: 1, title: 'History', description: '', deadline: '01.01.25', assignedTo: ['member'], creatorId: 'member',
    sow: '', tips: [], status: 'completed', priority: 'normal', completedBy: 'member', completionComments: { member: 'Ready' },
  }],
  settings: {},
});

{
  const state = baseState();
  const preview = deactivateUser(state, 'member', 'admin-1');
  assert.equal(preview.ok, false);
  assert.equal(preview.ok ? '' : preview.code, 'active_tasks_require_confirmation');
  assert.equal(isUserActive(state.users[2]), true);

  const result = deactivateUser(state, 'member', 'admin-1', true);
  assert.equal(result.ok, true);
  assert.equal(isUserActive(state.users[2]), false);
  assert.equal(state.users[2].registered, false);
  assert.equal(state.tasks[0].status, 'open');
  assert.equal(state.tasks[0].assignedTo, null);
  assert.deepEqual(state.tasks[1].assignedTo, ['member']);
  assert.equal(state.tasks[1].creatorId, 'member');
  assert.equal(state.meetings[0].hostId, 'member');
  assert.deepEqual(findOrphanUserReferences(state), []);
}

{
  const state = baseState();
  state.meetings.push({ id: 'future', title: 'Future', type: 'custom', date: '31.12.30', time: '10:00', duration: 60, hostId: 'member', participants: 'all', status: 'scheduled' });
  const result = deactivateUser(state, 'member', 'admin-1', true);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'scheduled_meetings_require_reassignment');
}

{
  const state = baseState();
  state.users = state.users.filter((user) => user.id !== 'admin-2');
  const result = deactivateUser(state, 'admin-1', 'admin-1', true);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /последнего/);
}

{
  const state = baseState();
  state.availabilities.member = { userId: 'member', slots: { 0: [10] }, updatedAt: '2026-09-28T00:00:00.000Z' };
  state.messages.member = [{ id: 'message', userId: 'member', sender: 'bot', text: 'History', timestamp: '2026-09-28T00:00:00.000Z' }];
  state.users = state.users.filter((user) => user.id !== 'member');
  const orphans = findOrphanUserReferences(state);
  assert.deepEqual(new Set(orphans.map((item) => `${item.entity}.${item.field}`)), new Set([
    'availability.userId', 'message.ownerId', 'message.userId', 'meeting.hostId', 'meeting.participants', 'meeting.attendeeIds', 'task.assignedTo', 'task.creatorId',
    'task.assigneeNotes', 'task.assigneeNotes.history.authorId', 'task.completedBy', 'task.completionComments',
  ]));
}

console.log('user lifecycle verification passed');
