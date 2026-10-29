import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashPassword } from '../src/auth/tokens.js';
import { createGuest, startTestServer, TestClient, type TestServer } from './helpers.js';

let srv: TestServer;
before(async () => {
  srv = await startTestServer({
    TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349',
    TURN_SECRET: 'turn-shared-secret',
  });
  srv.ctx.storage.upsertAdmin('root', await hashPassword('correct horse battery'));
});
after(async () => {
  await srv.close();
});

const json = (body: unknown, extra: Record<string, string> = {}) => ({
  headers: { 'Content-Type': 'application/json', Origin: srv.origin, ...extra },
  body: JSON.stringify(body),
});

describe('гостевая сессия', () => {
  it('без подтверждения 18+ сессия не выдаётся', async () => {
    const r = await fetch(`${srv.origin}/api/session`, { method: 'POST', ...json({ rulesAccepted: true }) });
    assert.equal(r.status, 400);
  });

  it('запрос с чужого Origin отклоняется (CSRF)', async () => {
    const r = await fetch(`${srv.origin}/api/session`, {
      method: 'POST',
      ...json({ ageConfirmed: true, rulesAccepted: true }, { Origin: 'https://evil.example' }),
    });
    assert.equal(r.status, 403);
  });

  it('cookie httpOnly и SameSite', async () => {
    const r = await fetch(`${srv.origin}/api/session`, {
      method: 'POST',
      ...json({ ageConfirmed: true, rulesAccepted: true }),
    });
    const c = r.headers.get('set-cookie') ?? '';
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
  });

  it('ICE-конфигурация выдаётся только с сессией и содержит временные TURN-учётки', async () => {
    assert.equal((await fetch(`${srv.origin}/api/ice`)).status, 401);
    const cookie = await createGuest(srv);
    const r = await fetch(`${srv.origin}/api/ice`, { headers: { Cookie: cookie } });
    const ice = (await r.json()) as { iceServers: { urls: string[]; username?: string; credential?: string }[] };
    const turn = ice.iceServers.find((s) => s.urls.some((u) => u.startsWith('turn')));
    assert.ok(turn?.username && turn.credential);
    const expiry = Number(turn.username.split(':')[0]);
    assert.ok(expiry > Date.now() / 1000);
  });

  it('health-check и заголовки безопасности', async () => {
    const r = await fetch(`${srv.origin}/readyz`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('административная панель', () => {
  it('без входа API администратора недоступен', async () => {
    for (const path of ['/api/admin/stats', '/api/admin/reports', '/api/admin/bans']) {
      assert.equal((await fetch(`${srv.origin}${path}`)).status, 401, path);
    }
    // Гостевой cookie не даёт админских прав.
    const guest = await createGuest(srv);
    assert.equal((await fetch(`${srv.origin}/api/admin/stats`, { headers: { Cookie: guest } })).status, 401);
  });

  it('неверный пароль отклоняется', async () => {
    const r = await fetch(`${srv.origin}/api/admin/login`, {
      method: 'POST',
      ...json({ username: 'root', password: 'wrong' }),
    });
    assert.equal(r.status, 401);
  });

  it('админ видит жалобы, меняет статус и банит нарушителя', async () => {
    // Создаём жалобу через настоящий чат.
    const a = await TestClient.connect(srv, await createGuest(srv));
    const b = await TestClient.connect(srv, await createGuest(srv));
    a.send({ t: 'queue:join', language: 'any' });
    await a.waitFor('queue:waiting');
    b.send({ t: 'queue:join', language: 'any' });
    const m = await a.waitFor('match');
    await b.waitFor('match');
    a.send({ t: 'report', roomId: m.roomId, reason: 'spam', details: 'реклама' });
    await a.waitFor('report:ok');

    const login = await fetch(`${srv.origin}/api/admin/login`, {
      method: 'POST',
      ...json({ username: 'root', password: 'correct horse battery' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.match(login.headers.get('set-cookie') ?? '', /SameSite=Strict/);
    const auth = { Cookie: cookie };

    const list = (await (await fetch(`${srv.origin}/api/admin/reports?status=open`, { headers: auth })).json()) as {
      items: { id: number; reason: string }[];
    };
    const report = list.items.find((r) => r.reason === 'spam');
    assert.ok(report);

    const patch = await fetch(`${srv.origin}/api/admin/reports/${report.id}`, {
      method: 'PATCH',
      ...json({ status: 'reviewing' }, auth),
    });
    assert.equal(patch.status, 200);

    const ban = await fetch(`${srv.origin}/api/admin/reports/${report.id}/ban`, {
      method: 'POST',
      ...json({ hours: 24, network: false, reason: 'Спам' }, auth),
    });
    assert.equal(ban.status, 200);
    await b.waitFor('banned');
    assert.equal((await a.waitFor('room:ended')).reason, 'partner-disconnected');

    const stats = (await (await fetch(`${srv.origin}/api/admin/stats`, { headers: auth })).json()) as {
      activeBans: number;
    };
    assert.equal(stats.activeBans, 1);

    const bans = (await (await fetch(`${srv.origin}/api/admin/bans`, { headers: auth })).json()) as {
      items: { id: number }[];
    };
    const del = await fetch(`${srv.origin}/api/admin/bans/${bans.items[0]!.id}`, {
      method: 'DELETE',
      headers: { ...auth, Origin: srv.origin },
    });
    assert.equal(del.status, 200);
    a.close();
  });
});
