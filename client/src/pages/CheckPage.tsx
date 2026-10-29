import { useCallback, useRef, useState } from 'react';
import type { IceConfig, ServerMessage } from '../../../shared/protocol';
import { DocPage } from '../components/Layout';
import { Button, cx, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';

type Status = 'pending' | 'running' | 'ok' | 'warn' | 'fail';
interface Step {
  id: string;
  title: string;
  status: Status;
  detail: string;
}

const STEPS: Omit<Step, 'status' | 'detail'>[] = [
  { id: 'server', title: 'Сервер отвечает' },
  { id: 'session', title: 'Вход выполнен' },
  { id: 'ws', title: 'Канал связи с сервером (WebSocket)' },
  { id: 'big', title: 'Передача больших сообщений' },
  { id: 'ice', title: 'Настройки соединения (STUN/TURN)' },
  { id: 'stun', title: 'Прямое соединение (STUN)' },
  { id: 'turn', title: 'Ретранслятор (TURN)' },
  { id: 'relay', title: 'Пробный звонок через ретранслятор' },
];

const ICON: Record<Status, string> = { pending: '•', running: '', ok: '✓', warn: '!', fail: '✕' };
const COLOR: Record<Status, string> = {
  pending: 'bg-surface-2 text-muted',
  running: 'bg-surface-2 text-fg',
  ok: 'bg-success/15 text-success',
  warn: 'bg-amber-500/15 text-amber-500',
  fail: 'bg-danger/15 text-danger',
};

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`нет ответа за ${ms / 1000} с (${what})`)), ms))]);

/** Собирает ICE-кандидаты и возвращает их типы. */
async function gather(config: RTCConfiguration, ms = 8000): Promise<{ types: string[]; errors: string[] }> {
  const pc = new RTCPeerConnection(config);
  const types: string[] = [];
  const errors: string[] = [];
  pc.createDataChannel('check');
  pc.onicecandidate = (e) => {
    const m = e.candidate?.candidate.match(/ typ (\w+)/);
    if (m?.[1]) types.push(m[1]);
  };
  pc.onicecandidateerror = (e) => {
    const ev = e as RTCPeerConnectionIceErrorEvent;
    errors.push(`${ev.url ?? ''} ${ev.errorCode} ${ev.errorText}`.trim());
  };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    };
  });
  pc.close();
  return { types, errors };
}

/** Два соединения внутри страницы, только через TURN: проверяет, что ретранслятор реально передаёт данные. */
async function relayLoopback(ice: IceConfig, ms = 15000): Promise<number> {
  const config: RTCConfiguration = { iceServers: ice.iceServers, iceTransportPolicy: 'relay' };
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate).catch(() => undefined);
  b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate).catch(() => undefined);
  const started = performance.now();
  const channel = a.createDataChannel('check');
  const received = new Promise<number>((resolve) => {
    b.ondatachannel = (e) => {
      e.channel.onmessage = () => resolve(Math.round(performance.now() - started));
    };
  });
  channel.onopen = () => channel.send('ping');
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  try {
    return await withTimeout(received, ms, 'ретранслятор');
  } finally {
    a.close();
    b.close();
  }
}

