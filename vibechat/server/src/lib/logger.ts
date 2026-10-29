/**
 * Минималистичный JSON-логгер. Чувствительные поля (IP, токены, SDP,
 * ICE-кандидаты, тексты сообщений, пароли) вырезаются всегда.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT = new Set([
  'ip',
  'ipaddress',
  'remoteaddress',
  'token',
  'cookie',
  'authorization',
  'password',
  'secret',
  'sdp',
  'candidate',
  'text',
  'details',
]);

export type LogFields = Record<string, unknown>;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 6).join('\n') };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export function createLogger(level: Level = 'info', bindings: LogFields = {}, silent = false): Logger {
  const min = ORDER[level];
  const write = (lvl: Level, msg: string, fields?: LogFields) => {
    if (silent || ORDER[lvl] < min) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: lvl,
      msg,
      ...(sanitize(bindings) as LogFields),
      ...(fields ? (sanitize(fields) as LogFields) : {}),
    });
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (b) => createLogger(level, { ...bindings, ...b }, silent),
  };
}
