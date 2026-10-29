import { z } from 'zod';
import { REPORT_STATUSES, type AdminStats, type ReportStatus } from '../../../shared/protocol.js';
import { hashPassword, randomId, verifyPassword } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { KeyedRateLimiter } from '../lib/rateLimit.js';
import { clearCookie, parseCookies, setCookie } from './cookies.js';
import { HttpError, type RequestContext, type Router } from './router.js';

export const ADMIN_COOKIE = 'vc_admin';
const ADMIN_TTL_SECONDS = 12 * 3600;

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });
const statusBody = z.object({ status: z.enum(REPORT_STATUSES as [ReportStatus, ...ReportStatus[]]) });
const banBody = z.object({
  hours: z.number().int().min(1).max(24 * 365).nullable(),
  network: z.boolean().default(false),
  reason: z.string().trim().min(3).max(200),
});

/** Проверка прав администратора на сервере для каждого запроса. */
function requireAdmin(ctx: AppContext, rc: RequestContext): string {
  const session = ctx.adminTokens.verify<{ admin: string }>(parseCookies(rc.req)[ADMIN_COOKIE]);
  if (!session || !ctx.storage.getAdmin(session.admin)) throw new HttpError(401, 'Требуется вход администратора');
  return session.admin;
}

const idParam = (rc: RequestContext): number => {
  const id = Number(rc.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Некорректный id');
  return id;
};

export function registerAdminRoutes(router: Router, ctx: AppContext): void {
  const loginLimiter = new KeyedRateLimiter(5, 5 / 900); // 5 попыток за 15 минут с сети
  // Для несуществующего логина всё равно считаем scrypt, чтобы время ответа не выдавало логины.
  const dummyHash = hashPassword(randomId());

  router.post('/api/admin/login', async (rc) => {
    if (!loginLimiter.take(rc.ipHash)) throw new HttpError(429, 'Слишком много попыток входа, подождите 15 минут');
    const body = loginBody.safeParse(await rc.body());
    if (!body.success) throw new HttpError(400, 'Укажите логин и пароль');
    const admin = ctx.storage.getAdmin(body.data.username);
    const ok = await verifyPassword(body.data.password, admin?.passwordHash ?? (await dummyHash));
    if (!admin || !ok) {
      ctx.log.warn('admin login failed');
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    setCookie(rc.res, ADMIN_COOKIE, ctx.adminTokens.sign({ admin: admin.username }, ADMIN_TTL_SECONDS), {
      maxAgeSeconds: ADMIN_TTL_SECONDS,
      secure: ctx.config.secureCookies,
      sameSite: 'Strict',
      path: '/api/admin',
    });
    ctx.log.info('admin login', { admin: admin.username });
    return { username: admin.username };
  });

  router.post('/api/admin/logout', (rc) => {
    clearCookie(rc.res, ADMIN_COOKIE, ctx.config.secureCookies, '/api/admin');
    return { ok: true };
  });

  router.get('/api/admin/me', (rc) => ({ username: requireAdmin(ctx, rc) }));

  router.get('/api/admin/stats', (rc): AdminStats => {
    requireAdmin(ctx, rc);
    const live = ctx.hub.snapshot();
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const startOfDay = new Date(`${today}T00:00:00.000Z`).getTime();
    return {
      online: live.online,
      searching: live.searching,
      activeRooms: live.activeRooms,
      roomsToday: ctx.storage.roomsSince(today),
      rooms7d: ctx.storage.roomsSince(weekAgo),
      reportsOpen: ctx.storage.countReports({ status: 'open' }),
      reportsToday: ctx.storage.countReports({ sinceMs: startOfDay }),
      activeBans: ctx.storage.countActiveBans(),
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
    };
  });

  router.get('/api/admin/reports', (rc) => {
    requireAdmin(ctx, rc);
    const status = rc.url.searchParams.get('status');
    if (status && !REPORT_STATUSES.includes(status as ReportStatus)) throw new HttpError(400, 'Неизвестный статус');
    const page = Math.max(0, Number(rc.url.searchParams.get('page') ?? 0) || 0);
    const limit = 25;
    const result = ctx.storage.listReports({
      status: (status as ReportStatus | null) ?? undefined,
      limit,
      offset: page * limit,
    });
    return { ...result, page, pageSize: limit };
  });

  router.patch('/api/admin/reports/:id', async (rc) => {
    const admin = requireAdmin(ctx, rc);
    const body = statusBody.safeParse(await rc.body());
    if (!body.success) throw new HttpError(400, 'Некорректный статус');
    if (!ctx.storage.updateReportStatus(idParam(rc), body.data.status, admin)) throw new HttpError(404, 'Жалоба не найдена');
    ctx.log.info('report status changed', { admin, reportId: idParam(rc), status: body.data.status });
    return { ok: true };
  });

  router.post('/api/admin/reports/:id/ban', async (rc) => {
    const admin = requireAdmin(ctx, rc);
    const id = idParam(rc);
    const body = banBody.safeParse(await rc.body());
    if (!body.success) throw new HttpError(400, 'Укажите срок и причину (от 3 символов)');
    const target = ctx.storage.getReportTarget(id);
    if (!target) throw new HttpError(404, 'Жалоба не найдена');
    if (body.data.network && !target.reportedIpHash) throw new HttpError(409, 'Для этой жалобы нет данных о сети');
    const expiresAt = body.data.hours === null ? null : Date.now() + body.data.hours * 3600_000;
    const banId = ctx.storage.createBan({
      guestId: target.reportedGid,
      ipHash: body.data.network ? target.reportedIpHash : null,
      reason: body.data.reason,
      createdBy: `admin:${admin}`,
      expiresAt,
    });
    ctx.storage.updateReportStatus(id, 'resolved', admin);
    const ban = { id: banId, until: expiresAt, reason: body.data.reason };
    ctx.hub.kick(target.reportedGid, ban);
    if (body.data.network && target.reportedIpHash) ctx.hub.kickNetwork(target.reportedIpHash, ban);
    ctx.log.info('ban issued', { admin, banId, network: body.data.network, hours: body.data.hours });
    return { banId };
  });

  router.get('/api/admin/bans', (rc) => {
    requireAdmin(ctx, rc);
    return { items: ctx.storage.listActiveBans() };
  });

  router.delete('/api/admin/bans/:id', (rc) => {
    const admin = requireAdmin(ctx, rc);
    if (!ctx.storage.revokeBan(idParam(rc))) throw new HttpError(404, 'Бан не найден или уже снят');
    ctx.log.info('ban revoked', { admin, banId: idParam(rc) });
    return { ok: true };
  });
}
