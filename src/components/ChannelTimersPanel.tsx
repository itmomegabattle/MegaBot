import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  channelTimerLink, readChannelTimerDraft, renderChannelTimer, timerFields, timerIntervals,
  type ChannelTimer, type ChannelTimerDraft, type TimerChannel,
} from '../channelTimers.js';

const presets = {
  concert: 'Обратный отсчет до концерта:\nОсталось {days} дней, {hours} часов, {minutes} минут, {seconds} секунд.',
  clock: 'До начала осталось {clock}',
  short: 'До начала: {days} дн. {hours} ч. {minutes} мин.',
};
const initial: ChannelTimerDraft = { date: '', time: '19:00', template: presets.concert, finalText: '', interval: 1 };
const labels = { publishing: 'Публикуется', running: 'Идёт отсчёт', paused: 'На паузе', finished: 'Завершён', failed: 'Ошибка', unknown: 'Проверьте публикацию', deleting: 'Удаляется из канала', deleted: 'Удалён' };
const field = 'w-full rounded-xl border border-blue-100 bg-white px-3 py-2 text-sm text-slate-900';
const button = 'min-h-10 rounded-xl border border-blue-200 px-3 py-2 text-sm font-bold text-[#005BC4] disabled:opacity-50';
const primary = 'min-h-11 rounded-xl bg-[#0069E0] px-4 py-2 text-sm font-bold text-white disabled:opacity-50';
const card = 'space-y-3 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm';

type Snapshot = { channels: TimerChannel[]; timers: ChannelTimer[]; selected?: string };

