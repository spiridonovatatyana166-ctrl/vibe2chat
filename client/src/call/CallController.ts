import {
  LIMITS,
  type ClientMessage,
  type IceConfig,
  type LanguageCode,
  type ReportReason,
  type Role,
  type RoomEndReason,
  type ServerMessage,
  type SignalData,
} from '../../../shared/protocol';
import type { DevicePrefs, LocalMediaState } from '../media/MediaManager';
import { MediaAccessError } from '../media/MediaManager';
import type { MediaErrorKind } from '../media/mediaErrors';
import type { PeerCallbacks, PeerState } from '../rtc/PeerSession';
import type { SignalingEvents, SignalingStatus } from '../signaling/SignalingClient';

export type Phase =
  | 'idle' // экран ожидания, камера выключена
  | 'media' // запрашиваем камеру и микрофон
  | 'searching' // ищем собеседника
  | 'connecting' // собеседник найден, устанавливаем WebRTC
  | 'connected' // разговор идёт
  | 'ended' // собеседник ушёл
  | 'media-error' // нет доступа к устройствам
  | 'banned'
  | 'replaced'; // сайт открыт в другой вкладке

export interface ChatMessage {
  id: string;
  mine: boolean;
  text: string;
  ts: number;
  status: 'sent' | 'pending' | 'failed';
}

export interface Notice {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface CallState {
  phase: Phase;
  signaling: SignalingStatus;
  online: number | null;
  roomId: string | null;
  lastRoomId: string | null;
  role: Role | null;
  partnerLanguage: LanguageCode | null;
  partnerPaused: boolean;
  peer: { camOn: boolean; micOn: boolean };
  connectionUnstable: boolean;
  startedAt: number | null;
  endReason: RoomEndReason | null;
  messages: ChatMessage[];
  unread: number;
  chatOpen: boolean;
  local: LocalMediaState;
  remoteStream: MediaStream | null;
  mediaError: MediaErrorKind | null;
  banned: { until: number | null; reason: string } | null;
  notices: Notice[];
  language: LanguageCode;
  autoNext: boolean;
  reportedRooms: string[];
  /** Через сколько мс начнётся автопоиск после ухода собеседника (для индикатора). */
  autoNextAt: number | null;
}

export interface SignalingLike {
  connect(): void;
  disconnect(): void;
  send(msg: ClientMessage): boolean;
  isOpen(): boolean;
  resumeRoomId: string | null;
}

export interface PeerLike {
  readonly role: Role;
  state: PeerState;
  start(): Promise<void>;
  handleSignal(data: SignalData): Promise<void>;
  restartIce(): Promise<void>;
  replaceTrack(track: MediaStreamTrack): Promise<void>;
  close(): void;
}

export interface MediaLike {
  state: LocalMediaState;
  acquire(prefs?: DevicePrefs): Promise<LocalMediaState>;
  setMic(on: boolean): void;
  setCam(on: boolean): void;
  replaceVideo(opts: { facing?: 'user' | 'environment'; deviceId?: string }): Promise<MediaStreamTrack | null>;
  replaceAudio(deviceId: string): Promise<MediaStreamTrack | null>;
  release(): void;
}

export interface CallDeps {
  createSignaling(events: SignalingEvents): SignalingLike;
  createPeer(ice: IceConfig, role: Role, stream: MediaStream | null, cb: PeerCallbacks): PeerLike;
  media: MediaLike;
  getIce(): Promise<IceConfig>;
  loadPref<T>(key: string, fallback: T): T;
  savePref(key: string, value: unknown): void;
  onUnauthorized(): void;
  now?: () => number;
}

export const CONNECT_TIMEOUT_MS = 25_000;
export const AUTO_NEXT_DELAY_MS = 1_500;

/**
 * Вся логика видеочата без React: состояние, сигнализация, WebRTC, чат.
 * UI подписывается через subscribe/getState.
 */
export class CallController {
  private state: CallState;
  private readonly listeners = new Set<() => void>();
  private readonly signaling: SignalingLike;
  private peer: PeerLike | null = null;
  private bufferedSignals: SignalData[] = [];
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private autoNextTimer: ReturnType<typeof setTimeout> | null = null;
  private autoNextHeld = false;
  private searchAfterLeave = false;
  private noticeSeq = 0;
  private msgSeq = 0;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: CallDeps) {
    this.now = deps.now ?? Date.now;
    this.state = {
      phase: 'idle',
      signaling: 'connecting',
      online: null,
      roomId: null,
      lastRoomId: null,
      role: null,
      partnerLanguage: null,
      partnerPaused: false,
      peer: { camOn: true, micOn: true },
      connectionUnstable: false,
      startedAt: null,
      endReason: null,
      messages: [],
      unread: 0,
      chatOpen: false,
      local: deps.media.state,
      remoteStream: null,
      mediaError: null,
      banned: null,
      notices: [],
      language: deps.loadPref<LanguageCode>('language', 'any'),
      autoNext: deps.loadPref('autoNext', true),
      reportedRooms: [],
      autoNextAt: null,
    };
    this.signaling = deps.createSignaling({
      onMessage: (m) => this.onServerMessage(m),
      onStatus: (s) => this.onSignalingStatus(s),
      onUnauthorized: () => deps.onUnauthorized(),
      onTerminated: () => {
        /* причину сообщает сервер отдельным сообщением banned/session:replaced */
      },
    });
    this.signaling.connect();
  }

