import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { IceConfig, PublicConfig, SessionInfo } from '../../../shared/protocol.js';
import { randomId } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { KeyedRateLimiter } from '../lib/rateLimit.js';
import { clearCookie, parseCookies, setCookie } from './cookies.js';
import { HttpError, type RequestContext, type Router } from './router.js';

export const GUEST_COOKIE = 'vc_guest';
const GUEST_TTL_SECONDS = 30 * 24 * 3600;

const sessionBody = z.object({
  ageConfirmed: z.literal(true),
  rulesAccepted: z.literal(true),
  turnstileToken: z.string().max(4096).optional(),
});

export function currentGuest(ctx: AppContext, rc: RequestContext): string | null {
  return ctx.guestTokens.verify<{ gid: string }>(parseCookies(rc.req)[GUEST_COOKIE])?.gid ?? null;
}

async function verifyTurnstile(ctx: AppContext, token: string | undefined, ip: string): Promise<boolean> {
  const secret = ctx.config.turnstileSecretKey;
  if (!secret) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token, remoteip: ip });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    const data = (await r.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    ctx.log.error('turnstile verification failed', { err });
    return false;
  }
}

/** Временные TURN-учётки по схеме TURN REST API (coturn use-auth-secret, Open Relay). */
export function buildIceConfig(ctx: AppContext, gid: string): IceConfig {
  const c = ctx.config;
  const iceServers: IceConfig['iceServers'] = [];
  if (c.iceTransportPolicy !== 'relay' && c.stunUrls.length) iceServers.push({ urls: c.stunUrls });
  if (c.turnUrls.length) {
    if (c.turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + c.turnTtlSeconds;
      const username = `${expiry}:${gid.slice(0, 12)}`;
      const credential = createHmac('sha1', c.turnSecret).update(username).digest('base64');
      iceServers.push({ urls: c.turnUrls, username, credential });
    } else if (c.turnUsername && c.turnCredential) {
      iceServers.push({ urls: c.turnUrls, username: c.turnUsername, credential: c.turnCredential });
    }
  }
  return { iceServers, iceTransportPolicy: c.iceTransportPolicy, ttlSeconds: c.turnTtlSeconds };
}

type CloudflareIce = { iceServers?: { urls?: string | string[]; username?: string; credential?: string }[] | { urls?: string | string[]; username?: string; credential?: string } };

let cloudflareCache: { servers: IceConfig['iceServers']; expires: number } | null = null;

/**
 * Cloudflare Realtime TURN: учётки выдаёт API Cloudflare. Кэшируем на сервере,
 * чтобы не дергать API на каждый звонок. При ошибке API звонок не ломается —
 * остаются STUN и прочие TURN.
 */
async function cloudflareIceServers(ctx: AppContext): Promise<IceConfig['iceServers']> {
  const cf = ctx.config.cloudflareTurn;
  if (!cf) return [];
  if (cloudflareCache && cloudflareCache.expires > Date.now()) return cloudflareCache.servers;
  const ttl = ctx.config.turnTtlSeconds;
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cf.keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cf.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as CloudflareIce;
    const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
    const servers: IceConfig['iceServers'] = list
      .map((s) => ({
        urls: (Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : []).filter(
          // Порт 53 часто блокируется браузерами — убираем его, как советует Cloudflare.
          (u) => !/:53(\?|$)/.test(u),
        ),
        username: s.username,
        credential: s.credential,
      }))
      .filter((s) => s.urls.length > 0);
    cloudflareCache = { servers, expires: Date.now() + (ttl * 1000) / 2 };
    return servers;
  } catch (err) {
    ctx.log.error('cloudflare turn credentials failed', { err });
    return [];
  }
}

export async function iceConfigFor(ctx: AppContext, gid: string): Promise<IceConfig> {
  const base = buildIceConfig(ctx, gid);
  const cf = await cloudflareIceServers(ctx);
  return { ...base, iceServers: [...base.iceServers, ...cf] };
}

export function registerSessionRoutes(router: Router, ctx: AppContext): void {
  const createLimiter = new KeyedRateLimiter(ctx.config.sessionBurstPerIp, 1 / 20);
  const iceLimiter = new KeyedRateLimiter(30, 0.5);

  router.get('/api/config', (): PublicConfig => ({
    appName: ctx.config.appName,
    turnstileSiteKey: ctx.config.turnstileSiteKey,
    supportEmail: ctx.config.supportEmail,
    iceTransportPolicy: ctx.config.iceTransportPolicy,
  }));

  router.get('/api/session', (rc): SessionInfo => {
    const gid = currentGuest(ctx, rc);
    const ban = ctx.moderation.activeBan(gid, rc.ipHash);
    return { authenticated: Boolean(gid), banned: ban ? { until: ban.until, reason: ban.reason } : null };
  });

  /**
   * Гостевой вход после подтверждения 18+ и согласия с правилами.
   * Это самостоятельное заявление пользователя, а не проверка возраста.
   */
  router.post('/api/session', async (rc): Promise<SessionInfo> => {
    const body = sessionBody.safeParse(await rc.body());
    if (!body.success) throw new HttpError(400, 'Нужно подтвердить возраст 18+ и принять правила');
    const existing = currentGuest(ctx, rc);
    if (!existing && !createLimiter.take(rc.ipHash)) throw new HttpError(429, 'Слишком много попыток, попробуйте позже');
    if (!existing && !(await verifyTurnstile(ctx, body.data.turnstileToken, rc.ip)))
      throw new HttpError(403, 'Проверка «я не робот» не пройдена', 'captcha');

    const gid = existing ?? randomId(18);
    const ban = ctx.moderation.activeBan(gid, rc.ipHash);
    if (ban) return { authenticated: false, banned: { until: ban.until, reason: ban.reason } };

    setCookie(rc.res, GUEST_COOKIE, ctx.guestTokens.sign({ gid, age: true }, GUEST_TTL_SECONDS), {
      maxAgeSeconds: GUEST_TTL_SECONDS,
      secure: ctx.config.secureCookies,
      sameSite: 'Lax',
    });
    return { authenticated: true, banned: null };
  });

  router.delete('/api/session', (rc) => {
    clearCookie(rc.res, GUEST_COOKIE, ctx.config.secureCookies);
    return { ok: true };
  });

  router.get('/api/ice', async (rc): Promise<IceConfig> => {
    const gid = currentGuest(ctx, rc);
    if (!gid) throw new HttpError(401, 'Нет сессии');
    if (!iceLimiter.take(rc.ipHash)) throw new HttpError(429, 'Слишком часто');
    return iceConfigFor(ctx, gid);
  });
}
