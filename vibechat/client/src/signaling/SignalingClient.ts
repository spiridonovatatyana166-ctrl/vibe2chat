import { CLOSE_CODES, type ClientMessage, type ServerMessage } from '../../../shared/protocol';

export type SignalingStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SignalingEvents {
  onMessage(msg: ServerMessage): void;
  onStatus(status: SignalingStatus): void;
  /** Сервер не принимает подключение (нет или истекла сессия). */
  onUnauthorized(): void;
  /** Подключение закрыто окончательно (бан, другая вкладка). */
  onTerminated(code: number): void;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

/**
 * WebSocket-клиент сигнализации с автоматическим переподключением
 * (экспоненциальная задержка) и восстановлением комнаты после обрыва.
 */
export class SignalingClient {
  private ws: WebSocketLike | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failuresWithoutOpen = 0;
  /** Комната, которую нужно восстановить при переподключении. */
  resumeRoomId: string | null = null;
  status: SignalingStatus = 'closed';

  constructor(
    private readonly url: string,
    private readonly events: SignalingEvents,
    private readonly createSocket: (url: string) => WebSocketLike = (u) => new WebSocket(u),
    private readonly checkSession: () => Promise<boolean> = async () => true,
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private setStatus(s: SignalingStatus) {
    this.status = s;
    this.events.onStatus(s);
  }

  private open(): void {
    if (this.stopped) return;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const url = this.resumeRoomId ? `${this.url}?resume=${encodeURIComponent(this.resumeRoomId)}` : this.url;
    let ws: WebSocketLike;
    try {
      ws = this.createSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.failuresWithoutOpen = 0;
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.events.onMessage(msg);
    };
    ws.onerror = () => {
      /* подробности придут в onclose */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === CLOSE_CODES.banned || ev.code === CLOSE_CODES.sessionReplaced) {
        this.stopped = true;
        this.setStatus('closed');
        this.events.onTerminated(ev.code);
        return;
      }
      if (this.stopped) {
        this.setStatus('closed');
        return;
      }
      this.failuresWithoutOpen++;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    const delay = Math.min(10_000, 500 * 2 ** this.attempts) + Math.random() * 300;
    this.attempts++;
    this.retryTimer = setTimeout(async () => {
      // Браузер не показывает HTTP-статус отказа WebSocket. Если подряд несколько
      // неудач — проверяем, жива ли гостевая сессия.
      if (this.failuresWithoutOpen >= 2) {
        const ok = await this.checkSession().catch(() => true);
        if (!ok) {
          this.stopped = true;
          this.setStatus('closed');
          this.events.onUnauthorized();
          return;
        }
      }
      this.open();
    }, delay);
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  isOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.setStatus('closed');
  }
}