  // ─── Подписка ────────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): CallState => this.state;

  private set(patch: Partial<CallState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  notify(text: string, kind: Notice['kind'] = 'info'): void {
    const id = ++this.noticeSeq;
    this.set({ notices: [...this.state.notices.slice(-2), { id, kind, text }] });
    setTimeout(() => this.dismissNotice(id), kind === 'error' ? 6000 : 3500);
  }

  dismissNotice(id: number): void {
    this.set({ notices: this.state.notices.filter((n) => n.id !== id) });
  }

  // ─── Действия пользователя ───────────────────────────────────────────────

  /** «Начать»: только здесь, по действию пользователя, запрашиваем камеру и микрофон. */
  async start(): Promise<void> {
    const { phase } = this.state;
    if (phase !== 'idle' && phase !== 'media-error' && phase !== 'ended') return;
    if (phase === 'ended') return this.search();
    this.set({ phase: 'media', mediaError: null });
    try {
      const local = await this.deps.media.acquire(this.deps.loadPref<DevicePrefs>('devices', {}));
      if (this.disposed) return this.deps.media.release();
      if (this.state.phase !== 'media') return; // пользователь успел нажать «Стоп»
      this.set({ local });
      if (local.warning) this.notify(local.warning);
      this.search();
    } catch (err) {
      const kind = err instanceof MediaAccessError ? err.kind : 'unknown';
      this.set({ phase: 'media-error', mediaError: kind });
    }
  }

  /** «Следующий»: завершить текущий разговор и сразу искать нового собеседника. */
  next(): void {
    const { phase, roomId, language } = this.state;
    if (phase === 'connecting' || phase === 'connected') {
      if (roomId) this.signaling.send({ t: 'room:next', roomId, language });
      this.teardownPeer();
      this.set({ phase: 'searching', lastRoomId: roomId, roomId: null, messages: [], unread: 0, startedAt: null });
      this.signaling.resumeRoomId = null;
      return;
    }
    if (phase === 'ended') this.search();
  }

  /** «Завершить»: выйти из разговора и поиска, выключить камеру. */
  stop(): void {
    const { roomId, phase } = this.state;
    if (roomId) this.signaling.send({ t: 'room:leave', roomId });
    else if (phase === 'searching') this.signaling.send({ t: 'queue:leave' });
    this.teardownPeer();
    this.clearAutoNext();
    this.deps.media.release();
    this.signaling.resumeRoomId = null;
    this.set({
      phase: 'idle',
      roomId: null,
      lastRoomId: roomId ?? this.state.lastRoomId,
      startedAt: null,
      endReason: null,
      local: this.deps.media.state,
      messages: [],
      unread: 0,
    });
  }

  toggleMic(): void {
    const local = this.state.local;
    if (!local.hasMic) return this.notify('Микрофон не подключён');
    this.deps.media.setMic(!local.micOn);
    this.set({ local: this.deps.media.state });
    this.sendPeerState();
  }

  toggleCam(): void {
    const local = this.state.local;
    if (!local.hasCamera) return this.notify('Камера не подключена');
    this.deps.media.setCam(!local.camOn);
    this.set({ local: this.deps.media.state });
    this.sendPeerState();
  }

  async switchCamera(): Promise<void> {
    if (!this.state.local.canSwitchCamera) return;
    try {
      const facing = this.state.local.facing === 'user' ? 'environment' : 'user';
      const track = await this.deps.media.replaceVideo({ facing });
      if (track) await this.peer?.replaceTrack(track);
      this.set({ local: { ...this.deps.media.state } });
    } catch {
      this.notify('Не удалось переключить камеру', 'error');
    }
  }

  async setDevices(prefs: DevicePrefs): Promise<void> {
    const current = this.deps.loadPref<DevicePrefs>('devices', {});
    this.deps.savePref('devices', { ...current, ...prefs });
    if (!this.state.local.stream) return;
    try {
      if (prefs.videoId) {
        const t = await this.deps.media.replaceVideo({ deviceId: prefs.videoId });
        if (t) await this.peer?.replaceTrack(t);
      }
      if (prefs.audioId) {
        const t = await this.deps.media.replaceAudio(prefs.audioId);
        if (t) await this.peer?.replaceTrack(t);
      }
      this.set({ local: { ...this.deps.media.state } });
    } catch {
      this.notify('Не удалось переключить устройство', 'error');
    }
  }

  setLanguage(language: LanguageCode): void {
    this.deps.savePref('language', language);
    this.set({ language });
    // Если уже ищем — перезапускаем поиск с новым фильтром.
    if (this.state.phase === 'searching') this.signaling.send({ t: 'queue:join', language });
  }

  setAutoNext(autoNext: boolean): void {
    this.deps.savePref('autoNext', autoNext);
    this.set({ autoNext });
    if (!autoNext) this.clearAutoNext();
  }

  setChatOpen(open: boolean): void {
    this.set({ chatOpen: open, unread: open ? 0 : this.state.unread });
  }

  sendChat(raw: string): boolean {
    const text = raw.trim();
    const roomId = this.state.roomId;
    if (!text || !roomId || this.state.phase !== 'connected') return false;
    if ([...text].length > LIMITS.chatMaxLength) {
      this.notify(`Сообщение длиннее ${LIMITS.chatMaxLength} символов`, 'error');
      return false;
    }
    const clientMsgId = `c${++this.msgSeq}-${this.now()}`;
    const ok = this.signaling.send({ t: 'chat:send', roomId, text, clientMsgId });
    this.set({
      messages: [...this.state.messages, { id: clientMsgId, mine: true, text, ts: this.now(), status: ok ? 'pending' : 'failed' }],
    });
    if (!ok) this.notify('Нет соединения с сервером', 'error');
    return ok;
  }

  /** Жалоба на текущего или только что ушедшего собеседника. */
  report(reason: ReportReason, details?: string): boolean {
    const roomId = this.state.roomId ?? this.state.lastRoomId;
    if (!roomId) return false;
    if (this.state.reportedRooms.includes(roomId)) {
      this.notify('Вы уже пожаловались на этого собеседника');
      return false;
    }
    const sent = this.signaling.send({ t: 'report', roomId, reason, details: details?.trim() || undefined });
    if (!sent) this.notify('Нет соединения с сервером', 'error');
    return sent;
  }

  /** Блокировка: разговор сразу прекращается, этот человек больше не попадётся. */
  block(): void {
    const roomId = this.state.roomId ?? this.state.lastRoomId;
    if (!roomId) return;
    this.signaling.send({ t: 'block', roomId });
    if (this.state.roomId === roomId) {
      this.searchAfterLeave = this.state.autoNext;
      this.teardownPeer();
      this.set({ phase: 'ended', endReason: 'you-left', roomId: null, lastRoomId: roomId, startedAt: null });
    }
  }

  /** Пока открыт диалог жалобы, автопоиск не уводит пользователя дальше. */
  holdAutoNext(hold: boolean): void {
    this.autoNextHeld = hold;
    if (hold) this.clearAutoNext();
    else if (this.state.phase === 'ended' && this.state.autoNext && this.state.endReason !== 'you-left') this.scheduleAutoNext();
  }

  dispose(): void {
    this.stop();
    this.signaling.disconnect();
    this.disposed = true;
    this.listeners.clear();
  }

  // ─── Внутреннее ──────────────────────────────────────────────────────────

  private search(): void {
    this.clearAutoNext();
    this.teardownPeer();
    this.signaling.resumeRoomId = null;
    this.set({
      phase: 'searching',
      roomId: null,
      startedAt: null,
      endReason: null,
      messages: [],
      unread: 0,
      remoteStream: null,
      partnerPaused: false,
    });
    // Если соединения сейчас нет, запрос уйдёт после переподключения (onSignalingStatus).
    this.signaling.send({ t: 'queue:join', language: this.state.language });
  }

  private sendPeerState(): void {
    const roomId = this.state.roomId;
    if (!roomId) return;
    const { camOn, micOn } = this.state.local;
    this.signaling.send({ t: 'peer:state', roomId, camOn, micOn });
  }

  private onSignalingStatus(status: SignalingStatus): void {
    this.set({ signaling: status });
    if (status === 'open' && this.state.phase === 'searching') {
      this.signaling.send({ t: 'queue:join', language: this.state.language });
    }
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'hello':
      case 'stats':
        this.set({ online: msg.online });
        return;

      case 'queue:waiting':
      case 'queue:left':
        return;

      case 'match':
        void this.onMatch(msg.roomId, msg.role, msg.partner.language);
        return;

      case 'signal':
        if (msg.roomId !== this.state.roomId) return;
        if (this.peer) void this.peer.handleSignal(msg.data).catch(() => this.failConnection());
        else this.bufferedSignals.push(msg.data);
        return;

      case 'chat:msg': {
        if (msg.roomId !== this.state.roomId) return;
        if (msg.mine) {
          const exists = this.state.messages.some((m) => m.id === msg.clientMsgId);
          const sent: ChatMessage = { id: msg.id, mine: true, text: msg.text, ts: msg.ts, status: 'sent' };
          this.set({
            messages: exists
              ? this.state.messages.map((m) => (m.id === msg.clientMsgId ? sent : m))
              : [...this.state.messages, sent],
          });
        } else {
          this.set({
            messages: [...this.state.messages, { id: msg.id, mine: false, text: msg.text, ts: msg.ts, status: 'sent' }],
            unread: this.state.chatOpen ? 0 : this.state.unread + 1,
          });
        }
        return;
      }

      case 'peer:state':
        if (msg.roomId === this.state.roomId) this.set({ peer: { camOn: msg.camOn, micOn: msg.micOn } });
        return;

      case 'room:paused':
        if (msg.roomId === this.state.roomId) this.set({ partnerPaused: true });
        return;

      case 'room:resumed':
        if (msg.roomId !== this.state.roomId) return;
        this.set({ partnerPaused: false });
        if (this.peer?.role === 'offerer' && this.peer.state !== 'connected') void this.peer.restartIce();
        return;

      case 'room:ended':
        this.onRoomEnded(msg.roomId, msg.reason);
        return;

      case 'report:ok':
        this.set({ reportedRooms: [...this.state.reportedRooms, msg.roomId] });
        this.notify('Жалоба отправлена модераторам. Спасибо!', 'success');
        return;

      case 'block:ok':
        this.notify('Собеседник заблокирован — он больше вам не попадётся', 'success');
        return;

      case 'banned':
        this.teardownPeer();
        this.clearAutoNext();
        this.deps.media.release();
        this.set({ phase: 'banned', banned: { until: msg.until, reason: msg.reason }, roomId: null, local: this.deps.media.state });
        return;

      case 'session:replaced':
        this.teardownPeer();
        this.clearAutoNext();
        this.deps.media.release();
        this.set({ phase: 'replaced', roomId: null, local: this.deps.media.state });
        return;

      case 'error': {
        const pending = msg.ref ? this.state.messages.find((m) => m.id === msg.ref && m.status === 'pending') : undefined;
        if (pending) {
          this.set({ messages: this.state.messages.map((m) => (m === pending ? { ...m, status: 'failed' } : m)) });
        }
        if (msg.code === 'not-in-room' && !pending) return; // запоздалые события после ухода собеседника
        this.notify(msg.message, 'error');
        return;
      }
    }
  }

