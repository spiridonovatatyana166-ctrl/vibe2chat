import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createGuest, pair, sleep, startTestServer, TestClient, type TestServer } from './helpers.js';

let srv: TestServer;
before(async () => {
  srv = await startTestServer();
});
after(async () => {
  await srv.close();
});

describe('подбор собеседника', () => {
  it('два пользователя находят друг друга в одной комнате с разными ролями', async () => {
    const { a, b, ma, mb } = await pair(srv);
    assert.equal(ma.roomId, mb.roomId);
    assert.deepEqual(new Set([ma.role, mb.role]), new Set(['offerer', 'answerer']));
    a.close();
    b.close();
  });

  it('пользователь не может соединиться сам с собой (вторая вкладка заменяет первую)', async () => {
    const cookie = await createGuest(srv);
    const tab1 = await TestClient.connect(srv, cookie);
    tab1.send({ t: 'queue:join', language: 'any' });
    await tab1.waitFor('queue:waiting');
    const tab2 = await TestClient.connect(srv, cookie);
    await tab1.waitFor('session:replaced');
    assert.equal(await tab1.waitClose(), 4009);
    tab2.send({ t: 'queue:join', language: 'any' });
    await tab2.waitFor('queue:waiting');
    await tab2.expectNo('match', 300);
    tab2.close();
  });

  it('повторный клик «Начать» не создаёт несколько комнат', async () => {
    const a = await TestClient.connect(srv, await createGuest(srv));
    const b = await TestClient.connect(srv, await createGuest(srv));
    const c = await TestClient.connect(srv, await createGuest(srv));
    for (let i = 0; i < 4; i++) a.send({ t: 'queue:join', language: 'any' });
    await sleep(100);
    b.send({ t: 'queue:join', language: 'any' });
    const m = await a.waitFor('match');
    await b.waitFor('match', (x) => x.roomId === m.roomId);
    c.send({ t: 'queue:join', language: 'any' });
    await c.waitFor('queue:waiting');
    await c.expectNo('match');
    await a.expectNo('match', 50);
    // Пока A в комнате, повторный поиск отклоняется.
    a.send({ t: 'queue:join', language: 'any' });
    const err = await a.waitFor('error');
    assert.equal(err.code, 'already-in-room');
    for (const x of [a, b, c]) x.close();
  });

  it('фильтр языка реально влияет на подбор', async () => {
    const ru = await TestClient.connect(srv, await createGuest(srv));
    const en = await TestClient.connect(srv, await createGuest(srv));
    const any = await TestClient.connect(srv, await createGuest(srv));
    ru.send({ t: 'queue:join', language: 'ru' });
    await ru.waitFor('queue:waiting');
    en.send({ t: 'queue:join', language: 'en' });
    await en.waitFor('queue:waiting');
    await ru.expectNo('match', 150);
    any.send({ t: 'queue:join', language: 'any' });
    const m = await any.waitFor('match');
    assert.equal(m.partner.language, 'ru');
    await ru.waitFor('match');
    for (const x of [ru, en, any]) x.close();
  });
});

