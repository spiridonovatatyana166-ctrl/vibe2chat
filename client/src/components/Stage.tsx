import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { LANGUAGES, type LanguageCode } from '../../../shared/protocol';
import type { CallController, CallState } from '../call/CallController';
import { formatDuration } from '../lib/storage';
import { MEDIA_ERROR_TEXT } from '../media/mediaErrors';
import {
  AlertIcon,
  BlockIcon,
  CamIcon,
  CamOffIcon,
  ChatIcon,
  ExitFullscreenIcon,
  FlagIcon,
  FullscreenIcon,
  GlobeIcon,
  MicIcon,
  MicOffIcon,
  NextIcon,
  PlayIcon,
  StopIcon,
  SwitchCamIcon,
  UserIcon,
} from './icons';
import { Button, cx, RoundButton, Spinner } from './ui';
import { FooterLinks } from './Layout';
import { VideoElement } from './VideoElement';

const languageLabel = (code: LanguageCode | null) => LANGUAGES.find((l) => l.code === code)?.label ?? '';

function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [native, setNative] = useState(false);
  const [pseudo, setPseudo] = useState(false);
  useEffect(() => {
    const on = () => setNative(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [ref]);
  const toggle = async () => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) return void (await document.exitFullscreen().catch(() => undefined));
    if (pseudo) return setPseudo(false);
    if (el.requestFullscreen && document.fullscreenEnabled) {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
        return;
      } catch {
        /* например, iOS Safari — используем псевдо-режим */
      }
    }
    setPseudo(true);
  };
  return { active: native || pseudo, pseudo, toggle };
}

function useTimer(startedAt: number | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt ? formatDuration(Date.now() - startedAt) : null;
}

function StatusPill({ state }: { state: CallState }) {
  const map: Partial<Record<CallState['phase'], { text: string; dot: string }>> = {
    searching: { text: 'Поиск собеседника', dot: 'bg-amber-400 animate-pulse' },
    connecting: { text: 'Подключение', dot: 'bg-sky-400 animate-pulse' },
    connected: { text: 'В сети', dot: 'bg-success' },
    ended: { text: 'Собеседник отключился', dot: 'bg-danger' },
  };
  let item = map[state.phase];
  if (state.phase === 'connected' && (state.partnerPaused || state.connectionUnstable))
    item = { text: state.partnerPaused ? 'Собеседник переподключается' : 'Нестабильная связь', dot: 'bg-amber-400 animate-pulse' };
  if (state.signaling === 'reconnecting' && state.phase !== 'idle')
    item = { text: 'Восстанавливаем связь', dot: 'bg-amber-400 animate-pulse' };
  if (!item) return null;
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-black/45 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-md">
      <span className={cx('size-2 rounded-full', item.dot)} />
      {item.text}
    </span>
  );
}

function Overlay({ children, dim = true }: { children: ReactNode; dim?: boolean }) {
  return (
    <div className={cx('absolute inset-0 z-10 grid place-items-center p-6 text-center', dim && 'bg-stage/85 backdrop-blur-sm')}>
      <div className="w-full max-w-md animate-fade-in">{children}</div>
    </div>
  );
}

function Searching({ language, onCancel }: { language: LanguageCode; onCancel: () => void }) {
  return (
    <Overlay dim={false}>
      <div className="relative mx-auto mb-8 grid size-36 place-items-center">
        {[0, 0.7, 1.4].map((d) => (
          <span
            key={d}
            className="absolute inset-0 animate-pulse-ring rounded-full border-2 border-accent/70"
            style={{ animationDelay: `${d}s` }}
          />
        ))}
        <span className="absolute inset-3 animate-orbit rounded-full border-2 border-transparent border-t-accent-2" />
        <span className="accent-gradient grid size-20 place-items-center rounded-full text-white shadow-2xl shadow-accent/50">
          <UserIcon width={34} height={34} />
        </span>
      </div>
      <p className="text-xl font-bold text-white">Ищем собеседника…</p>
      <p className="mt-2 text-sm text-white/60">
        {language === 'any' ? 'Любой язык' : `Язык: ${languageLabel(language)}`} · обычно это занимает несколько секунд
      </p>
      <Button className="mt-6 bg-white/10 text-white hover:bg-white/20" onClick={onCancel}>
        Отменить поиск
      </Button>
    </Overlay>
  );
}

