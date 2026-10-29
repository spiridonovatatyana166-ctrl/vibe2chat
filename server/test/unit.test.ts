import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, TokenSigner, verifyPassword } from '../src/auth/tokens.js';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { TokenBucket } from '../src/lib/rateLimit.js';
import { Matchmaker, REMATCH_COOLDOWN_MS } from '../src/matchmaking/matchmaker.js';
import { sanitizeText } from '../src/realtime/schemas.js';

describe('Matchmaker', () => {
  const policy = (blocked: [string, string][] = [], last: Record<string, string> = {}) => ({
    isBlocked: (a: string, b: string) => blocked.some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
    lastPartner: (g: string) => last[g],
  });

  it('не соединяет гостя с самим собой и не дублирует его в очереди', () => {
    const mm = new Matchmaker(policy());
    assert.equal(mm.enqueue('a', 'any'), null);
    assert.equal(mm.enqueue('a', 'any'), null);
    assert.equal(mm.size, 1);
  });

  it('соединяет двух разных гостей и убирает их из очереди', () => {
    const mm = new Matchmaker(policy());
    mm.enqueue('a', 'any');
    const pair = mm.enqueue('b', 'any');
    assert.deepEqual(
      pair?.map((p) => p.guestId),
      ['a', 'b'],
    );
    assert.equal(mm.size, 0);
  });

  it('учитывает язык и предпочитает точное совпадение', () => {
    // any1 и ru1 заблокировали друг друга, поэтому оба ждут в очереди одновременно.
    const mm = new Matchmaker(policy([['any1', 'ru1']]));
    mm.enqueue('any1', 'any');
    mm.enqueue('ru1', 'ru');
    assert.equal(mm.enqueue('en1', 'en')?.[0].guestId, 'any1');
    assert.equal(mm.size, 1);
    const mm2 = new Matchmaker(policy([['any1', 'ru1']]));
    mm2.enqueue('any1', 'any');
    mm2.enqueue('ru1', 'ru');
    assert.equal(mm2.enqueue('ru2', 'ru')?.[0].guestId, 'ru1');
    assert.equal(mm2.enqueue('de1', 'de')?.[0].guestId, 'any1');
    // Разные конкретные языки не соединяются.
    const mm3 = new Matchmaker(policy());
    mm3.enqueue('ru', 'ru');
    assert.equal(mm3.enqueue('en', 'en'), null);
  });

  it('не соединяет заблокированных', () => {
    const mm = new Matchmaker(policy([['a', 'b']]));
    mm.enqueue('a', 'any');
    assert.equal(mm.enqueue('b', 'any'), null);
    assert.equal(mm.sweep().length, 0);
  });

  it('разрешает повторную встречу с последним собеседником только после паузы', () => {
    let t = 1000;
    const mm = new Matchmaker(policy([], { a: 'b', b: 'a' }), () => t);
    mm.enqueue('a', 'any');
    assert.equal(mm.enqueue('b', 'any'), null);
    t += REMATCH_COOLDOWN_MS + 1;
    assert.equal(mm.sweep().length, 1);
  });
});

describe('sanitizeText', () => {
  it('убирает управляющие и невидимые символы', () => {
    assert.equal(sanitizeText(' при​вет‮ \u0007', 500), 'привет');
  });
  it('отклоняет пустые и длинные сообщения', () => {
    assert.equal(sanitizeText('   ', 500), null);
    assert.equal(sanitizeText('a'.repeat(501), 500), null);
    assert.equal(sanitizeText('😀'.repeat(500), 500), '😀'.repeat(500));
  });
});

describe('токены и пароли', () => {
  it('подпись проверяется, подделка и чужое назначение отклоняются', () => {
    const guest = new TokenSigner('s'.repeat(40), 'guest');
    const admin = new TokenSigner('s'.repeat(40), 'admin');
    const token = guest.sign({ gid: 'abc' }, 60);
    assert.equal(guest.verify<{ gid: string }>(token)?.gid, 'abc');
    assert.equal(admin.verify(token), null);
    assert.equal(guest.verify(token.slice(0, -2) + 'xx'), null);
    assert.equal(guest.verify(guest.sign({ gid: 'abc' }, -1)), null);
  });

  it('пароли хешируются scrypt', async () => {
    const h = await hashPassword('secret password');
    assert.ok(await verifyPassword('secret password', h));
    assert.ok(!(await verifyPassword('other', h)));
  });
});

describe('TokenBucket', () => {
  it('ограничивает всплеск и восстанавливается со временем', () => {
    let t = 0;
    const b = new TokenBucket(2, 1, () => t);
    assert.ok(b.take() && b.take());
    assert.ok(!b.take());
    t += 1000;
    assert.ok(b.take());
  });
});

describe('конфигурация', () => {
  it('в production требует HTTPS-адрес и длинный секрет', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), ConfigError);
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://x.com', SESSION_SECRET: 'x'.repeat(40) }),
      /https/,
    );
    const ok = loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://x.com', SESSION_SECRET: 'x'.repeat(40) });
    assert.equal(ok.secureCookies, true);
  });

  it('на Render адрес сайта берётся из RENDER_EXTERNAL_URL', () => {
    const c = loadConfig({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://vibechat.onrender.com', SESSION_SECRET: 'x'.repeat(40) });
    assert.equal(c.publicOrigin, 'https://vibechat.onrender.com');
  });

  it('без своего TURN подключается бесплатный публичный, его можно выключить', () => {
    const c = loadConfig({});
    assert.equal(c.publicTurn, true);
    assert.ok(c.turnUrls.some((u) => u.includes('openrelay')));
    assert.ok(c.turnSecret);
    const off = loadConfig({ PUBLIC_TURN: 'off' });
    assert.equal(off.turnUrls.length, 0);
    const own = loadConfig({ TURN_URLS: 'turn:my.example.com', TURN_SECRET: 's' });
    assert.equal(own.publicTurn, false);
    assert.deepEqual(own.turnUrls, ['turn:my.example.com']);
  });

  it('TURN без учётных данных — ошибка', () => {
    assert.throws(() => loadConfig({ TURN_URLS: 'turn:t.example.com' }), /TURN_SECRET/);
  });
});
