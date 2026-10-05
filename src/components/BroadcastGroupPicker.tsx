import React, { useEffect, useRef, useState } from 'react';
import { broadcastJson } from '../broadcastClient';
import { Button, Field, InlineNotice } from './ui';

export type BroadcastGroupOption = { id: string; label: string };

export default function BroadcastGroupPicker({ userId, selected, onChange, onOptions, onLoading }: {
  userId: string; selected: string[]; onChange: (ids: string[]) => void;
  onOptions: (options: BroadcastGroupOption[]) => void; onLoading: (loading: boolean) => void;
}) {
  const [items, setItems] = useState<BroadcastGroupOption[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const generation = useRef(0);
  const owner = useRef(userId); owner.current = userId;
  const requestBusy = useRef(false);

  async function load(after: string | undefined, current: () => boolean) {
    if (requestBusy.current) return;
    requestBusy.current = true; setLoading(true); onLoading(true); setError('');
    try {
      const result = await broadcastJson(`/api/v1/broadcast-group-targets?limit=50${after ? '&cursor=' + encodeURIComponent(after) : ''}`);
      if (!Array.isArray(result.items) || !result.items.every((item: any) => item && typeof item.id === 'string' && !!item.id && typeof item.label === 'string' && !!item.label) || result.nextCursor != null && typeof result.nextCursor !== 'string') throw new Error('Сервер вернул неполный список. Обнови разрешённые адресаты.');
      if (!current()) return;
      const next = after ? [...items, ...result.items] : result.items;
      setItems(next); onOptions(next); setCursor(result.nextCursor);
    } catch (e: any) { if (current()) { setError(e.message); onOptions([]); } }
    finally { if (current()) { requestBusy.current = false; setLoading(false); onLoading(false); } }
  }
  useEffect(() => {
    const token = ++generation.current;
    const current = () => owner.current === userId && generation.current === token;
    requestBusy.current = false; setItems([]); setCursor(null); onOptions([]);
    void load(undefined, current);
    return () => { generation.current++; requestBusy.current = false; onOptions([]); onLoading(false); };
    // The explicit refresh owns reload; selection changes must not refetch the list.
  }, [userId, revision]);
  const visible = items.filter(item => item.label.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')));
  const missing = selected.filter(id => !items.some(item => item.id === id));

  return <section className="space-y-3" aria-label="Разрешённые группы и топики">
    <p className="text-xs font-semibold">Только разрешения администратора. Название указывает группу или топик; при выборе группы и её топика будут две отдельные отправки. Наличие разрешения не подтверждает доступ бота.</p>
    <Field label="Поиск группы или топика"><input type="search" value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded-[var(--mega-radius-control)] border border-blue-100 p-3" /></Field>
    {loading && <p role="status">Загружаю разрешённые адресаты…</p>}
    {error && <InlineNotice variant="error">{error}</InlineNotice>}
    {!loading && !error && !items.length && <p>Разрешённых групп пока нет. Администратору нужно добавить разрешение; рабочие группы автоматически не подключаются.</p>}
    {!loading && !error && items.length > 0 && !visible.length && <p>По этому названию ничего не найдено.</p>}
    {visible.map(item => <label key={item.id} className="flex min-h-11 items-center gap-3 rounded-[var(--mega-radius-control)] border border-blue-100 p-3">
      <input type="checkbox" checked={selected.includes(item.id)} onChange={() => onChange(selected.includes(item.id) ? selected.filter(id => id !== item.id) : [...selected, item.id])} disabled={loading || !!error || !selected.includes(item.id) && selected.length >= 100} />
      <span className="min-w-0 break-words font-bold">{item.label}</span>
    </label>)}
    {missing.length > 0 && <InlineNotice variant="warning">Выбрано адресатов, которых нет в загруженном списке: {missing.length}. Загрузи остальные страницы или сними недоступный выбор — отправка заблокирована.</InlineNotice>}
    {missing.length > 0 && <Button type="button" variant="secondary" disabled={loading} onClick={() => onChange(selected.filter(id => items.some(item => item.id === id)))}>Снять отсутствующих адресатов</Button>}
    <Button type="button" variant="secondary" pending={loading} onClick={() => setRevision(value => value + 1)}>Обновить разрешённые адресаты</Button>
    {cursor && <Button type="button" variant="secondary" pending={loading} onClick={() => {
      const token = generation.current;
      void load(cursor, () => owner.current === userId && generation.current === token);
    }}>Ещё группы и топики</Button>}
  </section>;
}
