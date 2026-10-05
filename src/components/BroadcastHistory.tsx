import React, { useEffect, useRef, useState } from 'react';
import { User } from '../types';
import { broadcastAction, BroadcastHttpError, broadcastJson, broadcastScheduledAt, broadcastStatusLabels, broadcastTimeLabel } from '../broadcastClient';
import { readFormDraft, removeFormDraft, writeFormDraft } from '../formDrafts';
import { projectClock } from '../projectTime';
import { Button, Field, InlineNotice } from './ui';

type Broadcast = {
  id: string; title: string; body: string; status: string; scheduledAt: string;
  targetCount: number; deliveryCounts: Record<string, number>;
  version: number; contentRevision: number; lifecycleStatus: string;
  reschedulable?: boolean;
};
type Delivery = {
  id: string; recipientId: string | null; status: string; partNumber: number; partCount: number;
  attemptCount: number; sentAt: string | null; errorCode: string | null;
  contentRevision: number; replacedBy: string | null; expiresAt: string | null;
};

export default function BroadcastHistory({ revision, userId, users }: { revision: number; userId: string; users: User[] }) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<Broadcast[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [deliveryCursor, setDeliveryCursor] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [journalVersion, setJournalVersion] = useState<number | null>(null);
  const [blockedId, setBlockedId] = useState('');
  const [transfer, setTransfer] = useState<{ id: string; date: string; time: string } | null>(null);
  const [action, setAction] = useState<{ id: string; busy: boolean; error: string; success: string } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const owner = useRef(userId);
  owner.current = userId;
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const actionGeneration = useRef(0);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    detailGeneration.current++;
    actionGeneration.current++;
    setItems([]); setCursor(null); setOpen(false); setSelected(''); setDeliveries([]);
    setDetailLoading(false); setDetailError(''); setDeliveryCursor(null);
    setJournalVersion(null); setAction(null); busy.current = false;
    setBlockedId('');
    setTransfer(null);
  }, [userId]);

  useEffect(() => {
    listGeneration.current++;
    if (!open) return;
    let active = true;
    setLoading(true); setError('');
    broadcastJson('/api/v1/broadcasts?limit=20').then(result => {
      if (!Array.isArray(result.items)) throw new Error('Сервер вернул неполную историю. Повтори загрузку.');
      if (active) { setItems(result.items); setCursor(result.nextCursor); setBlockedId(''); }
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, revision, refresh, userId]);

  async function loadMore() {
    const generation = listGeneration.current;
    const current = () => mounted.current && owner.current === userId && listGeneration.current === generation;
    setLoading(true); setError('');
    try {
      const result = await broadcastJson(`/api/v1/broadcasts?limit=20&cursor=${encodeURIComponent(cursor!)}`);
      if (!Array.isArray(result.items)) throw new Error('Сервер вернул неполную историю. Повтори загрузку.');
      if (!current()) return;
      setItems(current => [...current, ...result.items]); setCursor(result.nextCursor);
    } catch (e: any) { if (current()) setError(e.message); } finally { if (current()) setLoading(false); }
  }
  async function showDeliveries(id: string, after?: string) {
    if (detailLoading || busy.current) return;
    const generation = ++detailGeneration.current;
    const current = () => mounted.current && owner.current === userId && detailGeneration.current === generation;
    setSelected(id); setDetailLoading(true); setDetailError('');
    if (!after) { setDeliveries([]); setDeliveryCursor(null); setJournalVersion(null); }
    try {
      const result = await broadcastJson(`/api/v1/broadcasts/${encodeURIComponent(id)}/deliveries?limit=30${after ? '&cursor=' + encodeURIComponent(after) : ''}`);
      if (!Array.isArray(result.items)) throw new Error('Сервер вернул неполный журнал. Повтори загрузку.');
      if (!current()) return;
      setDeliveries(current => after ? [...current, ...result.items] : result.items); setDeliveryCursor(result.nextCursor);
      setJournalVersion(Number.isSafeInteger(result.version) ? result.version : null);
    } catch (e: any) { if (current()) setDetailError(e.message); } finally { if (current()) setDetailLoading(false); }
  }

  function editTime(item: Broadcast) {
    const path = `/api/v1/broadcasts/${encodeURIComponent(item.id)}/reschedule`;
    const pending = readFormDraft<{ body: { scheduledAt: string } }>(sessionStorage, userId, 'broadcast-action', path)?.payload;
    const clock = projectClock(new Date(pending?.body.scheduledAt || item.scheduledAt));
    const draft = readFormDraft<{ date: string; time: string }>(sessionStorage, userId, 'broadcast-time', item.id)?.payload;
    setTransfer({ id: item.id, ...(!pending && draft ? draft : { date: clock.dateKey, time: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` }) });
  }
  function changeTime(values: { date?: string; time?: string }) {
    if (!transfer) return;
    const next = { ...transfer, ...values };
    setTransfer(next);
    writeFormDraft(sessionStorage, { userId, kind: 'broadcast-time', entityId: next.id, context: '', payload: { date: next.date, time: next.time } });
  }
  async function mutate(item: Broadcast, delivery?: Delivery, scheduledAt?: string) {
    if (busy.current || loading || detailLoading || blockedId === item.id) return;
    const expectedVersion = delivery ? journalVersion : item.version;
    if (!Number.isSafeInteger(expectedVersion)) return;
    const confirmation = scheduledAt ? `Перенести рассылку на ${broadcastTimeLabel(scheduledAt)}? Адресаты, текст и настройки останутся прежними. Отправка по старому времени будет отменена.` : delivery
      ? `Повторить только часть ${delivery.partNumber}/${delivery.partCount}? Telegram мог уже доставить её — получатель может получить дубль. Остальные части не повторяются.`
      : 'Отменить оставшиеся отправки этой рассылки? Уже доставленные сообщения не удалятся; начатую отправку нельзя гарантированно остановить.';
    if (!window.confirm(confirmation)) return;
    busy.current = true;
    const generation = ++actionGeneration.current;
    const current = () => mounted.current && owner.current === userId && actionGeneration.current === generation;
    setAction({ id: item.id, busy: true, error: '', success: '' });
    const path = `/api/v1/broadcasts/${encodeURIComponent(item.id)}/${scheduledAt ? 'reschedule' : delivery ? `deliveries/${encodeURIComponent(delivery.id)}/retry` : 'cancel'}`;
    try {
      await broadcastAction(sessionStorage, userId, path, { expectedVersion: expectedVersion!, ...(scheduledAt ? { scheduledAt } : delivery ? { acknowledgeDuplicateRisk: true as const } : {}) });
      if (!current()) return;
      detailGeneration.current++;
      setSelected(''); setDeliveries([]); setJournalVersion(null);
      if (scheduledAt) { setTransfer(null); removeFormDraft(sessionStorage, userId, 'broadcast-time', item.id); }
      setAction({ id: item.id, busy: false, error: '', success: scheduledAt ? `Перенос сохранён: ${broadcastTimeLabel(scheduledAt)}. Адресаты и настройки не изменены.` : delivery ? 'Повтор выбранной части сохранён в очереди. Это ещё не подтверждение доставки.' : 'Отмена сохранена. Уже отправленные сообщения остаются у получателей.' });
      setRefresh(value => value + 1);
    } catch (e: any) {
      if (current()) {
        if (e instanceof BroadcastHttpError && e.status === 409) setBlockedId(item.id);
        setAction({ id: item.id, busy: false, error: e.message, success: '' });
      }
    } finally { if (current()) busy.current = false; }
  }

  return <section className="mt-4 space-y-3" aria-label="История рассылок">
    <Button type="button" variant="secondary" disabled={action?.busy} onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls="broadcast-history">История рассылок</Button>
    {open && <div id="broadcast-history" className="space-y-3">
      <p className="text-xs font-semibold text-slate-600">Подтверждение Telegram не означает прочтение. Обнови историю, чтобы увидеть новые результаты.</p>
      <Button type="button" variant="ghost" disabled={action?.busy} pending={loading} onClick={() => { setOpen(false); setSelected(''); }}>Закрыть историю</Button>
      {loading && <p role="status">Загружаю рассылки…</p>}
      {error && <InlineNotice variant="error">{error}</InlineNotice>}
      {!loading && !error && !items.length && <p>Рассылок пока нет. Создай первую в форме выше.</p>}
      {!loading && <Button type="button" variant="secondary" disabled={action?.busy || detailLoading} onClick={() => { detailGeneration.current++; setSelected(''); setJournalVersion(null); setRefresh(value => value + 1); }}>Обновить историю</Button>}
      {items.map(item => <article key={item.id} className="space-y-2 border-t border-blue-100 pt-3">
        <h3 className="break-words font-black">{item.title || 'Без заголовка'}</h3>
        <p className="text-sm font-bold">{broadcastStatusLabels[item.status] || item.status} · {broadcastTimeLabel(item.scheduledAt)}</p>
        <p className="break-words text-xs font-semibold">{item.targetCount} адресатов · {Object.entries(item.deliveryCounts).map(([status, count]) => `${broadcastStatusLabels[status] || status}: ${count}`).join(' · ')}</p>
        {item.deliveryCounts.unknown > 0 && <InlineNotice variant="warning">Telegram мог принять сообщение. Повтор может создать дубль.</InlineNotice>}
        <details><summary className="min-h-11 cursor-pointer py-2 font-bold">Текст рассылки</summary><p className="whitespace-pre-wrap break-words">{item.body}</p></details>
        {action?.id === item.id && <>{action.busy && <p role="status">Сохраняю действие…</p>}{action.error && <InlineNotice variant="error">{action.error}</InlineNotice>}{action.success && <InlineNotice variant="success">{action.success}</InlineNotice>}</>}
        {item.reschedulable === true && <Button type="button" variant="secondary" disabled={loading || detailLoading || action?.busy || blockedId === item.id} aria-expanded={transfer?.id === item.id} aria-controls={`transfer-${item.id}`} onClick={() => transfer?.id === item.id ? setTransfer(null) : editTime(item)}>Перенести время</Button>}
        {transfer?.id === item.id && <form id={`transfer-${item.id}`} onSubmit={event => {
          event.preventDefault();
          const due = broadcastScheduledAt(transfer.date, transfer.time);
          if (!due) { setAction({ id: item.id, busy: false, error: 'Укажи корректную дату и время МСК.', success: '' }); return; }
          void mutate(item, undefined, due);
        }}>
          <fieldset disabled={loading || detailLoading || action?.busy || blockedId === item.id || item.reschedulable !== true} className="space-y-3">
            <legend className="font-bold">Новое время · МСК</legend>
            <p className="text-xs font-semibold">Меняется только время. Состав адресатов, текст и политика просрочки сохраняются. Допустимо от 30 секунд до 365 дней вперёд.</p>
            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
              <Field label="Новая дата · МСК"><input type="date" required value={transfer.date} onChange={event => changeTime({ date: event.target.value })} className="w-full rounded-xl border border-blue-100 p-3" /></Field>
              <Field label="Новое время · МСК"><input type="time" required value={transfer.time} onChange={event => changeTime({ time: event.target.value })} className="w-full rounded-xl border border-blue-100 p-3" /></Field>
            </div>
            <Button type="submit" pending={action?.busy}>Подтвердить перенос</Button>
          </fieldset>
        </form>}
        {['scheduled', 'sending'].includes(item.lifecycleStatus) && Number.isSafeInteger(item.version) && <Button type="button" variant="danger" disabled={loading || detailLoading || action?.busy || blockedId === item.id} onClick={() => mutate(item)}>Отменить оставшиеся отправки</Button>}
        <Button type="button" variant="secondary" disabled={detailLoading || loading || action?.busy} aria-expanded={selected === item.id} aria-controls={`delivery-${item.id}`} onClick={() => selected === item.id ? setSelected('') : showDeliveries(item.id)}>Журнал отправок</Button>
        {selected === item.id && <div id={`delivery-${item.id}`} className="space-y-2">
          {detailLoading && <p role="status">Загружаю отправки…</p>}
          {detailError && <><InlineNotice variant="error">{detailError}</InlineNotice><Button type="button" variant="secondary" onClick={() => showDeliveries(item.id)}>Повторить загрузку</Button></>}
          {!detailLoading && !detailError && !deliveries.length && <p>Попыток отправки нет. Недоступные адресаты не получают фиктивную доставку.</p>}
          {deliveries.map(delivery => <div key={delivery.id} className="space-y-2"><p className="break-words text-sm">
            {users.find(user => user.id === delivery.recipientId)?.realName || (delivery.recipientId ? 'Участник' : 'Разрешённая группа')} · часть {delivery.partNumber}/{delivery.partCount} · {broadcastStatusLabels[delivery.status] || delivery.status} · попыток: {delivery.attemptCount}
            {delivery.sentAt && <> · {broadcastTimeLabel(delivery.sentAt)}</>}{delivery.errorCode && <> · {delivery.errorCode}</>}
          </p>
            {delivery.status === 'unknown' && !delivery.replacedBy && delivery.contentRevision === item.contentRevision && ['scheduled', 'sending'].includes(item.lifecycleStatus) && journalVersion !== null && (!delivery.expiresAt || new Date(delivery.expiresAt).getTime() > Date.now()) && <Button type="button" variant="secondary" disabled={loading || detailLoading || action?.busy || !!detailError || blockedId === item.id} onClick={() => mutate(item, delivery)}>Повторить часть {delivery.partNumber}/{delivery.partCount} с риском дубля</Button>}
            {delivery.replacedBy && <p className="text-xs font-semibold">Повтор уже создан. Исходная часть повторно не отправляется.</p>}
          </div>)}
          {deliveryCursor && <Button type="button" variant="secondary" disabled={action?.busy} pending={detailLoading} onClick={() => showDeliveries(item.id, deliveryCursor)}>Ещё отправки</Button>}
        </div>}
      </article>)}
      {cursor && <Button type="button" variant="secondary" disabled={action?.busy} pending={loading} onClick={loadMore}>Ещё рассылки</Button>}
    </div>}
  </section>;
}
