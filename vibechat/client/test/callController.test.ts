import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClientMessage, IceConfig, Role, ServerMessage, SignalData } from '../../shared/protocol';
import { CallController, type CallDeps, type MediaLike, type PeerLike } from '../src/call/CallController';
import { MediaAccessError, MediaManager, type LocalMediaState } from '../src/media/MediaManager';
import { classifyMediaError } from '../src/media/mediaErrors';
import type { PeerCallbacks, PeerState } from '../src/rtc/PeerSession';
import type { SignalingEvents } from '../src/signaling/SignalingClient';

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeSignaling {
  sent: ClientMessage[] = [];
  open = true;
  resumeRoomId: string | null = null;
  constructor(readonly events: SignalingEvents) {}
  connect() {
    this.events.onStatus('open');
  }
  disconnect() {}
  send(msg: ClientMessage) {
    if (!this.open) return false;
    this.sent.push(msg);
    return true;
  }
  isOpen() {
    return this.open;
  }
  receive(msg: ServerMessage) {
    this.events.onMessage(msg);
  }
  last<T extends ClientMessage['t']>(t: T) {
    return [...this.sent].reverse().find((m) => m.t === t) as Extract<ClientMessage, { t: T }> | undefined;
  }
}

class FakePeer implements PeerLike {
  state: PeerState = 'connecting';
  started = false;
  closed = false;
  handled: SignalData[] = [];
  constructor(
    readonly role: Role,
    readonly cb: PeerCallbacks,
  ) {
    // Как и настоящий PeerSession, сообщает состояние прямо из конструктора.
    cb.onState('connecting');
  }
  async start() {
    this.started = true;
    this.cb.sendSignal({ kind: 'offer', sdp: 'v=0 fake' });
  }
  async handleSignal(d: SignalData) {
    this.handled.push(d);
  }
  async restartIce() {}
  async replaceTrack() {}
  close() {
    this.closed = true;
  }
  connect() {
    this.state = 'connected';
    this.cb.onState('connected');
  }
}

