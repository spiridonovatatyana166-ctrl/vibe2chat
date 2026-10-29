import {
  CLOSE_CODES,
  LIMITS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type LanguageCode,
  type Role,
  type RoomEndReason,
  type ServerMessage,
} from '../../../shared/protocol.js';
import { randomId } from '../auth/tokens.js';
import type { Logger } from '../lib/logger.js';
import { TokenBucket } from '../lib/rateLimit.js';
import { Matchmaker } from '../matchmaking/matchmaker.js';
import type { Moderation } from '../moderation/moderation.js';
import type { ActiveBan, Storage } from '../storage/types.js';
import { sanitizeText } from './schemas.js';

/** Абстракция над сокетом: хаб не зависит от конкретной WebSocket-библиотеки. */
export interface Connection {
  readonly id: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface Guest {
  gid: string;
  ipHash: string;
  conn: Connection | null;
  roomId: string | null;
  language: LanguageCode;
  lastPartner?: string;
  graceTimer?: NodeJS.Timeout;
  buckets: { match: TokenBucket; chat: TokenBucket; signal: TokenBucket; misc: TokenBucket };
  violations: TokenBucket;
  lastChat: { text: string; repeats: number };
}

interface Room {
  id: string;
  offerer: string;
  answerer: string;
  createdAt: number;
}

interface EndedRoom {
  members: [string, string];
  ipHashes: Record<string, string>;
  endedAt: number;
}

export interface HubOptions {
  reconnectGraceMs: number;
  sweepIntervalMs?: number;
  statsIntervalMs?: number;
}

const RECENT_ROOM_TTL_MS = 3 * 60_000;

export class Hub {
  private readonly guests = new Map<string, Guest>();
  private readonly connToGuest = new Map<string, string>();
  private readonly rooms = new Map<string, Room>();
  private readonly recentRooms = new Map<string, EndedRoom>();
  private readonly matchmaker: Matchmaker;
  private readonly timers: NodeJS.Timeout[] = [];
  private lastBroadcastOnline = -1;
  private roomsCreated = 0;

  constructor(
    private readonly storage: Storage,
    private readonly moderation: Moderation,
    private readonly log: Logger,
    private readonly opts: HubOptions,
  ) {
    this.matchmaker = new Matchmaker({
      isBlocked: (a, b) => this.moderation.isBlocked(a, b),
      lastPartner: (gid) => this.guests.get(gid)?.lastPartner,
    });
    const sweep = setInterval(() => this.sweep(), opts.sweepIntervalMs ?? 2000);
    const stats = setInterval(() => this.broadcastStats(), opts.statsIntervalMs ?? 10_000);
    sweep.unref();
    stats.unref();
    this.timers.push(sweep, stats);
  }

  // ─── Подключение и отключение ────────────────────────────────────────────

