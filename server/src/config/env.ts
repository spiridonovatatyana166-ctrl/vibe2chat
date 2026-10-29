import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const intFrom = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ожидается целое число' });
        return z.NEVER;
      }
      return n;
    });

const emptyToUndef = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: intFrom(8080),
  APP_NAME: z.string().min(1).max(40).default('VibeChat'),
  /** Публичный адрес сайта, например https://vibechat.example.com. Обязателен в production. */
  PUBLIC_ORIGIN: emptyToUndef,
  /** Render подставляет адрес сервиса сам — используем его, если PUBLIC_ORIGIN не задан. */
  RENDER_EXTERNAL_URL: emptyToUndef,
  /** Дополнительные разрешённые Origin через запятую (например, отдельный домен фронтенда). */
  EXTRA_ORIGINS: csv,
  SESSION_SECRET: emptyToUndef,
  DATA_DIR: z.string().default('./data'),
  /** Количество доверенных прокси перед приложением (Caddy/Nginx/балансировщик). */
  TRUST_PROXY: intFrom(0),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  STUN_URLS: csv,
  TURN_URLS: csv,
  /** Общий секрет coturn (use-auth-secret / static-auth-secret) — выдаём временные логины. */
  TURN_SECRET: emptyToUndef,
  /** Либо статические логин/пароль (например, у Metered/Twilio/Xirsys). */
  TURN_USERNAME: emptyToUndef,
  TURN_CREDENTIAL: emptyToUndef,
  TURN_TTL_SECONDS: intFrom(6 * 60 * 60),
  /**
   * Бесплатный публичный TURN (Open Relay от Metered), если свой не настроен.
   * Ничего регистрировать не нужно. Выключить: PUBLIC_TURN=off.
   */
  PUBLIC_TURN: z.enum(['on', 'off']).default('on'),
  /** Cloudflare Realtime TURN (1000 ГБ/мес бесплатно): ключ TURN и его API-токен. */
  CLOUDFLARE_TURN_KEY_ID: emptyToUndef,
  CLOUDFLARE_TURN_API_TOKEN: emptyToUndef,
  /** relay — весь медиатрафик через TURN, собеседники не узнают IP друг друга. */
  ICE_TRANSPORT_POLICY: z.enum(['all', 'relay']).default('all'),

  TURNSTILE_SITE_KEY: emptyToUndef,
  TURNSTILE_SECRET_KEY: emptyToUndef,

  SUPPORT_EMAIL: emptyToUndef,
  METRICS_TOKEN: emptyToUndef,

  RECONNECT_GRACE_MS: intFrom(10_000),
  AUTO_BAN_REPORT_THRESHOLD: intFrom(3),
  AUTO_BAN_HOURS: intFrom(24),
  MAX_CONNECTIONS_PER_IP: intFrom(20),
  /** Сколько новых гостевых сессий можно создать с одного IP подряд (дальше — 1 в 20 секунд). */
  SESSION_BURST_PER_IP: intFrom(30),
  /** Сколько WebSocket-подключений с одного IP можно открыть подряд (дальше — 1 в 2 секунды). */
  WS_CONNECT_BURST_PER_IP: intFrom(30),
  REPORT_RETENTION_DAYS: intFrom(90),
  BLOCK_RETENTION_DAYS: intFrom(180),

  ADMIN_BOOTSTRAP_USERNAME: emptyToUndef,
  ADMIN_BOOTSTRAP_PASSWORD: emptyToUndef,
});

