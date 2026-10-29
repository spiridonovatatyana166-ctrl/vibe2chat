import type { IncomingMessage, ServerResponse } from 'node:http';

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* битое значение игнорируем */
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
  sameSite: 'Strict' | 'Lax';
  path?: string;
}

export function setCookie(res: ServerResponse, name: string, value: string, opts: CookieOptions): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    'HttpOnly',
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.secure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : typeof prev === 'string' ? [prev] : [];
  res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
}

export function clearCookie(res: ServerResponse, name: string, secure: boolean, path = '/'): void {
  setCookie(res, name, '', { maxAgeSeconds: 0, secure, sameSite: 'Lax', path });
}
