import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PublicConfig } from '../../shared/protocol';
import type { CallController } from './call/CallController';
import { createCallController } from './call/createCall';
import { AgeGate } from './components/AgeGate';
import { FooterLinks, Header } from './components/Layout';
import { BlockIcon } from './components/icons';
import { Button, Spinner } from './components/ui';
import { DEFAULT_APP_NAME } from './config';
import { getConfig, getSession } from './lib/api';
import { usePath } from './lib/router';
import { AdminPage } from './pages/AdminPage';
import { CheckPage } from './pages/CheckPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage, PrivacyPage, RulesPage, SupportPage } from './pages/InfoPages';

type Auth = { status: 'loading' } | { status: 'guest' } | { status: 'ready' } | { status: 'banned'; until: number | null; reason: string } | { status: 'offline' };

function CenteredMessage({ appName, children }: { appName: string; children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      <Header appName={appName} online={null} />
      <main className="grid flex-1 place-items-center p-6 text-center">{children}</main>
    </div>
  );
}

function Landing({ appName }: { appName: string }) {
  return (
    <div className="flex h-dvh flex-col">
      <Header appName={appName} online={null} />
      <main className="relative grid flex-1 place-items-center overflow-hidden px-6 text-center">
        <div className="pointer-events-none absolute -top-40 left-1/2 size-[560px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />
        <div className="relative">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">
            Познакомься <span className="text-gradient">с кем-то новым</span>
          </h1>
          <p className="mx-auto mt-4 max-w-md text-muted">Случайный видеочат один на один в реальном времени.</p>
        </div>
      </main>
      <FooterLinks className="justify-center pb-6" />
    </div>
  );
}

export function App() {
  const path = usePath();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [auth, setAuth] = useState<Auth>({ status: 'loading' });
  const [call, setCall] = useState<CallController | null>(null);
  const appName = config?.appName ?? DEFAULT_APP_NAME;

  const loadSession = useCallback(async () => {
    try {
      const [cfg, session] = await Promise.all([getConfig(), getSession()]);
      setConfig(cfg);
      if (session.banned) setAuth({ status: 'banned', ...session.banned });
      else setAuth({ status: session.authenticated ? 'ready' : 'guest' });
    } catch {
      setAuth({ status: 'offline' });
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    document.title = `${appName} — видеочат со случайными людьми`;
  }, [appName]);

  // Контроллер живёт на уровне приложения: переход на страницу правил не обрывает разговор.
  useEffect(() => {
    if (auth.status !== 'ready') return;
    const controller = createCallController(() => setAuth({ status: 'guest' }));
    setCall(controller);
    return () => {
      controller.dispose();
      setCall(null);
    };
  }, [auth.status]);

  switch (path) {
    case '/rules':
      return <RulesPage appName={appName} />;
    case '/privacy':
      return <PrivacyPage appName={appName} />;
    case '/support':
      return <SupportPage appName={appName} supportEmail={config?.supportEmail ?? null} />;
    case '/admin':
      return <AdminPage appName={appName} />;
    case '/check':
      return <CheckPage appName={appName} />;
    case '/':
      break;
    default:
      return <NotFoundPage appName={appName} />;
  }

  if (auth.status === 'loading')
    return (
      <CenteredMessage appName={appName}>
        <Spinner className="size-8 text-accent" />
      </CenteredMessage>
    );

  if (auth.status === 'offline')
    return (
      <CenteredMessage appName={appName}>
        <div>
          <p className="text-xl font-bold">Сервер недоступен</p>
          <p className="mt-2 text-muted">Проверьте подключение к интернету и попробуйте снова.</p>
          <Button variant="primary" className="mt-6" onClick={() => void loadSession()}>
            Повторить
          </Button>
        </div>
      </CenteredMessage>
    );

  if (auth.status === 'banned')
    return (
      <CenteredMessage appName={appName}>
        <div className="max-w-md">
          <span className="mx-auto mb-4 grid size-16 place-items-center rounded-full bg-danger/15 text-danger">
            <BlockIcon width={30} height={30} />
          </span>
          <p className="text-xl font-bold">Доступ ограничен</p>
          <p className="mt-3 text-muted">{auth.reason}</p>
          <p className="mt-2 text-muted">
            {auth.until ? `До ${new Date(auth.until).toLocaleString('ru-RU')}` : 'Бессрочно'}
          </p>
          <FooterLinks className="mt-8 justify-center" />
        </div>
      </CenteredMessage>
    );

  if (auth.status === 'guest' || !call)
    return (
      <>
        <Landing appName={appName} />
        <AgeGate
          open={auth.status === 'guest'}
          appName={appName}
          turnstileSiteKey={config?.turnstileSiteKey ?? null}
          onDone={(banned) => setAuth(banned ? { status: 'banned', ...banned } : { status: 'ready' })}
        />
      </>
    );

  return <HomePage call={call} appName={appName} />;
}