  private async onMatch(roomId: string, role: Role, partnerLanguage: LanguageCode): Promise<void> {
    if (this.state.phase !== 'searching') {
      // Пользователь уже нажал «Завершить» — освобождаем комнату.
      this.signaling.send({ t: 'room:leave', roomId });
      return;
    }
    this.teardownPeer();
    this.bufferedSignals = [];
    this.signaling.resumeRoomId = roomId;
    this.set({
      phase: 'connecting',
      roomId,
      role,
      partnerLanguage,
      partnerPaused: false,
      peer: { camOn: true, micOn: true },
      connectionUnstable: false,
      startedAt: null,
      endReason: null,
      messages: [],
      unread: 0,
      remoteStream: null,
    });
    this.connectTimer = setTimeout(() => this.failConnection(), CONNECT_TIMEOUT_MS);
    this.sendPeerState();

    let ice: IceConfig;
    try {
      ice = await this.deps.getIce();
    } catch {
      this.notify('Не удалось получить настройки соединения', 'error');
      return this.failConnection();
    }
    if (this.state.roomId !== roomId) return;

    // Колбэки могут сработать прямо из конструктора, поэтому переменную объявляем заранее.
    let peer: PeerLike | null = null;
    peer = this.deps.createPeer(ice, role, this.deps.media.state.stream, {
      sendSignal: (data) => {
        if (this.state.roomId === roomId) this.signaling.send({ t: 'signal', roomId, data });
      },
      onRemoteStream: (stream) => {
        if (this.peer === peer) this.set({ remoteStream: stream });
      },
      onState: (s) => {
        if (this.peer === peer) this.onPeerState(s);
      },
    });
    this.peer = peer;
    try {
      for (const data of this.bufferedSignals.splice(0)) await peer.handleSignal(data);
      await peer.start();
    } catch {
      this.failConnection();
    }
  }