describe('жизненный цикл комнаты', () => {
  it('при отключении участника второй получает уведомление', async () => {
    const { a, b, roomId } = await pair(srv);
    a.ws.terminate();
    await b.waitFor('room:paused', (m) => m.roomId === roomId);
    const ended = await b.waitFor('room:ended', (m) => m.roomId === roomId, 2000);
    assert.equal(ended.reason, 'partner-disconnected');
    b.close();
  });

  it('после короткого обрыва связи комната восстанавливается', async () => {
    const { a, b, roomId, cookieA, ma } = await pair(srv);
    a.ws.terminate();
    await b.waitFor('room:paused');
    const a2 = await TestClient.connect(srv, cookieA, { resume: roomId });
    const resumed = await a2.waitFor('room:resumed');
    assert.equal(resumed.roomId, roomId);
    assert.equal(resumed.role, ma.role);
    await b.waitFor('room:resumed');
    await sleep(400); // дольше grace — комната не должна закрыться
    await b.expectNo('room:ended', 10);
    a2.send({ t: 'chat:send', roomId, text: 'снова тут', clientMsgId: 'x1' });
    assert.equal((await b.waitFor('chat:msg')).text, 'снова тут');
    a2.close();
    b.close();
  });

  it('«Следующий» завершает сессию и запускает новый поиск', async () => {
    const { a, b, roomId } = await pair(srv);
    const c = await TestClient.connect(srv, await createGuest(srv));
    c.send({ t: 'queue:join', language: 'any' });
    await c.waitFor('queue:waiting');
    a.send({ t: 'room:next', roomId, language: 'any' });
    const ended = await b.waitFor('room:ended');
    assert.equal(ended.reason, 'partner-next');
    const m = await a.waitFor('match');
    assert.notEqual(m.roomId, roomId);
    const mc = await c.waitFor('match');
    assert.equal(mc.roomId, m.roomId);
    for (const x of [a, b, c]) x.close();
  });

  it('после «Следующий» тот же собеседник не попадается сразу снова', async () => {
    const { a, b, roomId } = await pair(srv);
    a.send({ t: 'room:next', roomId, language: 'any' });
    await b.waitFor('room:ended');
    b.send({ t: 'queue:join', language: 'any' });
    await b.waitFor('queue:waiting');
    await a.expectNo('match', 300);
    a.close();
    b.close();
  });
});

describe('текстовый чат', () => {
  it('сообщения доступны только участникам комнаты', async () => {
    const { a, b, roomId } = await pair(srv);
    const outsider = await TestClient.connect(srv, await createGuest(srv));
    a.send({ t: 'chat:send', roomId, text: '  Привет!  ', clientMsgId: 'm1' });
    const mine = await a.waitFor('chat:msg');
    assert.equal(mine.mine, true);
    assert.equal(mine.clientMsgId, 'm1');
    const theirs = await b.waitFor('chat:msg');
    assert.equal(theirs.text, 'Привет!');
    assert.equal(theirs.mine, false);
    await outsider.expectNo('chat:msg', 100);

    outsider.send({ t: 'chat:send', roomId, text: 'влезу', clientMsgId: 'z' });
    assert.equal((await outsider.waitFor('error')).code, 'not-in-room');
    await a.expectNo('chat:msg', 100);
    await b.expectNo('chat:msg', 10);
    for (const x of [a, b, outsider]) x.close();
  });

  it('слишком длинные, пустые и повторяющиеся сообщения отклоняются', async () => {
    const { a, b, roomId } = await pair(srv);
    a.send({ t: 'chat:send', roomId, text: 'я'.repeat(501), clientMsgId: 'long' });
    assert.equal((await a.waitFor('error')).code, 'message-rejected');
    a.send({ t: 'chat:send', roomId, text: '​ \n ', clientMsgId: 'empty' });
    assert.equal((await a.waitFor('error')).code, 'message-rejected');
    for (let i = 0; i < 3; i++) a.send({ t: 'chat:send', roomId, text: 'спам', clientMsgId: `s${i}` });
    assert.equal((await a.waitFor('error')).code, 'message-rejected');
    a.close();
    b.close();
  });

  it('частые сообщения ограничиваются', async () => {
    const { a, b, roomId } = await pair(srv);
    for (let i = 0; i < 12; i++) a.send({ t: 'chat:send', roomId, text: `msg ${i}`, clientMsgId: `r${i}` });
    const err = await a.waitFor('error', (e) => e.code === 'rate-limited');
    assert.equal(err.code, 'rate-limited');
    a.close();
    b.close();
  });
});

