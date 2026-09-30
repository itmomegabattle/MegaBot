import assert from 'node:assert/strict';
import { sanitizeSimulationState } from '../src/stateMaintenance.js';
import type { SimulationState, Task } from '../src/types.js';

const legacyTask = (overrides: Partial<Task>): Task => ({
  id: 'legacy',
  title: 'Старая общая задача',
  description: '',
  deadline: '01.10.26',
  assignedTo: ['u_one', 'u_two'],
  creatorId: 'u_owner',
  competency: '',
  sow: '',
  tips: [],
  status: 'completed',
  priority: 'normal',
  completedAt: '2026-09-23T09:00:00.000Z',
  completionComments: { u_one: 'Готово' },
  ...overrides,
});

const state: SimulationState = {
  users: [],
  availabilities: {},
  meetings: [],
  tasks: [
    legacyTask({ id: 'without-author' }),
    legacyTask({ id: 'with-author', completedBy: 'u_two', assignmentMode: 'shared' }),
  ],
  messages: {},
};

const sanitized = sanitizeSimulationState(state, '2026-09-21');
assert.equal(sanitized.tasks[0].assignmentMode, 'shared');
assert.equal(sanitized.tasks[0].completedBy, undefined, 'legacy completion must not invent an author from assignees or comments');
assert.equal(sanitized.tasks[1].assignmentMode, 'shared');
assert.equal(sanitized.tasks[1].completedBy, 'u_two');

console.log('Shared task model verification passed: legacy defaults and factual completion authors are preserved.');