  /**
   * Привязывает соединение к гостю. Если у гостя уже есть соединение —
   * старое закрывается: один гость = одна активная вкладка = максимум одна комната.
   * resumeRoomId — комната, которую клиент хочет восстановить после обрыва сети.
   */
  attach(conn: Connection, gid: string, ipHash: string, resumeRoomId: string | null): void {
    this.moderation.loadBlocks(gid);
    let guest = this.guests.get(gid);
    if (!guest) {
      guest = this.newGuest(gid, ipHash);
      this.guests.set(gid, guest);
    }
    guest.ipHash = ipHash;

    const previous = guest.conn;
    if (previous && previous.id !== conn.id) {
      this.connToGuest.delete(previous.id);
      previous.send({ t: 'session:replaced' });
      previous.close(CLOSE_CODES.sessionReplaced, 'session replaced');
      this.log.info('session replaced', { gid: short(gid) });
    }
    guest.conn = conn;
    this.connToGuest.set(conn.id, gid);

    conn.send({ t: 'hello', protocol: PROTOCOL_VERSION, online: this.onlineCount() });

    // Клиент просит восстановить комнату, которой уже нет — сообщаем явно, чтобы он не ждал.
    if (resumeRoomId && guest.roomId !== resumeRoomId) {
      conn.send({ t: 'room:ended', roomId: resumeRoomId, reason: 'partner-disconnected' });
    }

    if (guest.roomId) {
      const room = this.rooms.get(guest.roomId);
      const canResume = room && resumeRoomId === room.id;
      if (guest.graceTimer) {
        clearTimeout(guest.graceTimer);
        guest.graceTimer = undefined;
      }
      if (room && canResume) {
        const role: Role = room.offerer === gid ? 'offerer' : 'answerer';
        conn.send({ t: 'room:resumed', roomId: room.id, role });
        const partner = this.guests.get(this.partnerOf(room, gid));
        const partnerRole: Role = role === 'offerer' ? 'answerer' : 'offerer';
        partner?.conn?.send({ t: 'room:resumed', roomId: room.id, role: partnerRole });
        this.log.debug('room resumed', { room: room.id });
      } else if (room) {
        // Новая вкладка или клиент не знает о комнате — честно завершаем её.
        this.endRoom(room, gid, 'partner-disconnected', null);
      } else {
        guest.roomId = null;
      }
    }
  }

  detach(conn: Connection): void {
    const gid = this.connToGuest.get(conn.id);
    this.connToGuest.delete(conn.id);
    if (!gid) return;
    const guest = this.guests.get(gid);
    if (!guest || guest.conn?.id !== conn.id) return;
    guest.conn = null;
    this.matchmaker.remove(gid);

    const room = guest.roomId ? this.rooms.get(guest.roomId) : undefined;
    if (room) {
      const partner = this.guests.get(this.partnerOf(room, gid));
      partner?.conn?.send({ t: 'room:paused', roomId: room.id });
      guest.graceTimer = setTimeout(() => {
        guest.graceTimer = undefined;
        const current = this.rooms.get(room.id);
        if (current) this.endRoom(current, gid, 'partner-disconnected', null);
        this.dropIfIdle(gid);
      }, this.opts.reconnectGraceMs);
      guest.graceTimer.unref();
    } else {
      this.dropIfIdle(gid);
    }
  }

  // ─── Обработка событий ───────────────────────────────────────────────────

