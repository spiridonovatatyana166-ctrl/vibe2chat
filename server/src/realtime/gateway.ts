import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOSE_CODES, LIMITS, type ServerMessage } from '../../../shared/protocol.js';
import { randomId } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { parseCookies } from '../http/cookies.js';
import { getClientIp } from '../http/clientIp.js';
import { GUEST_COOKIE } from '../http/session.js';
import { KeyedRateLimiter } from '../lib/rateLimit.js';
import type { Connection } from './hub.js';
import { parseClientMessage } from './schemas.js';

const HEARTBEAT_MS = 25_000;
const MAX_INVALID_MESSAGES = 10;

/**
 * WebSocket-шлюз сигнализации: проверяет Origin, гостевую сессию, баны,
 * лимиты подключений; валидирует каждое входящее событие и передаёт в Hub.
 */
export function attachGateway(server: Server, ctx: AppContext): { close(): Promise<void> } {
  const { config, hub, log } = ctx;
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsMaxPayloadBytes, perMessageDeflate: false });
  const connectRate = new KeyedRateLimiter(config.wsConnectBurstPerIp, 0.5);
  const perIp = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  const reject = (socket: Duplex, status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');

    // Защита от Cross-Site WebSocket Hijacking: cookie отправляется с любого сайта,
    // поэтому принимаем соединения только со своих доменов.
    const origin = req.headers.origin;
    if (!origin || !isAllowedOrigin(origin, req, ctx)) return reject(socket, 403, 'Forbidden');

    const ip = getClientIp(req, config.trustProxy);
    const ipHash = ctx.hashIp(ip);
    if (!connectRate.take(ipHash)) return reject(socket, 429, 'Too Many Requests');
    if ((perIp.get(ipHash) ?? 0) >= config.maxConnectionsPerIp) return reject(socket, 429, 'Too Many Requests');

    const session = ctx.guestTokens.verify<{ gid: string }>(parseCookies(req)[GUEST_COOKIE]);
    if (!session) return reject(socket, 401, 'Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ipHash, (perIp.get(ipHash) ?? 0) + 1);
      const conn = wrap(ws);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));

      ws.on('close', () => {
        const n = (perIp.get(ipHash) ?? 1) - 1;
        if (n <= 0) perIp.delete(ipHash);
        else perIp.set(ipHash, n);
        hub.detach(conn);
      });
      ws.on('error', (err) => log.debug('ws error', { err: err.message }));

      const ban = ctx.moderation.activeBan(session.gid, ipHash);
      if (ban) {
        conn.send({ t: 'banned', until: ban.until, reason: ban.reason });
        conn.close(CLOSE_CODES.banned, 'banned');
        return;
      }

      const resume = url.searchParams.get('resume');
      hub.attach(conn, session.gid, ipHash, resume && /^[A-Za-z0-9_-]{8,64}$/.test(resume) ? resume : null);

      let invalid = 0;
      ws.on('message', (data, isBinary) => {
        if (isBinary) return conn.close(1003, 'binary not supported');
        const msg = parseClientMessage(data.toString());
        if (!msg) {
          invalid++;
          conn.send({ t: 'error', code: 'bad-request', message: 'Некорректное сообщение' });
          if (invalid > MAX_INVALID_MESSAGES) conn.close(1008, 'too many invalid messages');
          return;
        }
        try {
          hub.handle(conn, msg);
        } catch (err) {
          log.error('handler failed', { err, type: msg.t });
          conn.send({ t: 'error', code: 'internal', message: 'Внутренняя ошибка сервера' });
        }
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        connectRate.stop();
        for (const ws of wss.clients) ws.close(1001, 'server shutdown');
        wss.close(() => resolve());
      }),
  };
}

function wrap(ws: WebSocket): Connection {
  return {
    id: randomId(12),
    send(msg: ServerMessage) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close(code: number, reason: string) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    },
  };
}

function isAllowedOrigin(origin: string, req: IncomingMessage, ctx: AppContext): boolean {
  if (ctx.config.allowedOrigins.has(origin)) return true;
  if (ctx.config.isProd) return false;
  // В разработке разрешаем тот же хост, с которого открыта страница (например, IP в локальной сети).
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
