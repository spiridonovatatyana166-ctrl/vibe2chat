import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { CloseIcon } from './icons';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition select-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]',
        size === 'sm' && 'h-9 px-3 text-sm',
        size === 'md' && 'h-11 px-5 text-[15px]',
        size === 'lg' && 'h-14 px-8 text-lg',
        variant === 'primary' && 'accent-gradient text-white shadow-lg shadow-accent/30 hover:brightness-110',
        variant === 'secondary' && 'bg-surface-2 text-fg hover:bg-line',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-fg',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        className,
      )}
      {...rest}
    />
  );
}

/** Круглая кнопка панели управления видеочатом. */
export function RoundButton({
  label,
  active = true,
  tone = 'default',
  badge,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  tone?: 'default' | 'danger' | 'accent';
  badge?: number;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={tone === 'default' ? !active : undefined}
      className={cx(
        'relative grid size-11 shrink-0 place-items-center rounded-full transition sm:size-13',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white active:scale-95',
        'disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'default' && (active ? 'bg-white/12 text-white hover:bg-white/20' : 'bg-white text-neutral-900'),
        tone === 'danger' && 'bg-danger text-white hover:brightness-110',
        tone === 'accent' && 'accent-gradient text-white shadow-lg shadow-accent/40 hover:brightness-110',
        className,
      )}
      {...rest}
    >
      {children}
      {badge ? (
        <span className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white">
          {badge > 9 ? '9+' : badge}
        </span>
      ) : null}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  dismissible = true,
  wide = false,
}: {
  open: boolean;
  onClose?: () => void;
  title: string;
  children: ReactNode;
  dismissible?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, dismissible, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-80 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-sm" onClick={dismissible ? onClose : undefined} />
      <div
        ref={ref}
        className={cx(
          'relative max-h-[92dvh] w-full animate-slide-up overflow-y-auto rounded-t-3xl border border-line bg-surface p-6 shadow-2xl scroll-thin sm:rounded-3xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl font-bold">{title}</h2>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              className="-m-2 rounded-full p-2 text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Закрыть"
            >
              <CloseIcon />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx('inline-block size-5 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
      role="status"
      aria-label="Загрузка"
    />
  );
}

export function Logo({ name, compact = false }: { name: string; compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="accent-gradient grid size-9 place-items-center rounded-xl shadow-lg shadow-accent/30">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="white" aria-hidden="true">
          <path d="M3 8.5A3.5 3.5 0 0 1 6.5 5h7A3.5 3.5 0 0 1 17 8.5v7a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 3 15.5z" />
          <path d="m18 10 3.2-2a.5.5 0 0 1 .8.4v7.2a.5.5 0 0 1-.8.4L18 14z" />
        </svg>
      </span>
      {!compact && <span className="text-lg font-extrabold tracking-tight">{name}</span>}
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-2">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative h-7 w-12 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-surface-2 ring-1 ring-line')}
      >
        <span
          className={cx('absolute top-1 left-1 size-5 rounded-full bg-white shadow transition', checked && 'translate-x-5')}
        />
      </button>
    </label>
  );
}
