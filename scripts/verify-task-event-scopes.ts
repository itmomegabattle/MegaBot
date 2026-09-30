import assert from 'node:assert/strict';
import {
  TASK_EVENT_SCOPE_ALL,
  TASK_EVENT_SCOPE_ARCHIVED,
  TASK_EVENT_SCOPE_NONE,
  filterTasksByEventScope,
  newTaskEventIdForScope,
} from '../src/taskEventScope.js';
import type { Task, WorkEvent } from '../src/types.js';

const events: WorkEvent[] = [
  { id: 'active', name: 'Активное', status: 'active', createdAt: '', description: '' },
  { id: 'archived', name: 'Архивное', status: 'archived', createdAt: '', description: '' },
];
const task = (id: string, eventId?: string): Task => ({
  id, eventId, title: id, description: '', deadline: '01.01.30', assignedTo: null,
  competency: '', sow: '', tips: [], status: 'open', priority: 'normal',
});
const tasks = [task('none'), task('active-task', 'active'), task('archived-task', 'archived')];

assert.deepEqual(filterTasksByEventScope(tasks, events, TASK_EVENT_SCOPE_ALL).map((item) => item.id), ['none', 'active-task', 'archived-task']);
assert.deepEqual(filterTasksByEventScope(tasks, events, TASK_EVENT_SCOPE_NONE).map((item) => item.id), ['none']);
assert.deepEqual(filterTasksByEventScope(tasks, events, 'active').map((item) => item.id), ['active-task']);
assert.deepEqual(filterTasksByEventScope(tasks, events, TASK_EVENT_SCOPE_ARCHIVED).map((item) => item.id), ['archived-task']);
assert.equal(newTaskEventIdForScope(events, TASK_EVENT_SCOPE_ALL), '');
assert.equal(newTaskEventIdForScope(events, TASK_EVENT_SCOPE_NONE), '');
assert.equal(newTaskEventIdForScope(events, 'active'), 'active');
assert.equal(newTaskEventIdForScope(events, 'archived'), '');

console.log('Task event scope verification passed: all, no event, active, archived, and safe new-task defaults.');
