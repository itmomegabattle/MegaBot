import type { Task } from './types.js';
import { releaseTaskAssignee, type ReleaseTaskAssigneeResult } from './taskAssignment.js';

export class TaskCommandError extends Error {
  constructor(public code: 'cancelled' | 'completed' | 'not_assigned', message: string) {
    super(message);
  }
}

export function releaseTaskCommand(task: Task, userId: string): ReleaseTaskAssigneeResult {
  if (task.status === 'cancelled') throw new TaskCommandError('cancelled', 'Задача отменена');
  if (task.status === 'completed') throw new TaskCommandError('completed', 'Задача уже завершена');
  return releaseTaskAssignee(task, userId);
}

export function completeTaskCommand(
  task: Task,
  userId: string,
  options: { timeSpentMinutes?: number; completionComment?: string; now?: Date } = {},
) {
  if (task.status === 'cancelled') throw new TaskCommandError('cancelled', 'Задача отменена');
  if (task.status === 'completed') throw new TaskCommandError('completed', 'Задача уже завершена');
  if (!(task.assignedTo || []).includes(userId)) throw new TaskCommandError('not_assigned', 'Вы больше не назначены на эту задачу');
  task.status = 'completed';
  task.version = Number(task.version || 1) + 1;
  task.completedAt = (options.now || new Date()).toISOString();
  task.assignmentMode = 'shared';
  task.completedBy = userId;
  task.timeSpentMinutes = options.timeSpentMinutes;
  task.completionComments ||= {};
  const cleanComment = String(options.completionComment || '').trim();
  if (cleanComment) task.completionComments[userId] = cleanComment;
  else delete task.completionComments[userId];
  return task;
}