async function api(path = '', body?: object): Promise<Snapshot> {
  const response = await fetch('/api/admin/channel-timers' + path, body && {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Не удалось связаться с сервером.');
  return payload;
}

export function ChannelTimersPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ channels: [], timers: [] });
  const [draft, setDraft] = useState(initial);
  const [channelId, setChannelId] = useState('');
  const [reference, setReference] = useState('');
  const [editing, setEditing] = useState<ChannelTimer>();
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const templateInput = useRef<HTMLTextAreaElement>(null);
  const publishId = useRef('');
  const locked = useRef(false);
  const selected = snapshot.channels.find(channel => channel.id === channelId);
  const validDraft = readChannelTimerDraft({ ...draft }, now, editing);
  const deleting = snapshot.timers.some(timer => timer.status === 'deleting');
  useEffect(() => {
    if (!deleting) return;
    const poll = setInterval(() => {
      if (!locked.current) void api().then(data => {
        if (!locked.current) setSnapshot(data);
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(poll);
  }, [deleting]);

  useEffect(() => {
    let live = true;
    api().then(data => { if (live) setSnapshot(data); })
      .catch(error => { if (live) setError(error.message); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  async function run(path: string, body?: object) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await api(path, body);
      setSnapshot(data);
      if (data.selected) { setChannelId(data.selected); setReference(''); }
      return data;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось выполнить действие.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  function updateDraft<K extends keyof ChannelTimerDraft>(key: K, value: ChannelTimerDraft[K]) {
    setReviewing(false);
    publishId.current = '';
    setDraft(current => ({ ...current, [key]: value }));
  }

  function insertField(name: string) {
    const input = templateInput.current;
    const start = input?.selectionStart ?? draft.template.length;
    const end = input?.selectionEnd ?? start;
    const token = '{' + name + '}';
    updateDraft('template', draft.template.slice(0, start) + token + draft.template.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!validDraft || !selected || (!editing && !selected.canPost) || busy) return;
    if (!editing && !reviewing) { setReviewing(true); return; }
    publishId.current ||= crypto.randomUUID();
    const id = editing?.id || publishId.current;
    const data = await run(editing ? '/update' : '/publish', { ...draft, id, channelId, action: 'edit' });
    if (!data) return;
    const item = data.timers.find(timer => timer.id === id);
    if (!item) return;
    if (item.status === 'failed' || item.status === 'unknown') {
      setError(item.error || 'Проверьте публикацию в канале.');
      return;
    }
    if (item.status === 'publishing') { setNotice('Запрос уже выполняется. Обновите список.'); return; }
    setNotice(editing ? 'Изменения сохранены. Бот применит их к посту при ближайшем обновлении.' : 'Пост опубликован.');
    setEditing(undefined);
    setReviewing(false);
    publishId.current = '';
  }

  return <div className="space-y-4">
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-black">Каналы Telegram</h2>
        <button className={button} type="button" disabled={busy} onClick={() => void run('')}>Обновить список</button>
      </div>
      <p className="text-sm text-slate-600">Каналы появляются после добавления бота. Старый канал можно найти по ссылке или ID.</p>
      {snapshot.channels.length > 0 && <ul className="max-h-36 space-y-1 overflow-auto text-sm">
        {snapshot.channels.map(channel => <li className="flex flex-wrap justify-between gap-x-2" key={channel.id}>
          <span className="break-all">{channel.title}{channel.username && ' · @' + channel.username}</span>
          <span className={channel.canPost ? 'text-emerald-700' : 'text-slate-500'}>{channel.canPost ? 'Можно публиковать' : 'Проверьте права'}</span>
        </li>)}
      </ul>}
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void run('/channel', { reference }); }}>
        <input className={field + ' sm:flex-1'} aria-label="Ссылка или ID канала" placeholder="@канал, ссылка или ID" value={reference} onChange={event => setReference(event.target.value)} />
        <button className={button} disabled={busy || !reference.trim() || !!editing}>Найти канал</button>
      </form>
    </section>

    <form className={card} onSubmit={submit}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-black">{editing ? 'Редактировать таймер' : 'Новый пост с таймером'}</h2>
        {editing && <button className={button} type="button" onClick={() => { setEditing(undefined); setDraft(initial); }}>Отменить редактирование</button>}
      </div>
      <label className="block text-sm font-bold">Канал
        <select className={field} required disabled={!!editing} value={channelId} onChange={event => {
          setChannelId(event.target.value); setReviewing(false); publishId.current = '';
        }}>
          <option value="">Выберите канал</option>
          {snapshot.channels.map(channel => <option key={channel.id} value={channel.id} disabled={!channel.canPost && !editing}>{channel.title}</option>)}
        </select>
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block min-w-0 text-sm font-bold">Дата окончания
          <input className={field} type="date" required value={draft.date} onChange={event => updateDraft('date', event.target.value)} />
        </label>
        <label className="block text-sm font-bold">Время · МСК
          <input className={field} type="time" required value={draft.time} onChange={event => updateDraft('time', event.target.value)} />
        </label>
        <label className="block text-sm font-bold">Обновлять
          <select className={field} value={draft.interval} onChange={event => updateDraft('interval', Number(event.target.value))}>
            {timerIntervals.map(interval => <option key={interval} value={interval}>{interval < 60 ? 'Раз в ' + interval + ' с' : 'Раз в ' + interval / 60 + ' мин'}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Шаблоны текста">
        {([['concert', 'Концерт'], ['clock', 'ЧЧ:ММ:СС'], ['short', 'Кратко']] as const).map(([key, label]) => (
          <button type="button" className={button} key={key} onClick={() => updateDraft('template', presets[key])}>{label}</button>
        ))}
      </div>
      <label className="block text-sm font-bold">Текст поста
        <textarea ref={templateInput} className={field} maxLength={3800} rows={4} required value={draft.template}
          onChange={event => updateDraft('template', event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-1.5" aria-label="Вставить значение таймера">
        {timerFields.map((name, index) => <button className={button} key={name} type="button" title={'{' + name + '}'}
          onClick={() => insertField(name)}>{['Дни', 'Часы', 'Минуты', 'Секунды', 'ЧЧ:ММ:СС', 'Всего часов'][index]}</button>)}
      </div>
      <label className="block text-sm font-bold">Текст после окончания
        <textarea className={field} rows={2} maxLength={4096} placeholder="Оставьте пустым, чтобы показать нули" value={draft.finalText}
          onChange={event => updateDraft('finalText', event.target.value)} />
      </label>
      <div className="rounded-2xl bg-[#EDF5FF] p-3 text-slate-900">
        <h3 className="text-sm font-black">{reviewing ? 'Публикация в «' + selected?.title + '»' : 'Предпросмотр'}</h3>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{validDraft
          ? renderChannelTimer(draft.template, validDraft.deadline, now) : 'Выберите будущую дату и добавьте в текст значение таймера.'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={primary} disabled={busy || !validDraft || !selected || (!editing && !selected.canPost)}>
          {busy ? 'Подождите…' : editing ? 'Сохранить' : reviewing ? 'Опубликовать в канале' : 'Проверить перед публикацией'}
        </button>
        {reviewing && <button type="button" className={button} onClick={() => setReviewing(false)}>Назад к тексту</button>}
      </div>
      {error && <p role="alert" className="text-sm font-bold text-rose-700">{error}</p>}
      {notice && <p role="status" className="text-sm font-bold text-emerald-700">{notice}</p>}
    </form>

    <section className={card}>
      <h2 className="font-black">Посты с таймерами</h2>
      {!snapshot.timers.length && <p className="text-sm text-slate-600">Здесь появятся посты, созданные через эту панель.</p>}
      {snapshot.timers.map(timer => <article key={timer.id} className="space-y-2 border-t border-blue-100 pt-3">
        <div className="flex flex-wrap justify-between gap-1 text-sm">
          <strong>{snapshot.channels.find(channel => channel.id === timer.channelId)?.title || timer.channelId}</strong>
          <span>{labels[timer.status]} · {timer.date} {timer.time} МСК</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">{(timer.status === 'finished' && timer.finalText
          || renderChannelTimer(timer.template, timer.deadline, timer.pausedAt ?? now)).slice(0, 180)}</p>
        {timer.error && <p className="text-sm text-rose-700">{timer.error}</p>}
        <div className="flex flex-wrap gap-2">
          {timer.messageId && <>
            <a className={button} href={channelTimerLink(timer.channelId, timer.messageId)} target="_blank" rel="noreferrer">Открыть пост</a>
            <button className={button} type="button" disabled={busy || timer.status === 'deleting'} onClick={() => {
              setEditing(timer); setChannelId(timer.channelId); setDraft(timer); setReviewing(false);
              templateInput.current?.scrollIntoView({ block: 'center' });
            }}>Править</button>
            <button className={button + ' border-rose-200 text-rose-700'} type="button"
              disabled={busy || timer.status === 'deleting'} onClick={() => {
                if (!window.confirm('Остановить таймер и удалить пост из Telegram-канала?')) return;
                void run('/update', { id: timer.id, action: 'delete' }).then(data => {
                  if (data && editing?.id === timer.id) { setEditing(undefined); setDraft(initial); }
                });
              }}>Удалить пост</button>
          </>}
          {(timer.status === 'running' || (timer.messageId && ['paused', 'failed'].includes(timer.status) && timer.deadline > now)) &&
            <button className={button} type="button" disabled={busy} onClick={() => void run('/update', {
              id: timer.id, action: timer.status === 'running' ? 'pause' : 'resume',
            })}>{timer.status === 'running' ? 'Пауза' : 'Возобновить'}</button>}
        </div>
      </article>)}
    </section>
  </div>;
}
