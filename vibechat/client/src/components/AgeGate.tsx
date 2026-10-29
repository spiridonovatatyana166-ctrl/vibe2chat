import { useEffect, useRef, useState } from 'react';
import { ApiError, createSession } from '../lib/api';
import { Link } from '../lib/router';
import { ShieldIcon } from './icons';
import { Button, Modal, Spinner } from './ui';

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; 'expired-callback'?: () => void; theme?: string }): string;
      reset(id?: string): void;
    };
  }
}

function useTurnstile(siteKey: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState<string | null>(null);
  const widget = useRef<string | null>(null);

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    const render = () => {
      if (!window.turnstile || !ref.current || widget.current) return;
      widget.current = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        theme: 'auto',
        callback: setToken,
        'expired-callback': () => setToken(null),
      });
    };
    if (window.turnstile) return render();
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, [siteKey]);

  const reset = () => {
    setToken(null);
    if (widget.current) window.turnstile?.reset(widget.current);
  };
  return { ref, token, reset };
}

/**
 * Подтверждение 18+ и согласие с правилами. Это самостоятельное заявление
 * пользователя, а не проверка документов (см. README — как усилить проверку).
 */
export function AgeGate({
  open,
  appName,
  turnstileSiteKey,
  onDone,
}: {
  open: boolean;
  appName: string;
  turnstileSiteKey: string | null;
  onDone: (banned: { until: number | null; reason: string } | null) => void;
}) {
  const [adult, setAdult] = useState(false);
  const [rules, setRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captcha = useTurnstile(open ? turnstileSiteKey : null);
  const needCaptcha = Boolean(turnstileSiteKey);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createSession(captcha.token ?? undefined);
      onDone(res.banned);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти');
      captcha.reset();
    } finally {
      setBusy(false);
    }
  };

  const checkbox = 'mt-0.5 size-5 shrink-0 accent-[#7c5cff]';
  return (
    <Modal open={open} title={`Добро пожаловать в ${appName}`} dismissible={false}>
      <div className="mb-5 flex items-start gap-3 rounded-2xl bg-accent/10 p-4 text-sm">
        <ShieldIcon className="mt-0.5 shrink-0 text-accent" />
        <p>
          Это видеочат со случайными людьми, и он предназначен <b>только для совершеннолетних</b>. Мы не записываем видео,
          звук и переписку.
        </p>
      </div>
      <label className="flex cursor-pointer gap-3 py-2">
        <input type="checkbox" className={checkbox} checked={adult} onChange={(e) => setAdult(e.target.checked)} />
        <span>Мне исполнилось 18 лет</span>
      </label>
      <label className="flex cursor-pointer gap-3 py-2">
        <input type="checkbox" className={checkbox} checked={rules} onChange={(e) => setRules(e.target.checked)} />
        <span>
          Я принимаю{' '}
          <Link href="/rules" className="text-accent underline underline-offset-2">
            правила сообщества
          </Link>{' '}
          и{' '}
          <Link href="/privacy" className="text-accent underline underline-offset-2">
            политику конфиденциальности
          </Link>
        </span>
      </label>
      {needCaptcha && <div ref={captcha.ref} className="mt-3 min-h-16" />}
      {error && <p className="mt-3 rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger">{error}</p>}
      <Button
        variant="primary"
        size="lg"
        className="mt-5 w-full"
        disabled={!adult || !rules || busy || (needCaptcha && !captcha.token)}
        onClick={submit}
      >
        {busy ? <Spinner /> : 'Войти в чат'}
      </Button>
      <p className="mt-3 text-center text-xs text-muted">
        Подтверждение возраста — ваше заявление, а не проверка документов. Нарушители блокируются.
      </p>
    </Modal>
  );
}