describe('безопасность событий', () => {
  it('клиент без сессии не может подключиться', async () => {
    await assert.rejects(TestClient.connect(srv, null), /401/);
    await assert.rejects(TestClient.connect(srv, 'vc_guest=forged.token'), /401/);
  });

  it('подключение с чужого сайта отклоняется', async () => {
    const cookie = await createGuest(srv);
    await assert.rejects(TestClient.connect(srv, cookie, { origin: 'https://evil.example' }), /403/);
  });

  it('неавторизованный клиент не может управлять чужой комнатой', async () => {
    const { a, b, roomId } = await pair(srv);
    const intruder = await TestClient.connect(srv, await createGuest(srv));
    intruder.send({ t: 'room:leave', roomId });
    intruder.send({ t: 'room:next', roomId, language: 'any' });
    intruder.send({ t: 'signal', roomId, data: { kind: 'offer', sdp: 'v=0' } });
    assert.equal((await intruder.waitFor('error', (e) => e.code === 'not-in-room')).code, 'not-in-room');
    await a.expectNo('room:ended', 200);
    await b.expectNo('room:ended', 10);
    await b.expectNo('signal', 10);
    intruder.close();
    a.close();
    b.close();
  });

  it('сигнализация пересылается только собеседнику, ошибки сигнализации обрабатываются', async () => {
    const { a, b, roomId, ma } = await pair(srv);
    const [offerer, answerer] = ma.role === 'offerer' ? [a, b] : [b, a];
    offerer.send({ t: 'signal', roomId, data: { kind: 'offer', sdp: 'v=0 test-offer' } });
    const got = await answerer.waitFor('signal');
    assert.deepEqual(got.data, { kind: 'offer', sdp: 'v=0 test-offer' });
    // answer от offerer'а и offer от answerer'а запрещены.
    offerer.send({ t: 'signal', roomId, data: { kind: 'answer', sdp: 'v=0' } });
    assert.equal((await offerer.waitFor('error')).code, 'bad-request');
    // Некорректный JSON и неизвестный тип события.
    offerer.ws.send('{not json');
    assert.equal((await offerer.waitFor('error')).code, 'bad-request');
    offerer.send({ t: 'signal', roomId, data: { kind: 'ice', candidate: { candidate: 'x'.repeat(5000), sdpMid: '0', sdpMLineIndex: 0 } } });
    assert.equal((await offerer.waitFor('error')).code, 'bad-request');
    await answerer.expectNo('signal', 100);
    a.close();
    b.close();
  });
});

describe('модерация', () => {
  it('заблокированный пользователь больше не попадается тому же человеку', async () => {
    const { a, b, roomId } = await pair(srv);
    a.send({ t: 'block', roomId });
    await a.waitFor('block:ok');
    assert.equal((await b.waitFor('room:ended')).reason, 'partner-left');
    await sleep(50);
    a.send({ t: 'queue:join', language: 'any' });
    b.send({ t: 'queue:join', language: 'any' });
    await a.waitFor('queue:waiting');
    await b.waitFor('queue:waiting');
    await sleep(2300); // дольше интервала повторного подбора
    await a.expectNo('match', 10);
    await b.expectNo('match', 10);
    a.close();
    b.close();
  });

  it('жалоба сохраняется, а после нескольких жалоб нарушитель получает бан', async () => {
    const local = await startTestServer({ AUTO_BAN_REPORT_THRESHOLD: '2' });
    try {
      const badCookie = await createGuest(local);
      let bad = await TestClient.connect(local, badCookie);
      for (let i = 0; i < 2; i++) {
        const reporter = await TestClient.connect(local, await createGuest(local));
        bad.send({ t: 'queue:join', language: 'any' });
        reporter.send({ t: 'queue:join', language: 'any' });
        const m = await reporter.waitFor('match');
        await bad.waitFor('match');
        reporter.send({ t: 'report', roomId: m.roomId, reason: 'harassment', details: 'грубил' });
        await reporter.waitFor('report:ok');
        reporter.close();
        if (i === 0) {
          await bad.waitFor('room:ended');
          continue;
        }
        const banned = await bad.waitFor('banned');
        assert.ok(banned.until && banned.until > Date.now());
        assert.equal(await bad.waitClose(), 4003);
      }
      assert.equal(local.ctx.storage.countReports({}), 2);
      // Повторное подключение забаненного сразу закрывается.
      bad = await TestClient.connect(local, badCookie);
      await bad.waitFor('banned');
    } finally {
      await local.close();
    }
  });
});
