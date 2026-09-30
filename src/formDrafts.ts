export const FORM_DRAFT_SCHEMA = 1;
const FORM_DRAFT_PREFIX = `megabot-form-draft:v${FORM_DRAFT_SCHEMA}:`;

export type FormDraftEnvelope<T> = {
  schema: number;
  userId: string;
  kind: string;
  entityId: string;
  context: string;
  savedAt: string;
  payload: T;
};

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const part = (value: string) => encodeURIComponent(value || '-');

export function formDraftKey(userId: string, kind: string, entityId = 'new', context = '') {
  return `${FORM_DRAFT_PREFIX}${part(userId)}:${part(kind)}:${part(entityId)}:${part(context)}`;
}

export function writeFormDraft<T>(storage: DraftStorage, draft: Omit<FormDraftEnvelope<T>, 'schema' | 'savedAt'>) {
  const envelope: FormDraftEnvelope<T> = { ...draft, schema: FORM_DRAFT_SCHEMA, savedAt: new Date().toISOString() };
  try {
    storage.setItem(formDraftKey(draft.userId, draft.kind, draft.entityId, draft.context), JSON.stringify(envelope));
    return envelope;
  } catch {
    return null;
  }
}

export function readFormDraft<T>(storage: DraftStorage, userId: string, kind: string, entityId = 'new', context = '') {
  const key = formDraftKey(userId, kind, entityId, context);
  try {
    const parsed = JSON.parse(storage.getItem(key) || '') as FormDraftEnvelope<T>;
    if (parsed.schema !== FORM_DRAFT_SCHEMA || parsed.userId !== userId || parsed.kind !== kind || parsed.entityId !== entityId || parsed.context !== context) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function removeFormDraft(storage: DraftStorage, userId: string, kind: string, entityId = 'new', context = '') {
  try { storage.removeItem(formDraftKey(userId, kind, entityId, context)); } catch { /* Storage may be blocked. */ }
}

export function readLatestFormDraft<T>(storage: DraftStorage, userId: string, kind: string, context?: string) {
  const prefix = `${FORM_DRAFT_PREFIX}${part(userId)}:${part(kind)}:`;
  const drafts = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith(prefix)))
    .map((key) => {
      try { return JSON.parse(storage.getItem(key) || '') as FormDraftEnvelope<T>; } catch { storage.removeItem(key); return null; }
    })
    .filter((draft): draft is FormDraftEnvelope<T> => Boolean(
      draft && draft.schema === FORM_DRAFT_SCHEMA && draft.userId === userId && draft.kind === kind && (context === undefined || draft.context === context),
    ))
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  return drafts[0] || null;
}

export function removeUserFormDrafts(storage: DraftStorage, userId: string) {
  const userPrefix = `${FORM_DRAFT_PREFIX}${part(userId)}:`;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key?.startsWith(userPrefix)));
  keys.forEach((key) => { try { storage.removeItem(key); } catch { /* Best-effort logout cleanup. */ } });
  return keys.length;
}
