import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AdminBan, AdminReport, ReportReason, ReportStatus } from '../../../shared/protocol.js';
import type { ActiveBan, NewBan, NewReport, ReportTarget, Storage } from './types.js';

function findMigrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'server', 'migrations');
    if (existsSync(candidate)) return candidate;
    const sibling = path.join(dir, 'migrations');
    if (existsSync(sibling) && path.basename(dir) === 'server') return sibling;
    dir = path.dirname(dir);
  }
  throw new Error('Каталог server/migrations не найден');
}

type Row = Record<string, string | number | null>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  /** Применяет SQL-файлы из server/migrations по порядку имён, каждый — один раз. */
  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const applied = new Set(
      (this.db.prepare('SELECT name FROM schema_migrations').all() as Row[]).map((r) => str(r.name)),
    );
    const dir = findMigrationsDir();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(path.join(dir, f), 'utf8');
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`Миграция ${f} не применилась: ${(err as Error).message}`);
      }
    }
  }

  ping(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  countAdmins(): number {
    return num((this.db.prepare('SELECT COUNT(*) AS c FROM admins').get() as Row).c);
  }

  getAdmin(username: string) {
    const r = this.db.prepare('SELECT id, username, password_hash FROM admins WHERE username = ?').get(username) as
      | Row
      | undefined;
    return r ? { id: num(r.id), username: str(r.username), passwordHash: str(r.password_hash) } : null;
  }

  upsertAdmin(username: string, passwordHash: string): void {
    this.db
      .prepare(
        `INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
      )
      .run(username, passwordHash, Date.now());
  }

  createReport(r: NewReport): number | null {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO reports
           (reporter_gid, reported_gid, reported_ip_hash, room_id, reason, details, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(r.reporterGid, r.reportedGid, r.reportedIpHash, r.roomId, r.reason, r.details, now, now);
    return res.changes > 0 ? num(res.lastInsertRowid) : null;
  }

  countDistinctReporters(reportedGid: string, sinceMs: number): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(DISTINCT reporter_gid) AS c FROM reports
         WHERE reported_gid = ? AND created_at >= ? AND status != 'dismissed'`,
      )
      .get(reportedGid, sinceMs) as Row;
    return num(r.c);
  }

  listReports(opts: { status?: ReportStatus; limit: number; offset: number }) {
    const where = opts.status ? 'WHERE r.status = ?' : '';
    const args: (string | number)[] = opts.status ? [opts.status] : [];
    const monthAgo = Date.now() - 30 * 86_400_000;
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(DISTINCT x.reporter_gid) FROM reports x
              WHERE x.reported_gid = r.reported_gid AND x.created_at >= ?) AS reported_total,
           EXISTS (SELECT 1 FROM bans b WHERE b.revoked_at IS NULL
              AND (b.expires_at IS NULL OR b.expires_at > ?)
              AND (b.guest_id = r.reported_gid OR (r.reported_ip_hash IS NOT NULL AND b.ip_hash = r.reported_ip_hash))
           ) AS reported_banned
         FROM reports r ${where}
         ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(monthAgo, now, ...args, opts.limit, opts.offset) as Row[];
    const total = num(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM reports r ${where}`).get(...args) as Row).c,
    );
    const items: AdminReport[] = rows.map((r) => ({
      id: num(r.id),
      reporterId: shortId(str(r.reporter_gid)),
      reportedId: shortId(str(r.reported_gid)),
      reason: str(r.reason) as ReportReason,
      details: strOrNull(r.details),
      status: str(r.status) as ReportStatus,
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      handledBy: strOrNull(r.handled_by),
      reportedTotal: num(r.reported_total),
      reportedBanned: num(r.reported_banned) === 1,
    }));
    return { items, total };
  }

  getReportTarget(id: number): ReportTarget | null {
    const r = this.db.prepare('SELECT reported_gid, reported_ip_hash FROM reports WHERE id = ?').get(id) as
      | Row
      | undefined;
    return r ? { reportedGid: str(r.reported_gid), reportedIpHash: strOrNull(r.reported_ip_hash) } : null;
  }

  updateReportStatus(id: number, status: ReportStatus, handledBy: string): boolean {
    const res = this.db
      .prepare('UPDATE reports SET status = ?, handled_by = ?, updated_at = ? WHERE id = ?')
      .run(status, handledBy, Date.now(), id);
    return res.changes > 0;
  }

  createBan(b: NewBan): number {
    const res = this.db
      .prepare(
        'INSERT INTO bans (guest_id, ip_hash, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(b.guestId, b.ipHash, b.reason, b.createdBy, Date.now(), b.expiresAt);
    return num(res.lastInsertRowid);
  }

  findActiveBan(guestId: string | null, ipHash: string | null, now = Date.now()): ActiveBan | null {
    if (!guestId && !ipHash) return null;
    const r = this.db
      .prepare(
        `SELECT id, reason, expires_at FROM bans
         WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
           AND ((? IS NOT NULL AND guest_id = ?) OR (? IS NOT NULL AND ip_hash = ?))
         ORDER BY (expires_at IS NULL) DESC, expires_at DESC LIMIT 1`,
      )
      .get(now, guestId, guestId, ipHash, ipHash) as Row | undefined;
    return r ? { id: num(r.id), reason: str(r.reason), until: r.expires_at === null ? null : num(r.expires_at) } : null;
  }

  listActiveBans(now = Date.now()): AdminBan[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC LIMIT 500`,
      )
      .all(now) as Row[];
    return rows.map((r) => ({
      id: num(r.id),
      guestId: r.guest_id === null ? null : shortId(str(r.guest_id)),
      byNetwork: r.ip_hash !== null,
      reason: str(r.reason),
      createdAt: num(r.created_at),
      expiresAt: r.expires_at === null ? null : num(r.expires_at),
      createdBy: str(r.created_by),
    }));
  }

  revokeBan(id: number): boolean {
    return this.db.prepare('UPDATE bans SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id)
      .changes > 0;
  }

  addBlock(blockerGid: string, blockedGid: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO blocks (blocker_gid, blocked_gid, created_at) VALUES (?, ?, ?)')
      .run(blockerGid, blockedGid, Date.now());
  }

  getBlockedPeers(gid: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT blocked_gid AS peer FROM blocks WHERE blocker_gid = ?
         UNION SELECT blocker_gid AS peer FROM blocks WHERE blocked_gid = ?`,
      )
      .all(gid, gid) as Row[];
    return rows.map((r) => str(r.peer));
  }

  incrementRooms(day: string): void {
    this.db
      .prepare('INSERT INTO stats_daily (day, rooms) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET rooms = rooms + 1')
      .run(day);
  }

  roomsSince(day: string): number {
    return num((this.db.prepare('SELECT COALESCE(SUM(rooms), 0) AS c FROM stats_daily WHERE day >= ?').get(day) as Row).c);
  }

  countReports(opts: { status?: ReportStatus; sinceMs?: number }): number {
    const conds: string[] = [];
    const args: (string | number)[] = [];
    if (opts.status) {
      conds.push('status = ?');
      args.push(opts.status);
    }
    if (opts.sinceMs !== undefined) {
      conds.push('created_at >= ?');
      args.push(opts.sinceMs);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return num((this.db.prepare(`SELECT COUNT(*) AS c FROM reports ${where}`).get(...args) as Row).c);
  }

  countActiveBans(now = Date.now()): number {
    return num(
      (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)')
          .get(now) as Row
      ).c,
    );
  }

  purgeExpired(opts: { reportOlderThanMs: number; blockOlderThanMs: number; banExpiredBeforeMs: number }) {
    const reports = this.db
      .prepare("DELETE FROM reports WHERE created_at < ? AND status IN ('resolved', 'dismissed')")
      .run(opts.reportOlderThanMs).changes;
    const blocks = this.db.prepare('DELETE FROM blocks WHERE created_at < ?').run(opts.blockOlderThanMs).changes;
    const bans = this.db
      .prepare(
        'DELETE FROM bans WHERE (expires_at IS NOT NULL AND expires_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?)',
      )
      .run(opts.banExpiredBeforeMs, opts.banExpiredBeforeMs).changes;
    return { reports: num(reports), blocks: num(blocks), bans: num(bans) };
  }
}

/** В админке показываем короткий псевдоним гостя, а не полный идентификатор. */
function shortId(gid: string): string {
  return gid.slice(0, 8);
}
