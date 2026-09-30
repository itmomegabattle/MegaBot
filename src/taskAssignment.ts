import type { Task } from './types.js';

export type ReleaseTaskAssigneeResult = {
  changed: boolean;
  becameOpen: boolean;
  remainingAssigneeIds: string[];
};

export function releaseTaskAssignee(task: Task, userId: string): ReleaseTaskAssigneeResult {
  const assignees = [...new Set((task.assignedTo || []).map(String).filter(Boolean))];
  if (!assignees.includes(userId)) {
    return { changed: false, becameOpen: task.status === 'open', remainingAssigneeIds: assignees };
  }
  const remainingAssigneeIds = assignees.filter((id) => id !== userId);
  task.assignedTo = remainingAssigneeIds.length ? remainingAssigneeIds : null;
  if (!remainingAssigneeIds.length) task.status = 'open';
  task.version = Number(task.version || 1) + 1;
  return { changed: true, becameOpen: !remainingAssigneeIds.length, remainingAssigneeIds };
}
