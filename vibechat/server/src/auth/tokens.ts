import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pwd: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Подписанный токен: base64url(JSON).base64url(HMAC-SHA256).
 * Используется для гостевой сессии и сессии администратора в httpOnly-cookie.
 */
export class TokenSigner {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    // Разные ключи для разных назначений, чтобы гостевой токен нельзя было выдать за админский.
    this.key = createHmac('sha256', secret).update(`vibechat:${purpose}`).digest();
  }

  sign<T extends object>(payload: T, ttlSeconds: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString(
      'base64url',
    );
    const mac = createHmac('sha256', this.key).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify<T extends object>(token: string | undefined | null): (T & { exp: number }) | null {
    if (!token || token.length > 2048) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = createHmac('sha256', this.key).update(body).digest();
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
      if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
      return data;
    } catch {
      return null;
    }
  }
}

/** Хеш IP: позволяет банить по сети, не храня сам адрес. */
export function makeIpHasher(secret: string): (ip: string) => string {
  const key = createHmac('sha256', secret).update('vibechat:ip').digest();
  return (ip) => createHmac('sha256', key).update(ip).digest('base64url').slice(0, 32);
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