  handle(conn: Connection, msg: ClientMessage): void {
    const gid = this.connToGuest.get(conn.id);
    const guest = gid ? this.guests.get(gid) : undefined;
    if (!guest || guest.conn?.id !== conn.id) return;

    switch (msg.t) {
      case 'queue:join':
        if (!this.allow(guest, 'match')) return;
        if (guest.roomId) return this.error(guest, 'already-in-room', 'Сначала завершите текущий разговор');
        guest.language = msg.language;
        this.enqueue(guest);
        return;

      case 'queue:leave':
        this.matchmaker.remove(guest.gid);
        conn.send({ t: 'queue:left' });
        return;

      case 'room:next': {
        if (!this.allow(guest, 'match')) return;
        guest.language = msg.language;
        const room = this.ownRoom(guest, msg.roomId);
        if (room) this.endRoom(room, guest.gid, 'partner-next', null);
        else if (guest.roomId) return this.error(guest, 'not-in-room', 'Это не ваша комната', msg.roomId);
        // Комнату мог уже закрыть собеседник — это нормально, просто ищем дальше.
        this.enqueue(guest);
        return;
      }

      case 'room:leave': {
        if (!this.allow(guest, 'misc')) return;
        const room = this.ownRoom(guest, msg.roomId);
        if (room) this.endRoom(room, guest.gid, 'partner-left', 'you-left');
        this.matchmaker.remove(guest.gid);
        return;
      }

      case 'room:failed': {
        if (!this.allow(guest, 'misc')) return;
        const room = this.ownRoom(guest, msg.roomId);
        if (room) this.endRoom(room, guest.gid, 'connection-failed', 'connection-failed');
        return;
      }

      case 'signal': {
        if (!this.allow(guest, 'signal')) return;
        const room = this.ownRoom(guest, msg.roomId);
        if (!room) return this.error(guest, 'not-in-room', 'Нет активной комнаты', msg.roomId);
        // Роль определяет сервер: offer шлёт только offerer, answer — только answerer.
        const isOfferer = room.offerer === guest.gid;
        if ((msg.data.kind === 'offer' && !isOfferer) || (msg.data.kind === 'answer' && isOfferer)) {
          return this.error(guest, 'bad-request', 'Недопустимое сообщение сигнализации', msg.roomId);
        }
        this.toPartner(room, guest.gid, { t: 'signal', roomId: room.id, data: msg.data });
        return;
      }

      case 'chat:send': {
        const room = this.ownRoom(guest, msg.roomId);
        if (!room) return this.error(guest, 'not-in-room', 'Собеседник уже вышел', msg.roomId);
        if (!this.allow(guest, 'chat')) return;
        const text = sanitizeText(msg.text, LIMITS.chatMaxLength);
        if (!text) return this.error(guest, 'message-rejected', 'Пустое или слишком длинное сообщение', msg.clientMsgId);
        if (text === guest.lastChat.text) {
          guest.lastChat.repeats++;
          if (guest.lastChat.repeats >= 2)
            return this.error(guest, 'message-rejected', 'Не повторяйте одно и то же сообщение', msg.clientMsgId);
        } else {
          guest.lastChat = { text, repeats: 0 };
        }
        const id = randomId(9);
        const ts = Date.now();
        conn.send({ t: 'chat:msg', roomId: room.id, id, mine: true, text, ts, clientMsgId: msg.clientMsgId });
        this.toPartner(room, guest.gid, { t: 'chat:msg', roomId: room.id, id, mine: false, text, ts });
        return;
      }

      case 'peer:state': {
        if (!this.allow(guest, 'misc')) return;
        const room = this.ownRoom(guest, msg.roomId);
        if (!room) return;
        this.toPartner(room, guest.gid, { t: 'peer:state', roomId: room.id, camOn: msg.camOn, micOn: msg.micOn });
        return;
      }

      case 'report': {
        if (!this.allow(guest, 'misc')) return;
        const target = this.reportTarget(guest, msg.roomId);
        if (!target) return this.error(guest, 'not-in-room', 'Не удалось определить собеседника', msg.roomId);
        const details = msg.details ? sanitizeText(msg.details, LIMITS.reportDetailsMaxLength) : null;
        const outcome = this.moderation.report({
          reporterGid: guest.gid,
          reportedGid: target.gid,
          reportedIpHash: target.ipHash || null,
          roomId: msg.roomId,
          reason: msg.reason,
          details,
        });
        conn.send({ t: 'report:ok', roomId: msg.roomId });
        if (outcome.autoBanned) this.kick(target.gid, outcome.autoBanned);
        return;
      }

      case 'block': {
        if (!this.allow(guest, 'misc')) return;
        const target = this.reportTarget(guest, msg.roomId);
        if (!target) return this.error(guest, 'not-in-room', 'Не удалось определить собеседника', msg.roomId);
        this.moderation.block(guest.gid, target.gid);
        const room = this.ownRoom(guest, msg.roomId);
        // Собеседнику не сообщаем о блокировке — для него это обычное завершение.
        if (room) this.endRoom(room, guest.gid, 'partner-left', 'you-left');
        conn.send({ t: 'block:ok', roomId: msg.roomId });
        return;
      }
    }
  }

  // ─── Модерация извне (админка) ───────────────────────────────────────────

