import type { ReportReason } from '../../../shared/protocol.js';
import type { Logger } from '../lib/logger.js';
import type { ActiveBan, Storage } from '../storage/types.js';

export interface ModerationOptions {
  autoBanThreshold: number;
  autoBanHours: number;
}

export interface ReportOutcome {
  created: boolean;
  autoBanned: ActiveBan | null;
}

/**
 * Жалобы, блокировки и баны. Держит в памяти кэш блокировок для быстрого
 * подбора пар; источник истины — хранилище.
 */
export class Moderation {
  private readonly blockCache = new Map<string, Set<string>>();

  constructor(
    private readonly storage: Storage,
    private readonly opts: ModerationOptions,
    private readonly log: Logger,
  ) {}

  loadBlocks(guestId: string): void {
    if (this.blockCache.has(guestId)) return;
    this.blockCache.set(guestId, new Set(this.storage.getBlockedPeers(guestId)));
  }

  forget(guestId: string): void {
    this.blockCache.delete(guestId);
  }

  isBlocked(a: string, b: string): boolean {
    return Boolean(this.blockCache.get(a)?.has(b) || this.blockCache.get(b)?.has(a));
  }

  block(blocker: string, blocked: string): void {
    this.storage.addBlock(blocker, blocked);
    this.cacheFor(blocker).add(blocked);
    this.cacheFor(blocked).add(blocker);
  }

  private cacheFor(gid: string): Set<string> {
    let s = this.blockCache.get(gid);
    if (!s) {
      s = new Set(this.storage.getBlockedPeers(gid));
      this.blockCache.set(gid, s);
    }
    return s;
  }

  activeBan(guestId: string | null, ipHash: string | null): ActiveBan | null {
    return this.storage.findActiveBan(guestId, ipHash);
  }

  /**
   * Сохраняет жалобу. Если на гостя пожаловались разные люди сверх порога
   * за последние 24 часа — автоматически выдаёт временный бан.
   */
  report(input: {
    reporterGid: string;
    reportedGid: string;
    reportedIpHash: string | null;
    roomId: string;
    reason: ReportReason;
    details: string | null;
  }): ReportOutcome {
    const id = this.storage.createReport(input);
    if (id === null) return { created: false, autoBanned: null };
    this.log.info('report created', { reportId: id, reason: input.reason });

    if (this.opts.autoBanThreshold <= 0) return { created: true, autoBanned: null };
    const distinct = this.storage.countDistinctReporters(input.reportedGid, Date.now() - 24 * 3600_000);
    if (distinct < this.opts.autoBanThreshold) return { created: true, autoBanned: null };
    if (this.storage.findActiveBan(input.reportedGid, null)) return { created: true, autoBanned: null };

    const expiresAt = Date.now() + this.opts.autoBanHours * 3600_000;
    const reason = 'Автоматическое ограничение: много жалоб от разных пользователей';
    const banId = this.storage.createBan({
      guestId: input.reportedGid,
      ipHash: input.reportedIpHash,
      reason,
      createdBy: 'auto',
      expiresAt,
    });
    this.log.warn('auto ban issued', { banId, distinctReporters: distinct });
    return { created: true, autoBanned: { id: banId, until: expiresAt, reason } };
  }
}
