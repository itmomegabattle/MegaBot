// Run through playwright-cli run-code --filename scripts/verify-broadcast-ui.js.
// Requires a local Vite preview on 127.0.0.1:15173. Every API request is intercepted.
async page => {
  // The CLI's interactive dialog listener pauses run-code; this isolated check owns confirmations.
  page.removeAllListeners('dialog');
  // Suppress only the synthetic browser's unload prompt to exercise draft restoration unattended.
  await page.addInitScript(() => window.addEventListener('beforeunload', event => event.stopImmediatePropagation(), { capture: true }));
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  let durable = true;
  const state = {
    timeZone: 'Europe/Moscow', serverNow: '2026-10-05T10:00:00Z',
    users: [
      { id: 'a', username: 'test_author', realName: 'Синтетический автор', role: 'organizer', avatarSeed: 'a', active: true, registered: true, telegramConnected: true },
      { id: 'r', username: 'test_recipient', realName: 'Синтетический адресат', role: 'organizer', avatarSeed: 'r', active: true, registered: true, telegramConnected: true },
      { id: 'n', username: 'test_unavailable', realName: 'Без Telegram', role: 'organizer', avatarSeed: 'n', active: true, registered: true, telegramConnected: false },
    ],
    competencies: [], availabilities: {}, meetings: [], tasks: [], events: [], messages: {},
    settings: { availabilityWeekCount: 2, availabilityActiveDays: [1,2,3,4,5], availabilityStartHour: 17, availabilityEndHour: 23 },
  };
  const requests = [];
  let historyCalls = 0;
  let version = 7;
  let lifecycleStatus = 'scheduled';
  let replacedBy = null;
  let scheduledAt = '2026-10-06T09:00:00Z';
  let reschedulable = true;
  const transfers = [];
  const groupRequests = [];
  let groupListCalls = 0, groupListFailure = true, groupRevoked = false, groupEmpty = false;
  const wholeLabel = 'Синтетическая группа организаторов — вся группа, длинное название';
  const topicLabel = 'Синтетическая группа организаторов — топик «ВАЖНОЕ»';
  const retries = [], cancellations = [];
  await page.unroute('**/api/**');
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') return route.fulfill({ json: { ...state, ...(durable ? { capabilities: { durableBroadcasts: true } } : {}) } });
    if (url.pathname === '/api/team/broadcast') {
      requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
      if (requests.length === 1) return route.abort('connectionreset');
      return route.fulfill({ status: 202, json: { success: true, broadcastId: 'b', recipients: 3, queued: 2, unavailable: 1 } });
    }
    if (url.pathname === '/api/v1/broadcasts') {
      if (route.request().method() === 'POST') {
        groupRequests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
        if (groupRequests.length === 1) return route.abort('connectionreset');
        return route.fulfill({ status: 201, json: { id: 'group-broadcast', targetCount: 2, version: 0 } });
      }
      if (++historyCalls === 1) return route.fulfill({ status: 500, json: { error: 'Синтетический отказ истории' } });
      return route.fulfill({ json: { items: [{ id: 'b', version, reschedulable, contentRevision: 1, lifecycleStatus, title: 'Синтетическая рассылка', body: 'Проверка', status: lifecycleStatus === 'cancelled' ? 'cancelled' : reschedulable ? 'scheduled' : 'partial', scheduledAt, targetCount: 3, deliveryCounts: reschedulable ? { planned: 2, unavailable: 1 } : { sent: 1, unknown: 1, unavailable: 1 } }], nextCursor: null } });
    }
    if (url.pathname === '/api/v1/broadcast-group-targets') {
      groupListCalls++;
      if (groupListFailure) return route.fulfill({ status: 500, json: { error: 'Синтетический отказ списка групп' } });
      return route.fulfill({ json: groupEmpty ? { items: [], nextCursor: null } : url.searchParams.has('cursor')
        ? { items: groupRevoked ? [] : [{ id: 'g2', label: topicLabel }], nextCursor: null }
        : { items: [{ id: 'g1', label: wholeLabel }], nextCursor: groupRevoked ? null : 'g1' } });
    }
    if (url.pathname === '/api/v1/broadcasts/b/deliveries') return route.fulfill({ json: { version, items: [{ id: 'd', contentRevision: 1, replacedBy, expiresAt: null, recipientId: 'r', status: 'unknown', partNumber: 2, partCount: 3, attemptCount: 1, sentAt: null, errorCode: 'response_timeout' }], nextCursor: null } });
    if (url.pathname === '/api/v1/broadcasts/b/reschedule') {
      transfers.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
      if (transfers.length === 1) { scheduledAt = transfers[0].body.scheduledAt; version++; return route.abort('connectionreset'); }
      return route.fulfill({ json: { id: 'b', version, scheduledAt, contentRevision: 2 } });
    }
    if (url.pathname === '/api/v1/broadcasts/b/deliveries/d/retry') {
      retries.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
      if (retries.length === 1) { version++; replacedBy = 'child'; return route.abort('connectionreset'); }
      return route.fulfill({ status: 201, json: { id: 'child', version, retryOf: 'd', status: 'planned' } });
    }
    if (url.pathname === '/api/v1/broadcasts/b/cancel') {
      cancellations.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
      if (cancellations.length === 1) { version++; return route.fulfill({ status: 409, json: { error: 'stale_version' } }); }
      lifecycleStatus = 'cancelled'; version++;
      return route.fulfill({ json: { id: 'b', version, status: 'cancelled' } });
    }
    return route.fulfill({ status: 404, json: { error: 'Route outside isolated fixture' } });
  });
  await page.goto('http://127.0.0.1:15173/?tab=team');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Создать рассылку', exact: true }).click();
  await page.getByRole('textbox', { name: 'Текст рассылки', exact: true }).fill('Синтетический тест');
  await page.getByRole('radio', { name: 'Запланировать', exact: true }).check();
  await page.getByRole('textbox', { name: 'Дата · МСК', exact: true }).fill('2026-10-06');
  await page.getByRole('textbox', { name: 'Время · МСК', exact: true }).fill('12:00');
  await page.getByRole('button', { name: 'Запланировать', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Сервер не подтвердил' }).waitFor();
  ensure(await page.getByRole('textbox', { name: 'Текст рассылки', exact: true }).inputValue() === 'Синтетический тест', 'failure erased draft');
  ensure(await page.getByRole('button', { name: 'Повторить отправку' }).isEnabled(), 'pending did not clear');
  await page.reload();
  await page.getByRole('button', { name: 'Создать рассылку', exact: true }).waitFor();
  ensure(await page.getByRole('textbox', { name: 'Текст рассылки', exact: true }).inputValue() === 'Синтетический тест', 'reload lost draft');
  ensure(await page.getByRole('textbox', { name: 'Дата · МСК', exact: true }).inputValue() === '2026-10-06', 'reload lost schedule');
  await page.getByRole('button', { name: 'Запланировать', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Рассылка сохранена в очереди' }).waitFor();
  ensure(requests.length === 2 && requests[0].key === requests[1].key, 'explicit retry after reload changed key');
  ensure(requests[1].body.scheduledAt === '2026-10-06T09:00:00.000Z', 'Moscow conversion failed');
  ensure(await page.getByRole('textbox', { name: 'Текст рассылки', exact: true }).inputValue() === '', 'confirmed command did not clear draft');
  await page.getByRole('button', { name: 'История рассылок', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Синтетический отказ истории' }).waitFor();
  await page.getByRole('button', { name: 'Обновить историю', exact: true }).click();
  await page.getByRole('heading', { name: 'Синтетическая рассылка' }).waitFor();
  await page.getByRole('button', { name: 'Перенести время', exact: true }).click();
  await page.getByRole('textbox', { name: 'Новая дата · МСК', exact: true }).fill('2026-10-07');
  await page.getByRole('textbox', { name: 'Новое время · МСК', exact: true }).fill('14:30');
  for (const width of [320,1024]) {
    await page.setViewportSize({ width, height: 720 });
    await page.getByRole('textbox', { name: 'Новая дата · МСК', exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `transfer overflow at ${width}`);
    await page.screenshot({ path: `output/playwright/broadcast-reschedule/${width}-form.png`, animations: 'disabled' });
  }
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Подтвердить перенос', exact: true }).click();
  ensure(transfers.length === 0, 'dismissed transfer was sent');
  page.once('dialog', dialog => { ensure(dialog.message().includes('14:30 МСК'), 'wrong confirmation time'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Подтвердить перенос', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Сервер не подтвердил действие' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'История рассылок', exact: true }).click();
  await page.getByRole('button', { name: 'Перенести время', exact: true }).click();
  ensure(await page.getByRole('textbox', { name: 'Новое время · МСК', exact: true }).inputValue() === '14:30', 'lost transfer not restored after reload');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Подтвердить перенос', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Перенос сохранён' }).waitFor();
  ensure(transfers.length === 2 && transfers[0].key === transfers[1].key && JSON.stringify(transfers[0].body) === JSON.stringify(transfers[1].body) && transfers[1].body.scheduledAt === '2026-10-07T11:30:00.000Z', 'transfer did not retain original command/version or Moscow time');
  reschedulable = false;
  await page.getByRole('button', { name: 'Обновить историю', exact: true }).click();
  await page.getByRole('button', { name: 'Журнал отправок', exact: true }).click();
  ensure(await page.getByRole('button', { name: 'Перенести время', exact: true }).count() === 0, 'non-reschedulable item offered transfer');
  await page.getByText(/Синтетический адресат · часть 2\/3/).waitFor();
  const retry = page.getByRole('button', { name: 'Повторить часть 2/3 с риском дубля', exact: true });
  page.once('dialog', dialog => dialog.dismiss());
  await retry.click();
  ensure(retries.length === 0, 'dismissed confirmation sent a retry');
  for (const width of [320,1024]) {
    await page.setViewportSize({ width, height: 720 });
    await retry.evaluate(element => element.scrollIntoView({ block: 'center' }));
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow at ${width}`);
    await page.screenshot({ path: `output/playwright/broadcast-actions/${width}-history.png`, animations: 'disabled' });
  }
  page.once('dialog', dialog => { ensure(dialog.message().includes('дубль'), 'risk not disclosed'); return dialog.accept(); });
  await retry.click();
  await page.getByRole('alert').filter({ hasText: 'Сервер не подтвердил действие' }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await retry.click();
  await page.getByRole('status').filter({ hasText: 'Повтор выбранной части сохранён' }).waitFor();
  ensure(retries.length === 2 && retries[0].key === retries[1].key && retries[1].body.expectedVersion === 8 && retries[1].body.acknowledgeDuplicateRisk === true, 'unknown retry did not replay acknowledged original intent');
  await page.getByRole('button', { name: 'Журнал отправок', exact: true }).click();
  await page.getByText('Повтор уже создан. Исходная часть повторно не отправляется.', { exact: true }).waitFor();
  ensure(await retry.count() === 0, 'already retried leaf offered another retry');
  const cancel = page.getByRole('button', { name: 'Отменить оставшиеся отправки', exact: true });
  page.once('dialog', dialog => dialog.dismiss());
  await cancel.click();
  ensure(cancellations.length === 0, 'dismissed confirmation cancelled broadcast');
  page.once('dialog', dialog => dialog.accept());
  await cancel.click();
  await page.getByRole('alert').filter({ hasText: 'Данные изменились' }).waitFor();
  ensure(await cancel.isDisabled(), 'stale mutation remained actionable before refresh');
  await page.getByRole('button', { name: 'Обновить историю', exact: true }).click();
  await page.getByRole('heading', { name: 'Синтетическая рассылка' }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await cancel.click();
  await page.getByRole('status').filter({ hasText: 'Отмена сохранена' }).waitFor();
  await page.getByText(/Отменена ·/).waitFor();
  ensure(cancellations.length === 2 && cancellations[0].key !== cancellations[1].key && cancellations[1].body.expectedVersion === 10, 'conflict did not require refreshed version and new confirmed intent');
  ensure(await cancel.count() === 0, 'cancelled broadcast still offered cancellation');
  await page.getByRole('button', { name: 'Создать рассылку', exact: true }).click();
  await page.getByRole('button', { name: 'Группы и топики', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Синтетический отказ списка групп' }).waitFor();
  groupListFailure = false;
  await page.getByRole('button', { name: 'Обновить разрешённые адресаты', exact: true }).click();
  await page.getByRole('checkbox', { name: wholeLabel, exact: true }).check();
  await page.getByRole('button', { name: 'Ещё группы и топики', exact: true }).click();
  await page.getByRole('checkbox', { name: topicLabel, exact: true }).check();
  await page.getByRole('textbox', { name: 'Текст рассылки', exact: true }).fill('Синтетическая рассылка в разрешённые группы');
  await page.getByRole('radio', { name: 'Запланировать', exact: true }).check();
  await page.getByRole('textbox', { name: 'Дата · МСК', exact: true }).fill('2026-10-08');
  await page.getByRole('textbox', { name: 'Время · МСК', exact: true }).fill('12:00');
  for (const width of [320,1024]) {
    await page.setViewportSize({ width, height: 720 });
    await page.getByRole('searchbox', { name: 'Поиск группы или топика', exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `groups overflow at ${width}`);
    await page.screenshot({ path: `output/playwright/broadcast-groups/${width}-picker.png`, animations: 'disabled' });
  }
  await page.getByRole('searchbox', { name: 'Поиск группы или топика', exact: true }).fill('ВАЖНОЕ');
  ensure(await page.getByRole('checkbox', { name: wholeLabel, exact: true }).count() === 0, 'search did not filter groups');
  ensure(await page.getByText(/Выбрано разрешений: 2/).count() === 1, 'search changed selection');
  await page.getByRole('searchbox', { name: 'Поиск группы или топика', exact: true }).fill('');
  groupRevoked = true;
  await page.getByRole('button', { name: 'Обновить разрешённые адресаты', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Выбрано адресатов, которых нет' }).waitFor();
  ensure(await page.getByRole('button', { name: 'Запланировать', exact: true }).isDisabled(), 'revoked/unloaded selection allowed submit');
  ensure(await page.getByText(/Выбрано разрешений: 2/).count() === 1, 'revoked selection silently dropped');
  await page.getByRole('button', { name: 'Снять отсутствующих адресатов', exact: true }).click();
  groupRevoked = false;
  await page.getByRole('button', { name: 'Обновить разрешённые адресаты', exact: true }).click();
  await page.getByRole('button', { name: 'Ещё группы и топики', exact: true }).click();
  await page.getByRole('checkbox', { name: topicLabel, exact: true }).check();
  await page.getByRole('button', { name: 'Запланировать', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Сервер не подтвердил результат' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Ещё группы и топики', exact: true }).click();
  ensure(await page.getByRole('checkbox', { name: topicLabel, exact: true }).isChecked(), 'group selection lost after reload');
  ensure(await page.getByRole('textbox', { name: 'Дата · МСК', exact: true }).inputValue() === '2026-10-08', 'group schedule lost after reload');
  await page.getByRole('button', { name: 'Запланировать', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Рассылка сохранена в очереди' }).waitFor();
  ensure(groupRequests.length === 2 && groupRequests[0].key === groupRequests[1].key && JSON.stringify(groupRequests[0].body) === JSON.stringify(groupRequests[1].body), 'group replay changed command/key');
  const command = groupRequests[1].body;
  ensure(command.recipientMode === 'groups' && command.groupTargetIds.join(',') === 'g1,g2' && command.scheduledAt === '2026-10-08T09:00:00.000Z', 'group command wrong');
  ensure(!('recipientIds' in command) && !('competencies' in command) && !('chatId' in command) && !('botId' in command), 'group command mixed audience or raw transport IDs');
  groupEmpty = true;
  await page.getByRole('button', { name: 'Обновить разрешённые адресаты', exact: true }).click();
  await page.getByText(/Разрешённых групп пока нет/).waitFor();
  for (const width of [320,1024]) {
    await page.setViewportSize({ width, height: 720 });
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow at ${width}`);
  }
  durable = false;
  await page.reload();
  await page.getByRole('button', { name: 'Создать рассылку', exact: true }).click();
  ensure(await page.getByRole('radio', { name: 'Запланировать', exact: true }).count() === 0, 'legacy server advertised unsupported scheduling');
  ensure(await page.getByRole('button', { name: 'История рассылок', exact: true }).count() === 0, 'legacy server advertised unsupported history');
  ensure(await page.getByRole('button', { name: 'Группы и топики', exact: true }).count() === 0, 'legacy server advertised unsupported groups');
  return { passed: true, requests: requests.length, historyCalls, transfers: transfers.length, retries: retries.length, cancellations: cancellations.length, groupRequests: groupRequests.length, groupListCalls, checked: 'personal regression; group list failure/pagination/search/revoke/empty, draft+schedule reload, v1 exclusive audience, same-key replay, 320/1024, legacy gate' };
}
