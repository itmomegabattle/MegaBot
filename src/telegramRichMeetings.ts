import { MEETING_KIND_TEXT } from './meetingKind.js';

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const table = (rows: string[][]) => '<table>' + rows.map(([key, value]) =>
  '<tr><th>' + escapeHtml(key) + '</th><td>' + escapeHtml(value).replace(/\n/g, '<br>') + '</td></tr>',
).join('') + '</table>';

export function renderRichMeetingNotification(category: string, text: string): string | undefined {
  if (!['meeting_created', 'meeting_updated', 'meeting_cancelled'].includes(category)) return;
  for (const [kind, labels] of Object.entries(MEETING_KIND_TEXT)) {
    if (category === 'meeting_cancelled' && text.startsWith(labels.cancelled + '\n\n')) {
      const match = /^([\s\S]+)\nДата: (.+)\nВремя: (.+)$/.exec(text.slice(labels.cancelled.length + 2));
      if (!match) return;
      return '<h6>' + labels.cancelled + '</h6><p>' + escapeHtml(match[1]) + '</p>'
        + table([['Дата', match[2]], ['Время', match[3]]]);
    }
    if (category === 'meeting_updated' && text.startsWith(labels.updated + ': *')) {
      const match = /^([\s\S]+?)\*\n\*Тип:\* /.exec(text.slice(labels.updated.length + 3));
      const marker = '\n\n*Что изменилось:*\n';
      const changeStart = text.lastIndexOf(marker);
      if (!match || changeStart < 0) return;
      const rows = text.slice(changeStart + marker.length).slice(1).split('\n❗').map(change => {
        const separator = change.indexOf(':');
        return separator < 0 ? [change, 'Изменено'] : [change.slice(0, separator), change.slice(separator + 1).trim()];
      });
      return '<h3>' + labels.updated + '</h3><h1>' + escapeHtml(match[1]) + '</h1>'
        + '<h6>Что изменилось</h6>' + table(rows);
    }
    if (category === 'meeting_created' && text.startsWith(labels.created + '\n\n*')) {
      const match = /^([\s\S]+?)\*\n\n\*Тип:\* ([^\n]+)\n([\s\S]+)\n\nПожалуйста, освободите это время\.$/
        .exec(text.slice(labels.created.length + 3));
      if (!match) return;
      const [, title, , details] = match;
      const descriptionMarker = '\n*Описание:* ';
      const descriptionStart = details.indexOf(descriptionMarker);
      const description = descriptionStart < 0 ? '' : details.slice(descriptionStart + descriptionMarker.length);
      const rows = [...(descriptionStart < 0 ? details : details.slice(0, descriptionStart))
        .matchAll(/^\*(Мероприятие|Дата|Время|Длительность|Организатор):\* (.+)$/gm)]
        .filter(row => row[2] !== 'не указано').map(row => [row[1], row[2]]);
      const heading = kind === 'setup' ? 'Намечается монтаж)' : kind === 'vibe' ? 'МегаОтдых' : 'Новое собрание!';
      return '<h3>' + heading + '</h3><h1>' + escapeHtml(title) + '</h1>'
        + (description ? '<p>' + escapeHtml(description).replace(/\n/g, '<br>') + '</p>' : '')
        + '<h6>Подробности</h6>' + table(rows)
        + (kind === 'setup' ? '<p>Пожалуйста, помогите</p>' : '');
    }
  }
}