const fakeStream = { getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;

function fakeMedia(fail?: MediaAccessError): MediaLike & { released: number } {
  const off: LocalMediaState = {
    stream: null,
    hasCamera: false,
    hasMic: false,
    camOn: false,
    micOn: false,
    canSwitchCamera: false,
    facing: 'user',
    warning: null,
  };
  return {
    released: 0,
    state: off,
    async acquire() {
      if (fail) throw fail;
      this.state = { ...off, stream: fakeStream, hasCamera: true, hasMic: true, camOn: true, micOn: true };
      return this.state;
    },
    setMic(on) {
      this.state = { ...this.state, micOn: on };
    },
    setCam(on) {
      this.state = { ...this.state, camOn: on };
    },
    async replaceVideo() {
      return null;
    },
    async replaceAudio() {
      return null;
    },
    release() {
      this.released++;
      this.state = { ...off };
    },
  };
}

function setup(opts: { media?: MediaLike; iceFails?: boolean } = {}) {
  let signaling!: FakeSignaling;
  const peers: FakePeer[] = [];
  const prefs = new Map<string, unknown>();
  const media = opts.media ?? fakeMedia();
  const deps: CallDeps = {
    createSignaling: (events) => (signaling = new FakeSignaling(events)),
    createPeer: (_ice: IceConfig, role, _stream, cb) => {
      const p = new FakePeer(role, cb);
      peers.push(p);
      return p;
    },
    media,
    getIce: async () => {
      if (opts.iceFails) throw new Error('ice');
      return { iceServers: [], iceTransportPolicy: 'all', ttlSeconds: 60 };
    },
    loadPref: <T,>(k: string, f: T) => (prefs.has(k) ? (prefs.get(k) as T) : f),
    savePref: (k, v) => void prefs.set(k, v),
    onUnauthorized: () => {},
  };
  const call = new CallController(deps);
  return { call, signaling, peers, media };
}

async function startAndMatch(role: Role = 'offerer') {
  const ctx = setup();
  await ctx.call.start();
  ctx.signaling.receive({ t: 'match', roomId: 'room-00001', role, partner: { language: 'ru' } });
  await tick();
  await tick();
  return ctx;
}

describe('CallController', () => {
  it('камера и микрофон запрашиваются только после нажатия «Начать»', async () => {
    const { call, signaling, media } = setup();
    assert.equal(media.state.stream, null);
    assert.equal(call.getState().phase, 'idle');
    await call.start();
    assert.ok(media.state.stream);
    assert.equal(call.getState().phase, 'searching');
    assert.equal(signaling.last('queue:join')?.language, 'any');
  });

  it('обрабатывает запрет доступа к камере', async () => {
    const { call, signaling } = setup({ media: fakeMedia(new MediaAccessError('denied')) });
    await call.start();
    assert.equal(call.getState().phase, 'media-error');
    assert.equal(call.getState().mediaError, 'denied');
    assert.equal(signaling.last('queue:join'), undefined, 'без камеры поиск не начинается');
  });

  it('после совпадения создаёт WebRTC-сессию и переходит в «В сети»', async () => {
    const { call, peers, signaling } = await startAndMatch('offerer');
    assert.equal(call.getState().phase, 'connecting');
    assert.equal(peers.length, 1);
    assert.ok(peers[0]!.started);
    assert.equal(signaling.last('signal')?.data.kind, 'offer');
    peers[0]!.connect();
    assert.equal(call.getState().phase, 'connected');
    assert.ok(call.getState().startedAt);
  });

  it('сигналы, пришедшие до создания соединения, не теряются', async () => {
    const { call, signaling, peers } = setup();
    await call.start();
    signaling.receive({ t: 'match', roomId: 'room-00002', role: 'answerer', partner: { language: 'any' } });
    signaling.receive({ t: 'signal', roomId: 'room-00002', data: { kind: 'offer', sdp: 'early' } });
    await tick();
    await tick();
    assert.deepEqual(peers[0]!.handled, [{ kind: 'offer', sdp: 'early' }]);
  });

  it('ошибка сигнализации (нет ICE-конфигурации) — ищем другого собеседника', async () => {
    const ctx = setup({ iceFails: true });
    await ctx.call.start();
    ctx.signaling.receive({ t: 'match', roomId: 'room-00003', role: 'offerer', partner: { language: 'any' } });
    await tick();
    await tick();
    assert.equal(ctx.signaling.last('room:failed')?.roomId, 'room-00003');
    assert.equal(ctx.call.getState().phase, 'searching');
  });

  it('ошибка сервера показывается пользователю и помечает сообщение неотправленным', async () => {
    const { call, signaling, peers } = await startAndMatch();
    peers[0]!.connect();
    call.sendChat('привет');
    const id = signaling.last('chat:send')!.clientMsgId;
    signaling.receive({ t: 'error', code: 'rate-limited', message: 'Слишком часто', ref: id });
    assert.equal(call.getState().messages[0]!.status, 'failed');
    assert.equal(call.getState().notices.at(-1)?.text, 'Слишком часто');
  });

  it('«Следующий» закрывает соединение, очищает чат и ищет нового', async () => {
    const { call, peers, signaling } = await startAndMatch();
    peers[0]!.connect();
    signaling.receive({ t: 'chat:msg', roomId: 'room-00001', id: 'a', mine: false, text: 'hi', ts: 1 });
    assert.equal(call.getState().messages.length, 1);
    call.next();
    assert.ok(peers[0]!.closed);
    assert.equal(call.getState().phase, 'searching');
    assert.equal(call.getState().messages.length, 0);
    assert.equal(signaling.last('room:next')?.roomId, 'room-00001');
  });

  it('уход собеседника: показываем статус и автоматически ищем дальше', async () => {
    const { call, peers, signaling } = await startAndMatch();
    peers[0]!.connect();
    signaling.receive({ t: 'room:ended', roomId: 'room-00001', reason: 'partner-next' });
    assert.equal(call.getState().phase, 'ended');
    assert.ok(peers[0]!.closed);
    const joins = signaling.sent.filter((m) => m.t === 'queue:join').length;
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(call.getState().phase, 'searching');
    assert.equal(signaling.sent.filter((m) => m.t === 'queue:join').length, joins + 1);
  });

  it('«Завершить» освобождает камеру и микрофон', async () => {
    const { call, peers, signaling, media } = await startAndMatch();
    peers[0]!.connect();
    call.stop();
    assert.equal(call.getState().phase, 'idle');
    assert.equal((media as ReturnType<typeof fakeMedia>).released, 1);
    assert.equal(signaling.last('room:leave')?.roomId, 'room-00001');
  });

  it('бан отключает видеочат', async () => {
    const { call, signaling } = await startAndMatch();
    signaling.receive({ t: 'banned', until: null, reason: 'тест' });
    assert.equal(call.getState().phase, 'banned');
  });

  it('жалоба на ушедшего собеседника отправляется по последней комнате', async () => {
    const { call, peers, signaling } = await startAndMatch();
    peers[0]!.connect();
    call.holdAutoNext(true);
    signaling.receive({ t: 'room:ended', roomId: 'room-00001', reason: 'partner-left' });
    assert.ok(call.report('harassment', 'текст'));
    assert.equal(signaling.last('report')?.roomId, 'room-00001');
  });
});

describe('MediaManager', () => {
  const track = (kind: string) => ({ kind, enabled: true, stop() {}, getSettings: () => ({}) });
  const stream = (kinds: string[]) => {
    const tracks = kinds.map(track);
    return {
      getTracks: () => tracks,
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    } as unknown as MediaStream;
  };
  const err = (name: string) => Object.assign(new Error(name), { name });

  it('без поддержки браузера на http сообщает о необходимости HTTPS', async () => {
    await assert.rejects(new MediaManager(undefined, false).acquire(), (e: MediaAccessError) => e.kind === 'insecure');
  });

  it('запрет доступа — ошибка denied', async () => {
    const mm = new MediaManager({ getUserMedia: async () => Promise.reject(err('NotAllowedError')), enumerateDevices: async () => [] }, true);
    await assert.rejects(mm.acquire(), (e: MediaAccessError) => e.kind === 'denied');
  });

  it('если камеры нет — продолжает только со звуком', async () => {
    const mm = new MediaManager(
      {
        getUserMedia: async (c) => (c.video ? Promise.reject(err('NotFoundError')) : stream(['audio'])),
        enumerateDevices: async () => [],
      },
      true,
    );
    const s = await mm.acquire();
    assert.equal(s.hasCamera, false);
    assert.equal(s.hasMic, true);
    assert.ok(s.warning);
  });

  it('classifyMediaError различает типы ошибок', () => {
    assert.equal(classifyMediaError(err('NotReadableError')), 'busy');
    assert.equal(classifyMediaError(err('OverconstrainedError')), 'not-found');
    assert.equal(classifyMediaError(null), 'unknown');
  });
});