  private onPeerState(s: PeerState): void {
    if (s === 'connected') {
      this.clearConnectTimer();
      this.set({
        phase: 'connected',
        connectionUnstable: false,
        startedAt: this.state.startedAt ?? this.now(),
      });
    } else if (s === 'unstable') {
      this.set({ connectionUnstable: true });
    } else if (s === 'failed') {
      this.failConnection();
    }
  }

  /** WebRTC не соединился (сеть, NAT без TURN) — сообщаем серверу и ищем другого. */
  private failConnection(): void {
    const roomId = this.state.roomId;
    if (!roomId) return;
    this.signaling.send({ t: 'room:failed', roomId });
    this.teardownPeer();
    this.notify('Не удалось соединиться с собеседником. Ищем другого…', 'error');
    this.set({ lastRoomId: roomId });
    this.search();
  }

  private onRoomEnded(roomId: string, reason: RoomEndReason): void {
    if (roomId !== this.state.roomId) {
      // Комната, которую мы пытались восстановить, уже закрыта.
      if (roomId === this.signaling.resumeRoomId) this.signaling.resumeRoomId = null;
      if (!(reason === 'you-left' && this.searchAfterLeave)) return;
    }
    this.teardownPeer();
    this.signaling.resumeRoomId = null;

    if (reason === 'you-left') {
      if (this.searchAfterLeave) {
        this.searchAfterLeave = false;
        this.search();
      }
      return;
    }
    if (reason === 'connection-failed') {
      this.set({ lastRoomId: roomId });
      this.notify('Соединение не удалось. Ищем другого собеседника…');
      this.search();
      return;
    }
    this.set({
      phase: 'ended',
      endReason: reason,
      roomId: null,
      lastRoomId: roomId,
      startedAt: null,
      remoteStream: null,
      partnerPaused: false,
    });
    if (this.state.autoNext && !this.autoNextHeld) this.scheduleAutoNext();
  }

  private scheduleAutoNext(): void {
    this.clearAutoNext();
    this.set({ autoNextAt: this.now() + AUTO_NEXT_DELAY_MS });
    this.autoNextTimer = setTimeout(() => {
      this.autoNextTimer = null;
      if (this.state.phase === 'ended') this.search();
    }, AUTO_NEXT_DELAY_MS);
  }

  private clearAutoNext(): void {
    if (this.autoNextTimer) clearTimeout(this.autoNextTimer);
    this.autoNextTimer = null;
    if (this.state.autoNextAt !== null) this.set({ autoNextAt: null });
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private teardownPeer(): void {
    this.clearConnectTimer();
    this.bufferedSignals = [];
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    if (this.state.remoteStream) this.set({ remoteStream: null });
  }
}
