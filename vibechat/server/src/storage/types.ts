import type { AdminBan, AdminReport, ReportReason, ReportStatus } from '../../../shared/protocol.js';

export interface NewReport {
  reporterGid: string;
  reportedGid: string;
  reportedIpHash: string | null;
  roomId: string;
  reason: ReportReason;
  details: string | null;
}

export interface NewBan {
  guestId: string | null;
  ipHash: string | null;
  reason: string;
  createdBy: string;
  expiresAt: number | null;
}

export interface ActiveBan {
  id: number;
  until: number | null;
  reason: string;
}

export interface ReportTarget {
  reportedGid: string;
  reportedIpHash: string | null;
}

/**
 * Хранилище. Реализация по умолчанию — встроенный в Node SQLite (без внешних
 * сервисов). Для нескольких инстансов достаточно реализовать этот интерфейс
 * поверх PostgreSQL — остальной код от него не зависит.
 */
export interface Storage {
  ping(): boolean;
  close(): void;

  countAdmins(): number;
  getAdmin(username: string): { id: number; username: string; passwordHash: string } | null;
  upsertAdmin(username: string, passwordHash: string): void;

  /** Возвращает id новой жалобы или null, если этот участник уже жаловался в этой комнате. */
  createReport(r: NewReport): number | null;
  countDistinctReporters(reportedGid: string, sinceMs: number): number;
  listReports(opts: { status?: ReportStatus; limit: number; offset: number }): { items: AdminReport[]; total: number };
  getReportTarget(id: number): ReportTarget | null;
  updateReportStatus(id: number, status: ReportStatus, handledBy: string): boolean;

  createBan(b: NewBan): number;
  findActiveBan(guestId: string | null, ipHash: string | null, now?: number): ActiveBan | null;
  listActiveBans(now?: number): AdminBan[];
  revokeBan(id: number): boolean;

  addBlock(blockerGid: string, blockedGid: string): void;
  /** Все, с кем гостя нельзя соединять (он заблокировал или его заблокировали). */
  getBlockedPeers(gid: string): string[];

  incrementRooms(day: string): void;
  roomsSince(day: string): number;
  countReports(opts: { status?: ReportStatus; sinceMs?: number }): number;
  countActiveBans(now?: number): number;

  purgeExpired(opts: { reportOlderThanMs: number; blockOlderThanMs: number; banExpiredBeforeMs: number }): {
    reports: number;
    blocks: number;
    bans: number;
  };
}
