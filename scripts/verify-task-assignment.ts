import assert from 'node:assert/strict';
import { releaseTaskAssignee } from '../src/taskAssignment.js';
import type { Task } from '../src/types.js';

const sharedTask: Task = {
  id: 'shared', version: 3, title: 'Общая задача', description: '', deadline: '', creatorId: 'owner',
  competency: '', competencies: [], sow: '', status: 'in_progress', priority: 'normal', assignedTo: ['a', 'b'],
  assignmentMode: 'shared', createdAt: '2026-09-24T00:00:00.000Z', completedAt: '',
  assigneeNotes: { a: { executor: 'сохранить', coordinator: '', updatedAt: '' } },
  completionComments: { a: 'история' }, reminders: [], tips: [],
};

const first = releaseTaskAssignee(sharedTask, 'a');
assert.deepEqual(first, { changed: true, becameOpen: false, remainingAssigneeIds: ['b'] });
assert.deepEqual(sharedTask.assignedTo, ['b']);
assert.equal(sharedTask.status, 'in_progress');
assert.equal(sharedTask.assigneeNotes?.a?.executor, 'сохранить');
assert.equal(sharedTask.completionComments?.a, 'история');

const repeated = releaseTaskAssignee(sharedTask, 'a');
assert.equal(repeated.changed, false);
assert.equal(sharedTask.version, 4, 'repeated release is idempotent');

const last = releaseTaskAssignee(sharedTask, 'b');
assert.equal(last.becameOpen, true);
assert.equal(sharedTask.status, 'open');
assert.equal(sharedTask.assignedTo, null);
assert.equal(sharedTask.assigneeNotes?.a?.executor, 'сохранить');

console.log('Task assignment release checks passed.');
