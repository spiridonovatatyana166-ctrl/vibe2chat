import type { IncomingMessage } from 'node:http';

/**
 * IP клиента с учётом доверенных прокси. trustProxy = число прокси перед
 * приложением; X-Forwarded-For без доверенного прокси игнорируется,
 * чтобы его нельзя было подделать.
 */
export function getClientIp(req: IncomingMessage, trustProxy: number): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy <= 0) return normalize(direct);
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return normalize(direct);
  const chain = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  chain.push(direct);
  const idx = Math.max(0, chain.length - 1 - trustProxy);
  return normalize(chain[idx] ?? direct);
}

function normalize(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
