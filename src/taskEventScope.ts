import type { Task, WorkEvent } from './types.js';

export const TASK_EVENT_SCOPE_ALL = '__all__';
export const TASK_EVENT_SCOPE_NONE = '__none__';
export const TASK_EVENT_SCOPE_ARCHIVED = '__archived__';

export function filterTasksByEventScope(tasks: Task[], events: WorkEvent[], scope: string) {
  if (scope === TASK_EVENT_SCOPE_ALL) return tasks;
  if (scope === TASK_EVENT_SCOPE_NONE) return tasks.filter((task) => !task.eventId);
  if (scope === TASK_EVENT_SCOPE_ARCHIVED) {
    const archivedIds = new Set(events.filter((event) => event.status === 'archived').map((event) => event.id));
    return tasks.filter((task) => Boolean(task.eventId && archivedIds.has(task.eventId)));
  }
  return tasks.filter((task) => task.eventId === scope);
}

export function newTaskEventIdForScope(events: WorkEvent[], scope: string) {
  return events.some((event) => event.id === scope && event.status === 'active') ? scope : '';
}
