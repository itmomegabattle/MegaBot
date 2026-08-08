/**
 * Install this code as a bound Apps Script in the attendance spreadsheet.
 * Run installMegaBotTrigger() once from the Apps Script editor.
 */
const MEGABOT_WEBHOOK_URL = 'https://megaorgiabot.ru/api/integrations/google-sheets/webhook';
const MEGABOT_PRIMARY_SHEET_ID = 1910422522;

/** Existing spreadsheet controls: row 2 checkboxes clear a whole day. */
function handleDayReset(event) {
  if (!event || !event.range) return false;
  const sheet = event.range.getSheet();
  const range = event.range;
  if (range.getRow() !== 2 || !range.isChecked()) return false;

  const dayRanges = {
    30: 'I5:L36',
    31: 'S5:V36',
    32: 'AC5:AF36',
    39: 'AM5:AP36',
    40: 'AW5:AZ36',
    41: 'BB5:BJ36',
    42: 'BL5:BT36',
  };
  const target = dayRanges[range.getColumn()];
  if (!target) return false;
  sheet.getRange(target).uncheck();
  range.uncheck();
  SpreadsheetApp.flush();
  return true;
}

function installMegaBotTrigger() {
  const spreadsheet = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'sendMegaBotEdit')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('sendMegaBotEdit').forSpreadsheet(spreadsheet).onEdit().create();
}

function setMegaBotWebhookSecret() {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt('MegaBot webhook secret', 'Вставьте GOOGLE_SHEETS_WEBHOOK_SECRET из /opt/megabot/.env', ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty('MEGABOT_WEBHOOK_SECRET', result.getResponseText().trim());
}

function sendMegaBotEdit(event) {
  const secret = PropertiesService.getScriptProperties().getProperty('MEGABOT_WEBHOOK_SECRET');
  if (!secret || !event || !event.range) return;
  if (event.range.getSheet().getSheetId() !== MEGABOT_PRIMARY_SHEET_ID) return;
  const resetDay = handleDayReset(event);
  const timestamp = String(Date.now());
  const payload = JSON.stringify({
    eventId: Utilities.getUuid(),
    spreadsheetId: event.source.getId(),
    sheetId: event.range.getSheet().getSheetId(),
    sheetTitle: event.range.getSheet().getName(),
    range: event.range.getA1Notation(),
    row: event.range.getRow(),
    column: event.range.getColumn(),
    rows: event.range.getNumRows(),
    columns: event.range.getNumColumns(),
    value: typeof event.value === 'undefined' ? null : event.value,
    oldValue: typeof event.oldValue === 'undefined' ? null : event.oldValue,
    resetDay,
  });
  const bytes = Utilities.computeHmacSha256Signature(timestamp + '.' + payload, secret);
  const signature = bytes.map(byte => (`0${(byte & 0xff).toString(16)}`).slice(-2)).join('');
  UrlFetchApp.fetch(MEGABOT_WEBHOOK_URL, {
    method: 'post', contentType: 'application/json', payload, muteHttpExceptions: true,
    headers: { 'X-MegaBot-Timestamp': timestamp, 'X-MegaBot-Signature': signature },
  });
}
