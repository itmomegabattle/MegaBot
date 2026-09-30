import assert from 'node:assert/strict';
import { chatNavigationTarget } from '../src/chatNavigation.js';
import { meetingScheduleError } from '../src/meetingScheduling.js';
import { completeTaskCommand, releaseTaskCommand, TaskCommandError } from '../src/taskCommands.js';
import type { Task } from '../src/types.js';

const task = (status: Task['status'] = 'assigned'): Task => ({
  id: 'task', version: 1, title: 'Task', description: '', deadline: '31.12.30', assignedTo: ['member'], creatorId: 'admin',
  sow: '', tips: [], status, priority: 'normal', completionComments: {},
});

for (const status of ['cancelled', 'completed'] as const) {
  const candidate = task(status);
  assert.throws(() => releaseTaskCommand(candidate, 'member'), TaskCommandError);
  assert.equal(candidate.status, status);
  assert.deepEqual(candidate.assignedTo, ['member']);
  assert.throws(() => completeTaskCommand(candidate, 'member'), TaskCommandError);
  assert.equal(candidate.version, 1);
}

const released = task();
assert.equal(releaseTaskCommand(released, 'member').becameOpen, true);
assert.equal(released.status, 'open');

const completed = task();
completeTaskCommand(completed, 'member', { timeSpentMinutes: 45, completionComment: 'Готово', now: new Date('2030-01-07T12:00:00.000Z') });
assert.equal(completed.status, 'completed');
assert.equal(completed.completedBy, 'member');
assert.equal(completed.completionComments?.member, 'Готово');

const settings = { availabilityActiveDays: [0], availabilityStartHour: 18, availabilityEndHour: 21 };
const now = new Date('2029-01-01T00:00:00.000Z');
assert.equal(meetingScheduleError('07.01.30', '18:00', 1, settings, 'meeting', now), '');
assert.match(meetingScheduleError('08.01.30', '18:00', 1, settings, 'meeting', now), /отключены/);
assert.match(meetingScheduleError('07.01.30', '22:30', 1, settings, 'meeting', now), /диапазон/);
assert.match(meetingScheduleError('01.01.28', '18:00', 1, settings, 'meeting', now), /прошлом/);
assert.equal(meetingScheduleError('08.01.30', '03:15', 1, settings, 'vibe', now), '');

assert.equal(chatNavigationTarget('Меню'), 'profile');
assert.equal(chatNavigationTarget('/tasks@MegaBot'), 'tasks');
assert.equal(chatNavigationTarget('Встречи'), 'meetings');
assert.equal(chatNavigationTarget('обычный комментарий'), undefined);

console.log('Command parity verification passed: task transitions, meeting schedule and global navigation.');
