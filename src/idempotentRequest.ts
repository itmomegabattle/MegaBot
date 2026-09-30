function requestKey() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function idempotentPost(path: string, body: unknown) {
  const key = requestKey();
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  };
  try {
    return await fetch(path, init);
  } catch {
    // A transport failure can happen after the server committed. One retry with
    // the same key safely retrieves the original response.
    return fetch(path, init);
  }
}
