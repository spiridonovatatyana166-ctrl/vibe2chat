import { useEffect, useRef, useState } from 'react';
import { cx } from './ui';

/**
 * <video> с привязкой MediaStream. Если браузер заблокировал автозапуск
 * со звуком — показываем кнопку, чтобы включить звук одним касанием.
 */
export function VideoElement({
  stream,
  muted = false,
  mirror = false,
  className,
  label,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (!stream) return;
    const play = () =>
      el.play().then(
        () => setBlocked(false),
        (err: unknown) => {
          if ((err as { name?: string }).name === 'NotAllowedError') setBlocked(true);
        },
      );
    void play();
    // Дорожки собеседника приходят по одной — перезапускаем воспроизведение при добавлении.
    stream.addEventListener('addtrack', play);
    return () => stream.removeEventListener('addtrack', play);
  }, [stream]);

  return (
    <>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        aria-label={label}
        className={cx('h-full w-full object-cover', mirror && 'mirror', className)}
      />
      {blocked && (
        <button
          type="button"
          onClick={() => void ref.current?.play().then(() => setBlocked(false))}
          className="absolute inset-x-0 top-1/2 mx-auto w-max -translate-y-1/2 rounded-full bg-white px-5 py-3 font-semibold text-neutral-900 shadow-xl"
        >
          Нажмите, чтобы включить звук
        </button>
      )}
    </>
  );
}
