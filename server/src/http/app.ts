import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { KeyedRateLimiter } from '../lib/rateLimit.js';
import { registerAdminRoutes } from './admin.js';
import { getClientIp } from './clientIp.js';
import { HttpError, readJsonBody, Router, sendJson, type RequestContext } from './router.js';
import { registerSessionRoutes } from './session.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Маршруты клиентского приложения — для них отдаём index.html. */
const SPA_ROUTES = new Set(['/', '/rules', '/privacy', '/support', '/admin', '/check']);

function securityHeaders(ctx: AppContext, res: ServerResponse): void {
  const turnstile = ctx.config.turnstileSiteKey ? ' https://challenges.cloudflare.com' : '';
  const wsOrigins = [...ctx.config.allowedOrigins].map((o) => o.replace(/^http/, 'ws')).join(' ');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self'${turnstile}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      `connect-src 'self' ${wsOrigins}${turnstile}`.trim(),
      `frame-src${turnstile || " 'none'"}`,
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), fullscreen=(self), geolocation=(), payment=()');
  if (ctx.config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function createApp(ctx: AppContext, clientDist = path.resolve('client/dist')): Server {
  const router = new Router();
  registerSessionRoutes(router, ctx);
  registerAdminRoutes(router, ctx);
  const apiLimiter = new KeyedRateLimiter(120, 4);

  router.get('/healthz', () => ({ ok: true }));
  router.get('/readyz', () => {
    if (!ctx.storage.ping()) throw new HttpError(503, 'database unavailable');
    return { ok: true };
  });

  let indexCache: string | null = null;
  const indexHtml = (): string | null => {
    if (indexCache && ctx.config.isProd) return indexCache;
    const file = path.join(clientDist, 'index.html');
    if (!existsSync(file)) return null;
    const escaped = ctx.config.appName.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    indexCache = readFileSync(file, 'utf8').replaceAll('%APP_NAME%', escaped);
    return indexCache;
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (SPA_ROUTES.has(pathname)) {
      const html = indexHtml();
      if (!html) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Клиент не собран. Выполните npm run build:client');
        return true;
      }
      res.setHeader('Content-Type', MIME['.html']!);
      res.setHeader('Cache-Control', 'no-cache');
      res.end(req.method === 'HEAD' ? undefined : html);
      return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const file = path.normalize(path.join(clientDist, decoded));
    if (!file.startsWith(clientDist + path.sep) || path.basename(file) === 'index.html') return false;
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader(
      'Cache-Control',
      decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    );
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  };

  const metrics = (res: ServerResponse) => {
    const s = ctx.hub.snapshot();
    const mem = process.memoryUsage();
    const body = [
      '# TYPE vibechat_online gauge',
      `vibechat_online ${s.online}`,
      '# TYPE vibechat_searching gauge',
      `vibechat_searching ${s.searching}`,
      '# TYPE vibechat_active_rooms gauge',
      `vibechat_active_rooms ${s.activeRooms}`,
      '# TYPE vibechat_rooms_created_total counter',
      `vibechat_rooms_created_total ${s.roomsCreated}`,
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${mem.rss}`,
      '',
    ].join('\n');
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(body);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = getClientIp(req, ctx.config.trustProxy);
    const ipHash = ctx.hashIp(ip);
    securityHeaders(ctx, res);

    try {
      if (url.pathname === '/metrics') {
        const token = ctx.config.metricsToken;
        if (!token || req.headers.authorization !== `Bearer ${token}`) throw new HttpError(404, 'Not found');
        return metrics(res);
      }

      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/readyz') {
        if (url.pathname.startsWith('/api/') && !apiLimiter.take(ipHash)) throw new HttpError(429, 'Слишком много запросов');
        const method = req.method ?? 'GET';
        // Защита от CSRF: изменяющие запросы принимаем только со своего Origin.
        if (method !== 'GET' && method !== 'HEAD') {
          const origin = req.headers.origin;
          const sameHost = !ctx.config.isProd && origin && safeHost(origin) === req.headers.host;
          if (!origin || !(ctx.config.allowedOrigins.has(origin) || sameHost))
            throw new HttpError(403, 'Запрос с чужого сайта отклонён');
        }
        const matched = router.match(method, url.pathname);
        if (matched === null) throw new HttpError(404, 'Не найдено');
        if (matched === 'method') throw new HttpError(405, 'Метод не поддерживается');
        const rc: RequestContext = {
          req,
          res,
          url,
          params: matched.params,
          ip,
          ipHash,
          body: () => readJsonBody(req),
        };
        const result = await matched.handler(rc);
        if (!res.writableEnded) sendJson(res, 200, result ?? { ok: true });
        return;
      }

      if (serveStatic(req, res, url.pathname)) return;
      throw new HttpError(404, 'Не найдено');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, code: err.code });
      ctx.log.error('http handler failed', { err, path: url.pathname });
      sendJson(res, 500, { error: 'Внутренняя ошибка сервера', code: 'internal' });
    }
  });
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
