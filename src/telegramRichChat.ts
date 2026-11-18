const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function richChatTable(heading: string, rows: string[][], subtitle?: string) {
  return '<h3>' + escapeHtml(heading) + '</h3>'
    + (subtitle ? '<h5>' + escapeHtml(subtitle) + '</h5>' : '')
    + '<table>' + rows.map(([label, value]) =>
      '<tr><th>' + escapeHtml(label) + '</th><td>' + escapeHtml(value) + '</td></tr>',
    ).join('') + '</table>';
}
