/**
 * Протокол обмена между браузером и сервером по WebSocket.
 * Файл общий для клиента и сервера и не содержит зависимостей,
 * поэтому не утяжеляет клиентский бандл.
 */

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  chatMaxLength: 500,
  reportDetailsMaxLength: 500,
  /** Максимальный размер одного WebSocket-сообщения (SDP обычно 3–10 КБ). */
  wsMaxPayloadBytes: 64 * 1024,
  sdpMaxLength: 40_000,
  iceCandidateMaxLength: 1_000,
  diagEchoMaxLength: 40_000,
} as const;

/** Языки, по которым работает фильтр подбора. "any" — без фильтра. */
export const LANGUAGES = [
  { code: 'any', label: 'Любой язык' },
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Українська' },
  { code: 'kk', label: 'Қазақша' },
  { code: 'be', label: 'Беларуская' },
  { code: 'uz', label: 'Oʻzbekcha' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'pl', label: 'Polski' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as readonly LanguageCode[];

export const REPORT_REASONS = [
  { code: 'nudity', label: 'Обнажёнка или сексуальный контент' },
  { code: 'minor', label: 'Похоже на несовершеннолетнего' },
  { code: 'harassment', label: 'Оскорбления или травля' },
  { code: 'hate', label: 'Разжигание ненависти' },
  { code: 'violence', label: 'Насилие или угрозы' },
  { code: 'spam', label: 'Спам или реклама' },
  { code: 'other', label: 'Другое' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['code'];
export const REPORT_REASON_CODES = REPORT_REASONS.map((r) => r.code) as readonly ReportReason[];

export type Role = 'offerer' | 'answerer';

export type SignalData =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | {
      kind: 'ice';
      candidate: {
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
        usernameFragment?: string | null;
      };
    };

export type RoomEndReason =
  | 'partner-left'
  | 'partner-next'
  | 'partner-disconnected'
  | 'you-left'
  | 'connection-failed';

// ─── Client → Server ────────────────────────────────────────────────────────

export type ClientMessage =
  | { t: 'queue:join'; language: LanguageCode }
  | { t: 'queue:leave' }
  | { t: 'room:next'; roomId: string; language: LanguageCode }
  | { t: 'room:leave'; roomId: string }
  | { t: 'room:failed'; roomId: string }
  | { t: 'signal'; roomId: string; data: SignalData }
  | { t: 'chat:send'; roomId: string; text: string; clientMsgId: string }
  | { t: 'peer:state'; roomId: string; camOn: boolean; micOn: boolean }
  | { t: 'report'; roomId: string; reason: ReportReason; details?: string }
  | { t: 'block'; roomId: string }
  /** Проверка связи: сервер возвращает те же данные (страница /check). */
  | { t: 'diag:echo'; id: string; payload: string };

// ─── Server → Client ────────────────────────────────────────────────────────

export type ErrorCode =
  | 'bad-request'
  | 'not-in-room'
  | 'rate-limited'
  | 'already-in-room'
  | 'message-rejected'
  | 'internal';

export type ServerMessage =
  | { t: 'hello'; protocol: number; online: number }
  | { t: 'stats'; online: number }
  | { t: 'queue:waiting' }
  | { t: 'queue:left' }
  | { t: 'match'; roomId: string; role: Role; partner: { language: LanguageCode } }
  | { t: 'signal'; roomId: string; data: SignalData }
  | { t: 'chat:msg'; roomId: string; id: string; mine: boolean; text: string; ts: number; clientMsgId?: string }
  | { t: 'peer:state'; roomId: string; camOn: boolean; micOn: boolean }
  | { t: 'room:ended'; roomId: string; reason: RoomEndReason }
  | { t: 'room:paused'; roomId: string }
  | { t: 'room:resumed'; roomId: string; role: Role }
  | { t: 'report:ok'; roomId: string }
  | { t: 'block:ok'; roomId: string }
  | { t: 'banned'; until: number | null; reason: string }
  | { t: 'session:replaced' }
  | { t: 'diag:echo'; id: string; payload: string }
  | { t: 'error'; code: ErrorCode; message: string; ref?: string };

/** Коды закрытия WebSocket (диапазон 4000–4999 — для приложений). */
export const CLOSE_CODES = {
  unauthorized: 4001,
  banned: 4003,
  sessionReplaced: 4009,
  rateLimited: 4029,
  originDenied: 4030,
} as const;

// ─── HTTP API ───────────────────────────────────────────────────────────────

export interface PublicConfig {
  appName: string;
  turnstileSiteKey: string | null;
  supportEmail: string | null;
  iceTransportPolicy: 'all' | 'relay';
}

export interface SessionInfo {
  authenticated: boolean;
  banned: { until: number | null; reason: string } | null;
}

export interface IceConfig {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  iceTransportPolicy: 'all' | 'relay';
  ttlSeconds: number;
}

export type ReportStatus = 'open' | 'reviewing' | 'resolved' | 'dismissed';
export const REPORT_STATUSES: readonly ReportStatus[] = ['open', 'reviewing', 'resolved', 'dismissed'];

export interface AdminReport {
  id: number;
  reporterId: string;
  reportedId: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  createdAt: number;
  updatedAt: number;
  handledBy: string | null;
  /** Сколько всего жалоб на этого гостя от разных людей за 30 дней. */
  reportedTotal: number;
  reportedBanned: boolean;
}

export interface AdminBan {
  id: number;
  guestId: string | null;
  byNetwork: boolean;
  reason: string;
  createdAt: number;
  expiresAt: number | null;
  createdBy: string;
}

export interface AdminStats {
  online: number;
  searching: number;
  activeRooms: number;
  roomsToday: number;
  rooms7d: number;
  reportsOpen: number;
  reportsToday: number;
  activeBans: number;
  uptimeSeconds: number;
}
