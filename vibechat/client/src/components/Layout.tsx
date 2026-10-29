import type { ReactNode } from 'react';
import type { Notice } from '../call/CallController';
import { Link } from '../lib/router';
import { useTheme } from '../lib/theme';
import { CloseIcon, MoonIcon, SettingsIcon, SunIcon } from './icons';
import { cx, Logo } from './ui';

export function Header({
  appName,
  online,
  reconnecting,
  onSettings,
}: {
  appName: string;
  online: number | null;
  reconnecting?: boolean;
  onSettings?: () => void;
}) {
  const [theme, toggleTheme] = useTheme();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 sm:h-16 lg:px-6">
      <Link href="/" aria-label={`${appName} — на главную`}>
        <Logo name={appName} />
      </Link>
      <div className="flex items-center gap-1.5 sm:gap-2">
        {reconnecting ? (
          <span className="rounded-full bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-500 sm:text-sm">
            Переподключение…
          </span>
        ) : online !== null ? (
          <span className="flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-xs font-medium ring-1 ring-line sm:text-sm">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
            {online.toLocaleString('ru-RU')} онлайн
          </span>
        ) : null}
        <button
          type="button"
          onClick={toggleTheme}
          className="rounded-full p-2.5 text-muted transition hover:bg-surface-2 hover:text-fg"
          aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        >
          {theme === 'dark' ? <SunIcon width={20} height={20} /> : <MoonIcon width={20} height={20} />}
        </button>
        {onSettings && (
          <button
            type="button"
            onClick={onSettings}
            className="rounded-full p-2.5 text-muted transition hover:bg-surface-2 hover:text-fg"
            aria-label="Настройки"
          >
            <SettingsIcon width={20} height={20} />
          </button>
        )}
      </div>
    </header>
  );
}

export function FooterLinks({ className }: { className?: string }) {
  const link = 'hover:text-fg transition';
  return (
    <nav className={cx('flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted', className)} aria-label="Информация">
      <Link href="/rules" className={link}>
        Правила
      </Link>
      <Link href="/privacy" className={link}>
        Конфиденциальность
      </Link>
      <Link href="/support" className={link}>
        Поддержка
      </Link>
      <span className="text-muted/70">18+</span>
    </nav>
  );
}

export function Toasts({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-90 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {notices.map((n) => (
        <div
          key={n.id}
          className={cx(
            'pointer-events-auto flex max-w-md animate-slide-up items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium shadow-xl ring-1 backdrop-blur-xl',
            n.kind === 'error' && 'bg-danger/90 text-white ring-white/10',
            n.kind === 'success' && 'bg-success/90 text-neutral-950 ring-black/5',
            n.kind === 'info' && 'bg-surface/95 text-fg ring-line',
          )}
          role={n.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="flex-1">{n.text}</span>
          <button type="button" onClick={() => onDismiss(n.id)} aria-label="Закрыть уведомление" className="opacity-70 hover:opacity-100">
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Каркас текстовых страниц (правила, конфиденциальность, поддержка). */
export function DocPage({ appName, title, children }: { appName: string; title: string; children: ReactNode }) {
  return (
    <div className="min-h-full">
      <Header appName={appName} online={null} />
      <main className="mx-auto max-w-3xl px-5 pt-6 pb-16 sm:pt-10">
        <Link href="/" className="text-sm text-accent hover:underline">
          ← Вернуться в чат
        </Link>
        <h1 className="mt-4 mb-8 text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h1>
        <div className="space-y-5 leading-relaxed text-fg/90 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-bold [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_ul]:space-y-2">
          {children}
        </div>
        <FooterLinks className="mt-16 border-t border-line pt-6" />
      </main>
    </div>
  );
}
