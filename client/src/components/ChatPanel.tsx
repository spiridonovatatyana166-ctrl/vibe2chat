import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { LIMITS } from '../../../shared/protocol';
import type { CallController, CallState } from '../call/CallController';
import { formatTime } from '../lib/storage';
import { ChatIcon, CloseIcon, SendIcon } from './icons';
import { cx } from './ui';

export function ChatPanel({
  call,
  state,
  onClose,
  className,
}: {
  call: CallController;
  state: CallState;
  onClose?: () => void;
  className?: string;
}) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canChat = state.phase === 'connected';
  const length = [...text].length;
  const tooLong = length > LIMITS.chatMaxLength;

  // Автопрокрутка к последнему сообщению.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [state.messages.length]);

  // При переходе к новому собеседнику очищаем неотправленный текст.
  useEffect(() => setText(''), [state.roomId]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canChat || tooLong || !text.trim()) return;
    if (call.sendChat(text)) setText('');
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={cx('flex min-h-0 flex-col overflow-hidden rounded-3xl border border-line bg-surface', className)}>
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2 font-semibold">
          <ChatIcon width={18} height={18} className="text-accent" />
          Чат
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="-mr-2 rounded-full p-2 text-muted hover:bg-surface-2" aria-label="Скрыть чат">
            <CloseIcon width={20} height={20} />
          </button>
        )}
      </div>

      <div ref={listRef} className="scroll-thin flex-1 space-y-2 overflow-y-auto px-4 py-4" aria-live="polite">
        {state.messages.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted">
            {canChat
              ? 'Сообщений пока нет. Напишите «Привет» 👋'
              : state.phase === 'connecting'
                ? 'Подключаемся к собеседнику…'
                : 'Здесь появится переписка, когда найдётся собеседник'}
          </div>
        ) : (
          state.messages.map((m) => (
            <div key={m.id} className={cx('flex animate-fade-in', m.mine ? 'justify-end' : 'justify-start')}>
              <div
                className={cx(
                  'max-w-[82%] rounded-2xl px-3.5 py-2 text-[15px] leading-snug break-words whitespace-pre-wrap',
                  m.mine ? 'accent-gradient rounded-br-md text-white' : 'rounded-bl-md bg-surface-2 text-fg',
                  m.status === 'pending' && 'opacity-70',
                  m.status === 'failed' && 'bg-none bg-danger/20 text-danger ring-1 ring-danger/50',
                )}
              >
                {m.text}
                <div className={cx('mt-0.5 text-right text-[11px]', m.mine ? 'text-white/70' : 'text-muted')}>
                  {m.status === 'failed' ? 'не отправлено' : formatTime(m.ts)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={submit} className="border-t border-line p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!canChat}
            rows={1}
            maxLength={LIMITS.chatMaxLength * 2}
            placeholder={canChat ? 'Сообщение…' : 'Чат недоступен'}
            aria-label="Текст сообщения"
            className="scroll-thin max-h-28 min-h-11 flex-1 resize-none rounded-2xl border border-line bg-surface-2 px-4 py-2.5 text-[15px] outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!canChat || !text.trim() || tooLong}
            className="accent-gradient grid size-11 shrink-0 place-items-center rounded-2xl text-white transition disabled:opacity-40"
            aria-label="Отправить"
          >
            <SendIcon width={18} height={18} />
          </button>
        </div>
        {length > LIMITS.chatMaxLength - 100 && (
          <div className={cx('mt-1 px-1 text-right text-xs', tooLong ? 'text-danger' : 'text-muted')}>
            {length}/{LIMITS.chatMaxLength}
          </div>
        )}
      </form>
    </div>
  );
}
