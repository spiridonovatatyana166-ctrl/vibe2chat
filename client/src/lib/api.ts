import type { IceConfig, PublicConfig, SessionInfo } from '../../../shared/protocol';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером. Проверьте интернет');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Ошибка ${res.status}`, data.code);
  return data as T;
}

export const getConfig = () => api<PublicConfig>('/api/config');
export const getSession = () => api<SessionInfo>('/api/session');
export const createSession = (turnstileToken?: string) =>
  api<SessionInfo>('/api/session', { method: 'POST', body: { ageConfirmed: true, rulesAccepted: true, turnstileToken } });
export const deleteSession = () => api<{ ok: true }>('/api/session', { method: 'DELETE' });

let iceCache: { value: IceConfig; expires: number } | null = null;

/** ICE-серверы (STUN/TURN). TURN-учётки временные, поэтому кэшируем с запасом по сроку. */
export async function getIceConfig(): Promise<IceConfig> {
  if (iceCache && iceCache.expires > Date.now()) return iceCache.value;
  const value = await api<IceConfig>('/api/ice');
  iceCache = { value, expires: Date.now() + Math.max(60, value.ttlSeconds / 2) * 1000 };
  return value;
}
