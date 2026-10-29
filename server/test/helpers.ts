import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.js';
import { loadConfig } from '../src/config/env.js';
import { startServer } from '../src/server.js';

export type TestServer = Awaited<ReturnType<typeof startServer>> & { origin: string };

export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    HOST: '127.0.0.1',
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    RECONNECT_GRACE_MS: '300',
    LOG_LEVEL: 'error',
    SESSION_BURST_PER_IP: '10000',
    MAX_CONNECTIONS_PER_IP: '10000',
    WS_CONNECT_BURST_PER_IP: '10000',
    ...env,
  });
  const srv = await startServer(config, { silent: true, clientDist: '/nonexistent' });
  return Object.assign(srv, { origin: `http://127.0.0.1:${srv.port}` });
}

/** Создаёт гостевую сессию (как после подтверждения 18+) и возвращает cookie. */
export async function createGuest(srv: TestServer): Promise<string> {
  const res = await fetch(`${srv.origin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.origin },
    body: JSON.stringify({ ageConfirmed: true, rulesAccepted: true }),
  });
  if (res.status !== 200) throw new Error(`session failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error('no cookie');
  return cookie.split(';')[0]!;
}

export class TestClient {
  readonly messages: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  closeCode: number | null = null;
  private closed: Promise<number>;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code) => {
        this.closeCode = code;
        resolve(code);
      }),
    );
  }

  static connect(
    srv: TestServer,
    cookie: string | null,
    opts: { origin?: string; resume?: string } = {},
  ): Promise<TestClient> {
    const url = `ws://127.0.0.1:${srv.port}/ws${opts.resume ? `?resume=${opts.resume}` : ''}`;
    const headers: Record<string, string> = { Origin: opts.origin ?? srv.origin };
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(url, { headers });
    const client = new TestClient(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Ждёт сообщение (учитывая уже полученные, начиная с позиции from). */
  waitFor<T extends ServerMessage['t']>(
    t: T,
    pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const test = (m: ServerMessage) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>);
    const existing = this.messages.find(test);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ServerMessage, { t: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeoutMs);
      this.waiters.push({
        pred: test,
        resolve: (m) => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }

  /** Проверяет, что сообщение типа t НЕ пришло за указанное время. */
  async expectNo(t: ServerMessage['t'], ms = 250): Promise<void> {
    await sleep(ms);
    const found = this.messages.find((m) => m.t === t);
    if (found) throw new Error(`unexpected ${t}: ${JSON.stringify(found)}`);
  }

  waitClose(): Promise<number> {
    return this.closed;
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Два гостя, которые нашли друг друга. */
export async function pair(srv: TestServer, language: 'any' | 'ru' = 'any') {
  const cookieA = await createGuest(srv);
  const cookieB = await createGuest(srv);
  const a = await TestClient.connect(srv, cookieA);
  const b = await TestClient.connect(srv, cookieB);
  a.send({ t: 'queue:join', language });
  await a.waitFor('queue:waiting');
  b.send({ t: 'queue:join', language });
  const ma = await a.waitFor('match');
  const mb = await b.waitFor('match');
  return { a, b, cookieA, cookieB, roomId: ma.roomId, ma, mb };
}