export type Env = z.infer<typeof schema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProd: boolean;
  host: string;
  port: number;
  appName: string;
  publicOrigin: string | null;
  allowedOrigins: Set<string>;
  sessionSecret: string;
  dataDir: string;
  dbPath: string;
  trustProxy: number;
  logLevel: Env['LOG_LEVEL'];
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string | null;
  turnUsername: string | null;
  turnCredential: string | null;
  turnTtlSeconds: number;
  /** Используется встроенный бесплатный TURN (Open Relay). */
  publicTurn: boolean;
  cloudflareTurn: { keyId: string; apiToken: string } | null;
  iceTransportPolicy: 'all' | 'relay';
  turnstileSiteKey: string | null;
  turnstileSecretKey: string | null;
  supportEmail: string | null;
  metricsToken: string | null;
  reconnectGraceMs: number;
  autoBanReportThreshold: number;
  autoBanHours: number;
  maxConnectionsPerIp: number;
  sessionBurstPerIp: number;
  wsConnectBurstPerIp: number;
  reportRetentionDays: number;
  blockRetentionDays: number;
  adminBootstrap: { username: string; password: string } | null;
  secureCookies: boolean;
}

export class ConfigError extends Error {}

/**
 * Публичный бесплатный TURN Open Relay (metered.ca/tools/openrelay): общий секрет
 * опубликован самим сервисом, учётки выдаются по схеме TURN REST API.
 * Порты 80/443 и TCP/TLS проходят через большинство мобильных сетей и файрволов.
 */
export const PUBLIC_TURN = {
  urls: [
    'turn:staticauth.openrelay.metered.ca:80',
    'turn:staticauth.openrelay.metered.ca:80?transport=tcp',
    'turn:staticauth.openrelay.metered.ca:443',
    'turns:staticauth.openrelay.metered.ca:443?transport=tcp',
  ],
  secret: 'openrelayprojectsecret',
} as const;

function normalizeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    throw new ConfigError(`Некорректный origin: ${raw}`);
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Ошибка в переменных окружения:\n${details}`);
  }
  const e = parsed.data;
  if (!e.PUBLIC_ORIGIN && e.RENDER_EXTERNAL_URL) e.PUBLIC_ORIGIN = e.RENDER_EXTERNAL_URL;
  const isProd = e.NODE_ENV === 'production';
  const problems: string[] = [];

  if (isProd && !e.PUBLIC_ORIGIN) problems.push('PUBLIC_ORIGIN обязателен в production');
  if (isProd && (!e.SESSION_SECRET || e.SESSION_SECRET.length < 32))
    problems.push('SESSION_SECRET обязателен в production и должен быть не короче 32 символов');
  if (e.SESSION_SECRET && e.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET короче 32 символов');
  if (e.TURN_URLS.length > 0 && !e.TURN_SECRET && !(e.TURN_USERNAME && e.TURN_CREDENTIAL))
    problems.push('TURN_URLS заданы, но нет TURN_SECRET или пары TURN_USERNAME/TURN_CREDENTIAL');
  if (Boolean(e.CLOUDFLARE_TURN_KEY_ID) !== Boolean(e.CLOUDFLARE_TURN_API_TOKEN))
    problems.push('CLOUDFLARE_TURN_KEY_ID и CLOUDFLARE_TURN_API_TOKEN задаются только вместе');
  const hasOwnTurn = e.TURN_URLS.length > 0 || Boolean(e.CLOUDFLARE_TURN_KEY_ID);
  const publicTurn = !hasOwnTurn && e.PUBLIC_TURN === 'on';
  if (e.ICE_TRANSPORT_POLICY === 'relay' && !hasOwnTurn && !publicTurn)
    problems.push('ICE_TRANSPORT_POLICY=relay требует настроенного TURN (TURN_URLS)');
  if (Boolean(e.TURNSTILE_SITE_KEY) !== Boolean(e.TURNSTILE_SECRET_KEY))
    problems.push('TURNSTILE_SITE_KEY и TURNSTILE_SECRET_KEY задаются только вместе');
  if (Boolean(e.ADMIN_BOOTSTRAP_USERNAME) !== Boolean(e.ADMIN_BOOTSTRAP_PASSWORD))
    problems.push('ADMIN_BOOTSTRAP_USERNAME и ADMIN_BOOTSTRAP_PASSWORD задаются только вместе');
  if (e.ADMIN_BOOTSTRAP_PASSWORD && e.ADMIN_BOOTSTRAP_PASSWORD.length < 12)
    problems.push('ADMIN_BOOTSTRAP_PASSWORD должен быть не короче 12 символов');
  if (isProd && e.PUBLIC_ORIGIN && !e.PUBLIC_ORIGIN.startsWith('https://'))
    problems.push('PUBLIC_ORIGIN в production должен начинаться с https:// (камера работает только по HTTPS)');
  if (problems.length > 0) throw new ConfigError(`Ошибка конфигурации:\n  ${problems.join('\n  ')}`);

  const publicOrigin = e.PUBLIC_ORIGIN ? normalizeOrigin(e.PUBLIC_ORIGIN) : null;
  const allowedOrigins = new Set<string>();
  if (publicOrigin) allowedOrigins.add(publicOrigin);
  for (const o of e.EXTRA_ORIGINS) allowedOrigins.add(normalizeOrigin(o));
  if (!isProd) {
    allowedOrigins.add(`http://localhost:${e.PORT}`);
    allowedOrigins.add(`http://127.0.0.1:${e.PORT}`);
  }

  const dataDir = path.resolve(e.DATA_DIR);
  return {
    env: e.NODE_ENV,
    isProd,
    host: e.HOST,
    port: e.PORT,
    appName: e.APP_NAME,
    publicOrigin,
    allowedOrigins,
    // В разработке без секрета генерируем временный: сессии сбросятся при перезапуске.
    sessionSecret: e.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    dataDir,
    dbPath: e.NODE_ENV === 'test' ? ':memory:' : path.join(dataDir, 'vibechat.sqlite'),
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    stunUrls: e.STUN_URLS.length > 0 ? e.STUN_URLS : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    turnUrls: publicTurn ? [...PUBLIC_TURN.urls] : e.TURN_URLS,
    turnSecret: publicTurn ? PUBLIC_TURN.secret : (e.TURN_SECRET ?? null),
    publicTurn,
    cloudflareTurn:
      e.CLOUDFLARE_TURN_KEY_ID && e.CLOUDFLARE_TURN_API_TOKEN
        ? { keyId: e.CLOUDFLARE_TURN_KEY_ID, apiToken: e.CLOUDFLARE_TURN_API_TOKEN }
        : null,
    turnUsername: e.TURN_USERNAME ?? null,
    turnCredential: e.TURN_CREDENTIAL ?? null,
    turnTtlSeconds: e.TURN_TTL_SECONDS,
    iceTransportPolicy: e.ICE_TRANSPORT_POLICY,
    turnstileSiteKey: e.TURNSTILE_SITE_KEY ?? null,
    turnstileSecretKey: e.TURNSTILE_SECRET_KEY ?? null,
    supportEmail: e.SUPPORT_EMAIL ?? null,
    metricsToken: e.METRICS_TOKEN ?? null,
    reconnectGraceMs: e.RECONNECT_GRACE_MS,
    autoBanReportThreshold: e.AUTO_BAN_REPORT_THRESHOLD,
    autoBanHours: e.AUTO_BAN_HOURS,
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    sessionBurstPerIp: e.SESSION_BURST_PER_IP,
    wsConnectBurstPerIp: e.WS_CONNECT_BURST_PER_IP,
    reportRetentionDays: e.REPORT_RETENTION_DAYS,
    blockRetentionDays: e.BLOCK_RETENTION_DAYS,
    adminBootstrap:
      e.ADMIN_BOOTSTRAP_USERNAME && e.ADMIN_BOOTSTRAP_PASSWORD
        ? { username: e.ADMIN_BOOTSTRAP_USERNAME, password: e.ADMIN_BOOTSTRAP_PASSWORD }
        : null,
    secureCookies: publicOrigin?.startsWith('https://') ?? false,
  };
}
