export type ChatNavigationTarget = 'profile' | 'slots' | 'meetings' | 'tasks' | 'team' | 'faculties';

export function chatNavigationTarget(value: string): ChatNavigationTarget | undefined {
  const text = value.trim().toLowerCase().split('@')[0];
  if (text === 'меню' || text === 'профиль' || text === '/start') return 'profile';
  if (text === 'слоты' || text === '/slots') return 'slots';
  if (text === 'встречи' || text === '/meetings') return 'meetings';
  if (text === 'задачи' || text === '/tasks') return 'tasks';
  if (text === 'команда') return 'team';
  if (text === 'мф' || text === 'факультеты') return 'faculties';
  return undefined;
}
