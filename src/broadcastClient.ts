import { projectDateTimeInstant } from './projectTime';
import { readFormDraft, removeFormDraft, writeFormDraft } from './formDrafts';

export function broadcastScheduledAt(date: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  return projectDateTimeInstant(date, time)?.toISOString() ?? null;
}

export function broadcastTimeLabel(instant: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(instant)) + ' МСК';
}

export const broadcastStatusLabels: Record<string, string> = {
  scheduled: 'Запланирована', planned: 'В очереди', retry: 'Ожидает повтора', claimed: 'Готовится к отправке',
  sending: 'Отправляется', partial: 'Частично отправлена', sent: 'Подтверждена Telegram', failed: 'Ошибка',
  unknown: 'Результат неизвестен', cancelled: 'Отменена', expired: 'Срок истёк', unavailable: 'Telegram недоступен',
};

// Key survives ambiguous HTTP failures and explicit retry, including closing/reopening the form.
export function broadcastRequestKey(storage: Storage, userId: string, body: unknown, approveNewIntent: () => boolean = () => false) {
  const fingerprint = JSON.stringify(body);
  const previous = readFormDraft<{ fingerprint: string; key: string }>(storage, userId, 'broadcast-request')?.payload;
  if (previous?.fingerprint === fingerprint && typeof previous.key === 'string') return previous.key;
  if (previous && !approveNewIntent()) throw new Error('Новая рассылка не создана. Сначала проверь предыдущую в истории: сервер мог сохранить её до потери ответа.');
  const key = crypto.randomUUID();
  if (!writeFormDraft(storage, { userId, kind: 'broadcast-request', entityId: 'new', context: '', payload: { fingerprint, key } })) {
    throw new Error('Не удалось сохранить ключ безопасного повтора. Разреши хранилище браузера и повтори — рассылка не отправлена.');
  }
  return key;
}

export class BroadcastHttpError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// Persist the original version too: after a lost reply, replay the same command, not a new one.
export async function broadcastAction(storage: Storage, userId: string, path: string, body: { expectedVersion: number; acknowledgeDuplicateRisk?: true; scheduledAt?: string }) {
  let intent = readFormDraft<{ body: typeof body; key: string }>(storage, userId, 'broadcast-action', path)?.payload;
  if (intent && intent.body.scheduledAt !== body.scheduledAt) throw new Error('Предыдущий перенос ещё не подтверждён. Проверь историю и повтори исходное время; новый перенос не отправлен.');
  if (!intent) {
    intent = { body, key: crypto.randomUUID() };
    if (!writeFormDraft(storage, { userId, kind: 'broadcast-action', entityId: path, context: '', payload: intent })) {
      throw new Error('Не удалось сохранить безопасный повтор. Разреши хранилище браузера; действие не выполнено.');
    }
  }
  try {
    const result = await broadcastJson(path, { ...intent, action: true });
    if (typeof result.id !== 'string' || !Number.isSafeInteger(result.version)) throw new Error('Сервер не подтвердил действие. Повтори его; ключ безопасного повтора сохранён.');
    removeFormDraft(storage, userId, 'broadcast-action', path);
    return result;
  } catch (error) {
    if (error instanceof BroadcastHttpError && [400, 409, 422, 429].includes(error.status)) removeFormDraft(storage, userId, 'broadcast-action', path);
    throw error;
  }
}

export async function broadcastJson(path: string, options?: { body: unknown; key: string; action?: boolean }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      cache: 'no-store', signal: controller.signal,
      ...(options ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': options.key }, body: JSON.stringify(options.body) } : {}),
    });
    const isJson = response.headers.get('content-type')?.includes('application/json');
    if (response.ok && !isJson) throw new Error('Сервер не подтвердил результат. Повтори запрос; черновик сохранён.');
    const result = isJson ? await response.json() : {};
    if (!response.ok) {
      if (response.status === 401) throw new Error('Сессия истекла. Открой Mini App заново из бота; черновик сохранён.');
      if (response.status === 403) throw new Error('Нет доступа к этой рассылке. Обнови данные или обратись к администратору.');
      if (response.status === 409) throw new BroadcastHttpError('Данные изменились или действие уже недоступно. Обнови историю и журнал, проверь результат и подтверди действие заново.', 409);
      throw new BroadcastHttpError(result.message || result.error || 'Не удалось выполнить запрос. Повтори попытку; черновик сохранён.', response.status);
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted || error instanceof TypeError) {
      if (options?.action) throw new Error('Сервер не подтвердил действие. Проверь историю и повтори ту же кнопку — ключ безопасного повтора сохранён, новая команда не создаётся.');
      throw new Error('Сервер не подтвердил результат. Проверь соединение и повтори с тем же текстом — черновик сохранён, повтор не создаст вторую рассылку.');
    }
    throw error;
  } finally { clearTimeout(timer); }
}