export function Stage({
  call,
  state,
  appName,
  onOpenChat,
  onReport,
  onBlock,
  chatVisible,
}: {
  call: CallController;
  state: CallState;
  appName: string;
  onOpenChat: () => void;
  onReport: () => void;
  onBlock: () => void;
  chatVisible: boolean;
}) {
  const stageRef = useRef<HTMLElement>(null);
  const fs = useFullscreen(stageRef);
  const timer = useTimer(state.phase === 'connected' ? state.startedAt : null);
  const { phase, local } = state;
  const active = phase === 'searching' || phase === 'connecting' || phase === 'connected' || phase === 'ended';
  const inRoom = phase === 'connecting' || phase === 'connected';
  const canModerate = inRoom || (phase === 'ended' && Boolean(state.lastRoomId));
  const alreadyReported = Boolean(
    (state.roomId ?? state.lastRoomId) && state.reportedRooms.includes((state.roomId ?? state.lastRoomId)!),
  );

  // Esc — следующий собеседник (как в привычных видеочатах), если фокус не в поле ввода.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key !== 'Escape' || tag === 'TEXTAREA' || tag === 'INPUT' || document.fullscreenElement) return;
      if (phase === 'connected' || phase === 'connecting' || phase === 'ended') call.next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, call]);

  return (
    <section
      ref={stageRef}
      className={cx(
        'relative isolate min-h-0 flex-1 overflow-hidden rounded-3xl bg-stage ring-1 ring-line',
        fs.pseudo && 'pseudo-fullscreen',
      )}
      aria-label="Видеочат"
    >
      {/* Видео собеседника */}
      {state.remoteStream && (
        <div className="absolute inset-0">
          <VideoElement stream={state.remoteStream} label="Видео собеседника" />
        </div>
      )}
      {phase === 'connected' && !state.peer.camOn && (
        <Overlay>
          <span className="mx-auto mb-4 grid size-24 place-items-center rounded-full bg-white/10 text-white/80">
            <CamOffIcon width={36} height={36} />
          </span>
          <p className="text-lg font-semibold text-white">Собеседник выключил камеру</p>
        </Overlay>
      )}
      {phase === 'connected' && state.partnerPaused && (
        <Overlay>
          <Spinner className="mx-auto mb-4 size-8 text-white" />
          <p className="text-lg font-semibold text-white">Собеседник переподключается…</p>
        </Overlay>
      )}

      {/* Экран ожидания */}
      {phase === 'idle' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center overflow-y-auto p-6 text-center">
          <div className="pointer-events-none absolute -top-32 left-1/2 size-[520px] -translate-x-1/2 rounded-full bg-accent/25 blur-[120px]" />
          <div className="pointer-events-none absolute -bottom-40 left-1/4 size-[380px] rounded-full bg-accent-2/20 blur-[110px]" />
          <div className="relative max-w-xl animate-slide-up">
            <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-sm text-white/70">
              <span className="size-2 rounded-full bg-success" />
              {state.online !== null ? `Сейчас онлайн: ${state.online.toLocaleString('ru-RU')}` : appName}
            </span>
            <h1 className="text-4xl leading-tight font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl">
              Познакомься <span className="text-gradient block">с кем-то новым</span>
            </h1>
            <p className="mx-auto mt-4 max-w-md text-base text-white/65 sm:text-lg">
              Случайный видеочат один на один в реальном времени. Не понравилось — жми «Следующий».
            </p>
            <div className="mx-auto mt-8 flex max-w-sm flex-col gap-3 sm:flex-row">
              <label className="relative flex-1">
                <GlobeIcon className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-white/60" width={18} height={18} />
                <select
                  aria-label="Язык собеседника"
                  value={state.language}
                  onChange={(e) => call.setLanguage(e.target.value as LanguageCode)}
                  className="h-14 w-full appearance-none rounded-2xl border border-white/10 bg-white/8 pr-4 pl-11 font-medium text-white outline-none focus:border-accent [&>option]:text-neutral-900"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="primary" size="lg" className="sm:min-w-44" onClick={() => void call.start()}>
                <PlayIcon width={18} height={18} /> Начать
              </Button>
            </div>
            <p className="mt-4 text-xs text-white/45">Камера и микрофон включатся только после нажатия «Начать».</p>
            <FooterLinks className="mt-8 justify-center text-white/50 lg:hidden" />
          </div>
        </div>
      )}

      {phase === 'media' && (
        <Overlay>
          <Spinner className="mx-auto mb-4 size-8 text-white" />
          <p className="text-lg font-semibold text-white">Включаем камеру и микрофон…</p>
          <p className="mt-2 text-sm text-white/60">Если браузер спросит разрешение — нажмите «Разрешить».</p>
        </Overlay>
      )}

      {phase === 'searching' && <Searching language={state.language} onCancel={() => call.stop()} />}

      {phase === 'connecting' && !state.remoteStream && (
        <Overlay dim={false}>
          <Spinner className="mx-auto mb-4 size-8 text-white" />
          <p className="text-lg font-semibold text-white">Собеседник найден, подключаемся…</p>
          {state.partnerLanguage && state.partnerLanguage !== 'any' && (
            <p className="mt-2 text-sm text-white/60">Язык собеседника: {languageLabel(state.partnerLanguage)}</p>
          )}
        </Overlay>
      )}

      {phase === 'ended' && (
        <Overlay>
          <p className="text-2xl font-bold text-white">
            {state.endReason === 'you-left' ? 'Разговор завершён' : 'Собеседник отключился'}
          </p>
          {state.autoNextAt ? (
            <>
              <p className="mt-2 text-white/60">Ищем следующего…</p>
              <div className="mx-auto mt-4 h-1 w-48 overflow-hidden rounded-full bg-white/10">
                <div className="accent-gradient h-full origin-left animate-[grow_1.5s_linear_forwards]" />
              </div>
            </>
          ) : (
            <Button variant="primary" size="lg" className="mt-6" onClick={() => call.next()}>
              <NextIcon /> Искать дальше
            </Button>
          )}
        </Overlay>
      )}

      {phase === 'media-error' && state.mediaError && (
        <Overlay>
          <span className="mx-auto mb-4 grid size-16 place-items-center rounded-full bg-danger/15 text-danger">
            <AlertIcon width={30} height={30} />
          </span>
          <p className="text-xl font-bold text-white">{MEDIA_ERROR_TEXT[state.mediaError].title}</p>
          <p className="mt-3 text-sm leading-relaxed text-white/65">{MEDIA_ERROR_TEXT[state.mediaError].hint}</p>
          <Button variant="primary" className="mt-6" onClick={() => void call.start()}>
            Попробовать снова
          </Button>
        </Overlay>
      )}

      {phase === 'banned' && (
        <Overlay>
          <span className="mx-auto mb-4 grid size-16 place-items-center rounded-full bg-danger/15 text-danger">
            <BlockIcon width={30} height={30} />
          </span>
          <p className="text-xl font-bold text-white">Доступ ограничен</p>
          <p className="mt-3 text-sm text-white/65">{state.banned?.reason}</p>
          <p className="mt-2 text-sm text-white/65">
            {state.banned?.until
              ? `До ${new Date(state.banned.until).toLocaleString('ru-RU')}`
              : 'Бессрочно. Если считаете это ошибкой — напишите в поддержку.'}
          </p>
        </Overlay>
      )}

      {phase === 'replaced' && (
        <Overlay>
          <p className="text-xl font-bold text-white">Чат открыт в другой вкладке</p>
          <p className="mt-3 text-sm text-white/65">Одновременно можно общаться только в одном окне.</p>
          <Button variant="primary" className="mt-6" onClick={() => location.reload()}>
            Продолжить здесь
          </Button>
        </Overlay>
      )}

      {/* Верхняя панель: статус, таймер, жалоба */}
      {active && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill state={state} />
            {timer && (
              <span className="rounded-full bg-black/45 px-3 py-1.5 font-mono text-sm text-white tabular-nums backdrop-blur-md">
                {timer}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void fs.toggle()}
              className="grid size-8 place-items-center rounded-full bg-black/45 text-white backdrop-blur-md sm:hidden"
              aria-label={fs.active ? 'Выйти из полноэкранного режима' : 'Полный экран'}
            >
              {fs.active ? <ExitFullscreenIcon width={16} height={16} /> : <FullscreenIcon width={16} height={16} />}
            </button>
          {canModerate && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onReport}
                disabled={alreadyReported}
                className="flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-md hover:bg-danger disabled:opacity-50"
                title="Пожаловаться"
              >
                <FlagIcon width={16} height={16} />
                <span className="hidden sm:inline">{alreadyReported ? 'Жалоба отправлена' : 'Пожаловаться'}</span>
              </button>
              <button
                type="button"
                onClick={onBlock}
                className="flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-md hover:bg-danger"
                title="Заблокировать собеседника"
              >
                <BlockIcon width={16} height={16} />
                <span className="hidden sm:inline">Заблокировать</span>
              </button>
            </div>
          )}
          </div>
        </div>
      )}

      {/* Своя камера */}
      {local.stream && active && (
        <div className="absolute right-3 bottom-24 z-20 aspect-[3/4] w-24 overflow-hidden rounded-2xl bg-neutral-900 shadow-2xl ring-2 ring-white/15 sm:right-4 sm:bottom-28 sm:aspect-video sm:w-44 lg:w-56">
          {local.camOn ? (
            <VideoElement stream={local.stream} muted mirror={local.facing === 'user'} label="Ваша камера" />
          ) : (
            <div className="grid h-full place-items-center text-white/50">
              <CamOffIcon />
            </div>
          )}
          {!local.micOn && (
            <span className="absolute bottom-1.5 left-1.5 rounded-full bg-danger p-1 text-white">
              <MicOffIcon width={12} height={12} />
            </span>
          )}
        </div>
      )}

      {/* Панель управления */}
      {phase !== 'idle' && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/60 to-transparent p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-5">
          <div className="flex max-w-full items-center gap-1.5 overflow-x-auto rounded-full bg-black/40 p-1.5 sm:p-2 backdrop-blur-xl sm:gap-3">
            {active ? (
              <RoundButton label="Завершить" tone="danger" onClick={() => call.stop()}>
                <StopIcon />
              </RoundButton>
            ) : (
              <RoundButton label="Начать" tone="accent" onClick={() => void call.start()} disabled={phase === 'media' || phase === 'banned' || phase === 'replaced'}>
                <PlayIcon />
              </RoundButton>
            )}
            <RoundButton label={local.micOn ? 'Выключить микрофон' : 'Включить микрофон'} active={local.micOn} onClick={() => call.toggleMic()} disabled={!local.stream}>
              {local.micOn ? <MicIcon /> : <MicOffIcon />}
            </RoundButton>
            <RoundButton label={local.camOn ? 'Выключить камеру' : 'Включить камеру'} active={local.camOn} onClick={() => call.toggleCam()} disabled={!local.stream}>
              {local.camOn ? <CamIcon /> : <CamOffIcon />}
            </RoundButton>
            {local.canSwitchCamera && (
              <RoundButton label="Сменить камеру" onClick={() => void call.switchCamera()}>
                <SwitchCamIcon />
              </RoundButton>
            )}
            {!chatVisible && (
              <RoundButton label="Чат" onClick={onOpenChat} badge={state.unread} className="lg:hidden">
                <ChatIcon />
              </RoundButton>
            )}
            <span className="hidden sm:contents">
              <RoundButton label={fs.active ? 'Выйти из полноэкранного режима' : 'Полный экран'} onClick={() => void fs.toggle()}>
                {fs.active ? <ExitFullscreenIcon /> : <FullscreenIcon />}
              </RoundButton>
            </span>
            <button
              type="button"
              onClick={() => call.next()}
              disabled={!(inRoom || phase === 'ended')}
              aria-label="Следующий собеседник"
              className="accent-gradient ml-1 flex h-11 shrink-0 items-center gap-2 rounded-full px-6 font-semibold text-white shadow-lg shadow-accent/40 transition hover:brightness-110 active:scale-95 disabled:opacity-40 sm:h-13 sm:px-7"
              title="Следующий собеседник (Esc)"
            >
              <span className="hidden sm:inline">Следующий</span> <NextIcon width={22} height={22} />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