  /** Отключает гостя с баном. Возвращает true, если он был онлайн. */
  kick(gid: string, ban: ActiveBan): boolean {
    const guest = this.guests.get(gid);
    if (!guest) return false;
    this.matchmaker.remove(gid);
    const room = guest.roomId ? this.rooms.get(guest.roomId) : undefined;
    if (room) this.endRoom(room, gid, 'partner-disconnected', null);
    if (guest.graceTimer) clearTimeout(guest.graceTimer);
    const conn = guest.conn;
    guest.conn = null;
    if (conn) {
      this.connToGuest.delete(conn.id);
      conn.send({ t: 'banned', until: ban.until, reason: ban.reason });
      conn.close(CLOSE_CODES.banned, 'banned');
    }
    this.guests.delete(gid);
    this.moderation.forget(gid);
    return Boolean(conn);
  }

  /** Отключает всех онлайн-гостей с указанным хешем сети. */
  kickNetwork(ipHash: string, ban: ActiveBan): number {
    let n = 0;
    for (const g of [...this.guests.values()]) if (g.ipHash === ipHash && this.kick(g.gid, ban)) n++;
    return n;
  }

  // ─── Статистика ──────────────────────────────────────────────────────────

  onlineCount(): number {
    let n = 0;
    for (const g of this.guests.values()) if (g.conn) n++;
    return n;
  }

  snapshot() {
    return {
      online: this.onlineCount(),
      searching: this.matchmaker.size,
      activeRooms: this.rooms.size,
      roomsCreated: this.roomsCreated,
    };
  }

  /** Для тестов и отладки: в какой комнате гость. */
  roomOf(gid: string): string | null {
    return this.guests.get(gid)?.roomId ?? null;
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const g of this.guests.values()) if (g.graceTimer) clearTimeout(g.graceTimer);
  }

  // ─── Внутреннее ──────────────────────────────────────────────────────────

  private newGuest(gid: string, ipHash: string): Guest {
    return {
      gid,
      ipHash,
      conn: null,
      roomId: null,
      language: 'any',
      // «Следующий» — до 6 нажатий подряд, дальше 1 раз в 1,5 с.
      buckets: {
        match: new TokenBucket(6, 0.7),
        chat: new TokenBucket(6, 1),
        signal: new TokenBucket(300, 60),
        misc: new TokenBucket(20, 2),
      },
      violations: new TokenBucket(30, 0.5),
      lastChat: { text: '', repeats: 0 },
    };
  }

  private allow(guest: Guest, kind: keyof Guest['buckets']): boolean {
    if (guest.buckets[kind].take()) return true;
    this.error(guest, 'rate-limited', 'Слишком часто. Подождите немного');
    if (!guest.violations.take()) {
      this.log.warn('client disconnected for flooding', { gid: short(guest.gid), kind });
      guest.conn?.close(CLOSE_CODES.rateLimited, 'rate limited');
    }
    return false;
  }

  private error(guest: Guest, code: ErrorCode, message: string, ref?: string): void {
    guest.conn?.send({ t: 'error', code, message, ref });
  }

  private ownRoom(guest: Guest, roomId: string): Room | undefined {
    if (guest.roomId !== roomId) return undefined;
    const room = this.rooms.get(roomId);
    if (!room || (room.offerer !== guest.gid && room.answerer !== guest.gid)) return undefined;
    return room;
  }

  /** Собеседник по текущей или недавно завершённой комнате (для жалобы после «Следующий»). */
  private reportTarget(guest: Guest, roomId: string): { gid: string; ipHash: string } | null {
    const room = this.ownRoom(guest, roomId);
    if (room) {
      const gid = this.partnerOf(room, guest.gid);
      return { gid, ipHash: this.guests.get(gid)?.ipHash ?? '' };
    }
    const ended = this.recentRooms.get(roomId);
    if (!ended || !ended.members.includes(guest.gid)) return null;
    const gid = ended.members[0] === guest.gid ? ended.members[1] : ended.members[0];
    return { gid, ipHash: ended.ipHashes[gid] ?? '' };
  }

  private partnerOf(room: Room, gid: string): string {
    return room.offerer === gid ? room.answerer : room.offerer;
  }

