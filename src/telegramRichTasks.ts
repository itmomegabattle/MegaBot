const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const shortHeadings: Record<string, string> = {
  'Тебе назначена новая задача!': 'Новая задача',
  'Тебе назначена задача:': 'Новая задача',
  'На доске появилась свободная задача.': 'Свободная задача',
  'Новая задача от MEGABATTLE:': 'Новая задача',
  'Напоминание по задаче:': 'Напоминание по задаче',
  'Задача обновлена.': 'Задача обновлена',
  'Задача снова свободна:': 'Задача снова свободна',
  'Задача выполнена!': 'Задача выполнена',
  'Задача отменена автором.': 'Задача отменена',
};

export function renderRichTaskNotification(category: string, text: string): string | undefined {
  if (!['task', 'task_reminder', 'faculty_task', 'faculty_registration', 'faculty_registration_decision'].includes(category)) return;
  const [first, ...lines] = text.split('\n');
  if (!first?.trim()) return;
  const compactFacultyTask = category === 'faculty_task';
  const heading = compactFacultyTask ? first.split('. ')[0].replace(/\.$/, '') : shortHeadings[first] || first;
  if (heading.length > 180) return;
  const title = /^\*(.+)\*$/.exec(lines[1] || '');
  const remaining = title ? lines.slice(2) : lines;
  const fields = /^(?:\*([^*]+):\*|((?:Текущий статус|Блоки|Завершил|Задача|Исполнитель|Затрачено|Комментарий|Дедлайн|Срок|Статус|Автор|ФИО|Факультет|Роль)):)\s*(.*)$/;
  const blocks: string[] = [];
  let rows: string[] = [];
  const flush = () => {
    if (!rows.length) return;
    blocks.push('<table>' + rows.join('') + '</table>');
    rows = [];
  };
  for (const line of remaining) {
    if (!line.trim()) continue;
    if (title && line === 'Чтобы поменять статус, нажми «Мои задачи».') continue;
    const field = fields.exec(line);
    if (field && field[3]) {
      if (field[1] === 'Приоритет' && field[3] === 'обычная') continue;
      if (['без мероприятия', 'не указаны', 'не указан'].includes(field[3])) continue;
      rows.push('<tr><th>' + escapeHtml(field[1] || field[2]) + '</th><td>' + escapeHtml(field[3]) + '</td></tr>');
    } else {
      flush();
      blocks.push('<p>' + escapeHtml(line.replace(/^\*(.+)\*$/, '$1')) + '</p>');
    }
  }
  flush();
  return '<h3>' + escapeHtml(heading) + '</h3>'
    + (title ? '<h1>' + escapeHtml(title[1]) + '</h1>' : '')
    + blocks.join('');
}