export function CheckPage({ appName }: { appName: string }) {
  const [steps, setSteps] = useState<Step[]>(() => STEPS.map((s) => ({ ...s, status: 'pending', detail: '' })));
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const stepsRef = useRef(steps);

  const update = (id: string, status: Status, detail = '') => {
    stepsRef.current = stepsRef.current.map((s) => (s.id === id ? { ...s, status, detail } : s));
    setSteps(stepsRef.current);
  };

  const run = useCallback(async () => {
    setRunning(true);
    setCopied(false);
    stepsRef.current = STEPS.map((s) => ({ ...s, status: 'pending', detail: '' }));
    setSteps(stepsRef.current);
    let ws: WebSocket | null = null;
    try {
      update('server', 'running');
      const t0 = performance.now();
      await withTimeout(api('/api/config'), 70_000, 'сервер');
      update('server', 'ok', `${Math.round(performance.now() - t0)} мс`);

      update('session', 'running');
      const session = await api<{ authenticated: boolean }>('/api/session');
      if (!session.authenticated) {
        update('session', 'fail', 'Сначала откройте главную страницу и подтвердите возраст');
        return;
      }
      update('session', 'ok');

      update('ws', 'running');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      const socket = ws;
      const waiters = new Map<string, (m: ServerMessage) => void>();
      socket.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        const key = msg.t === 'diag:echo' ? `echo:${msg.id}` : msg.t;
        waiters.get(key)?.(msg);
      };
      const waitFor = (key: string, ms: number) =>
        withTimeout(new Promise<ServerMessage>((resolve) => waiters.set(key, resolve)), ms, key);
      const t1 = performance.now();
      const hello = waitFor('hello', 15_000);
      socket.onerror = () => update('ws', 'fail', 'Подключение отклонено или оборвано');
      await hello;
      update('ws', 'ok', `${Math.round(performance.now() - t1)} мс`);

      update('big', 'running');
      const sizes = [1_000, 12_000, 36_000];
      const timings: string[] = [];
      for (const size of sizes) {
        const id = `s${size}`;
        const t = performance.now();
        const reply = waitFor(`echo:${id}`, 15_000);
        socket.send(JSON.stringify({ t: 'diag:echo', id, payload: 'x'.repeat(size) }));
        const msg = await reply;
        if (msg.t !== 'diag:echo' || msg.payload.length !== size) throw new Error('данные искажены');
        timings.push(`${Math.round(size / 1000)} КБ — ${Math.round(performance.now() - t)} мс`);
      }
      update('big', 'ok', timings.join(', '));

      update('ice', 'running');
      const ice = await api<IceConfig>('/api/ice');
      const stunUrls = ice.iceServers.filter((s) => !s.username).flatMap((s) => s.urls);
      const turnServers = ice.iceServers.filter((s) => s.username);
      update(
        'ice',
        turnServers.length ? 'ok' : 'warn',
        `STUN: ${stunUrls.length}, TURN: ${turnServers.flatMap((s) => s.urls).length}${turnServers.length ? '' : ' — ретранслятор не настроен'}`,
      );

      update('stun', 'running');
      const stun = await gather({ iceServers: stunUrls.length ? [{ urls: stunUrls }] : [] });
      const srflx = stun.types.filter((t) => t === 'srflx').length;
      update(
        'stun',
        srflx ? 'ok' : 'warn',
        srflx
          ? `публичный адрес определён (${srflx})`
          : 'STUN недоступен — прямое соединение возможно только внутри одной сети',
      );

      update('turn', 'running');
      if (!turnServers.length) {
        update('turn', 'fail', 'Ретранслятор не настроен на сервере');
        update('relay', 'fail', 'Пропущено');
        return;
      }
      const turn = await gather({ iceServers: turnServers, iceTransportPolicy: 'relay' }, 10_000);
      const relays = turn.types.filter((t) => t === 'relay').length;
      update(
        'turn',
        relays ? 'ok' : 'fail',
        relays ? `ретранслятор выдал адрес (${relays})` : `ретранслятор недоступен${turn.errors[0] ? `: ${turn.errors[0]}` : ''}`,
      );
      if (!relays) {
        update('relay', 'fail', 'Пропущено');
        return;
      }

      update('relay', 'running');
      const ms = await relayLoopback(ice);
      update('relay', 'ok', `данные прошли через ретранслятор за ${ms} мс`);
    } catch (err) {
      const current = stepsRef.current.find((s) => s.status === 'running');
      const text = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'ошибка';
      if (current) update(current.id, 'fail', text);
    } finally {
      ws?.close();
      for (const s of stepsRef.current) if (s.status === 'pending' || s.status === 'running') update(s.id, 'pending', 'Не проверено');
      setRunning(false);
    }
  }, []);

  const report = () =>
    [
      `${appName} — проверка связи, ${new Date().toLocaleString('ru-RU')}`,
      navigator.userAgent,
      ...steps.map((s) => `${ICON[s.status] || '…'} ${s.title}: ${s.detail || s.status}`),
    ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const done = !running && steps.some((s) => s.status !== 'pending');
  const failed = steps.filter((s) => s.status === 'fail');

  return (
    <DocPage appName={appName} title="Проверка связи">
      <p>
        Проверка покажет, на каком этапе не получается соединиться с собеседником. Займёт до минуты. Камера не нужна.
      </p>
      <Button variant="primary" size="lg" onClick={() => void run()} disabled={running}>
        {running ? <Spinner /> : done ? 'Проверить ещё раз' : 'Начать проверку'}
      </Button>
      <ul className="!ml-0 !space-y-2">
        {steps.map((s) => (
          <li key={s.id} className="!ml-0 flex !list-none items-start gap-3 rounded-2xl border border-line bg-surface p-3.5 !pl-3.5">
            <span className={cx('grid size-7 shrink-0 place-items-center rounded-full text-sm font-bold', COLOR[s.status])}>
              {s.status === 'running' ? <Spinner className="size-4" /> : ICON[s.status]}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{s.title}</span>
              {s.detail && <span className="block text-sm break-words text-muted">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      {done && (
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="font-semibold">
            {failed.length === 0 ? 'Всё в порядке: соединение должно работать.' : `Проблемы: ${failed.map((f) => f.title).join(', ')}.`}
          </p>
          <Button className="mt-3" onClick={() => void copy()}>
            {copied ? 'Отчёт скопирован' : 'Скопировать отчёт'}
          </Button>
        </div>
      )}
    </DocPage>
  );
}