  private toPartner(room: Room, gid: string, msg: ServerMessage): void {
    this.guests.get(this.partnerOf(room, gid))?.conn?.send(msg);
  }

  private enqueue(guest: Guest): void {
    if (!guest.conn) return;
    const pair = this.matchmaker.enqueue(guest.gid, guest.language);
    if (pair) this.createRoom(pair[0].guestId, pair[1].guestId);
    else guest.conn.send({ t: 'queue:waiting' });
  }

  private sweep(): void {
    for (const [id, r] of this.recentRooms) if (Date.now() - r.endedAt > RECENT_ROOM_TTL_MS) this.recentRooms.delete(id);
    for (const [a, b] of this.matchmaker.sweep()) this.createRoom(a.guestId, b.guestId);
  }

  private createRoom(offererGid: string, answererGid: string): void {
    const a = this.guests.get(offererGid);
    const b = this.guests.get(answererGid);
    // Защитные проверки: оба онлайн, не в комнатах и это разные люди.
    if (!a?.conn || !b?.conn || a.roomId || b.roomId || a.gid === b.gid) {
      if (a?.conn && !a.roomId && a.gid !== b?.gid) this.enqueue(a);
      if (b?.conn && !b.roomId) this.enqueue(b);
      return;
    }
    const room: Room = { id: randomId(12), offerer: a.gid, answerer: b.gid, createdAt: Date.now() };
    this.rooms.set(room.id, room);
    a.roomId = room.id;
    b.roomId = room.id;
    a.lastPartner = b.gid;
    b.lastPartner = a.gid;
    this.roomsCreated++;
    try {
      this.storage.incrementRooms(new Date().toISOString().slice(0, 10));
    } catch (err) {
      this.log.error('stats write failed', { err });
    }
    a.conn.send({ t: 'match', roomId: room.id, role: 'offerer', partner: { language: b.language } });
    b.conn.send({ t: 'match', roomId: room.id, role: 'answerer', partner: { language: a.language } });
    this.log.debug('room created', { room: room.id });
  }

  /**
   * Завершает комнату. partnerReason получает второй участник;
   * selfReason (если задан) — инициатор.
   */
  private endRoom(room: Room, initiator: string, partnerReason: RoomEndReason, selfReason: RoomEndReason | null): void {
    if (!this.rooms.delete(room.id)) return;
    const partnerGid = this.partnerOf(room, initiator);
    const me = this.guests.get(initiator);
    const partner = this.guests.get(partnerGid);
    this.recentRooms.set(room.id, {
      members: [room.offerer, room.answerer],
      ipHashes: { [initiator]: me?.ipHash ?? '', [partnerGid]: partner?.ipHash ?? '' },
      endedAt: Date.now(),
    });
    for (const g of [me, partner]) {
      if (!g) continue;
      if (g.roomId === room.id) g.roomId = null;
      if (g.graceTimer && !g.conn) {
        clearTimeout(g.graceTimer);
        g.graceTimer = undefined;
        this.dropIfIdle(g.gid);
      }
    }
    partner?.conn?.send({ t: 'room:ended', roomId: room.id, reason: partnerReason });
    if (selfReason) me?.conn?.send({ t: 'room:ended', roomId: room.id, reason: selfReason });
    this.log.debug('room ended', { room: room.id, reason: partnerReason, seconds: Math.round((Date.now() - room.createdAt) / 1000) });
  }

  private dropIfIdle(gid: string): void {
    const g = this.guests.get(gid);
    if (g && !g.conn && !g.roomId && !g.graceTimer) {
      this.guests.delete(gid);
      this.moderation.forget(gid);
    }
  }

  private broadcastStats(): void {
    const online = this.onlineCount();
    if (online === this.lastBroadcastOnline) return;
    this.lastBroadcastOnline = online;
    for (const g of this.guests.values()) g.conn?.send({ t: 'stats', online });
  }
}

function short(gid: string): string {
  return gid.slice(0, 6);
}
