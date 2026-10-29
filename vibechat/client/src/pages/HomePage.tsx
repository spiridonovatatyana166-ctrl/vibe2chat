import { useEffect, useState } from 'react';
import type { CallController } from '../call/CallController';
import { useCallState } from '../call/createCall';
import { ChatPanel } from '../components/ChatPanel';
import { BlockDialog, ReportDialog, SettingsDialog } from '../components/Dialogs';
import { FooterLinks, Header, Toasts } from '../components/Layout';
import { Stage } from '../components/Stage';
import { cx } from '../components/ui';

function useIsDesktop(): boolean {
  const query = '(min-width: 1024px)';
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return match;
}

export function HomePage({ call, appName }: { call: CallController; appName: string }) {
  const state = useCallState(call);
  const desktop = useIsDesktop();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialog, setDialog] = useState<'report' | 'block' | 'settings' | null>(null);

  const chatVisible = desktop || sheetOpen;
  useEffect(() => call.setChatOpen(chatVisible), [chatVisible, call]);

  // Новый собеседник — закрываем мобильный чат, чтобы видео было на весь экран.
  useEffect(() => {
    if (!state.roomId) setSheetOpen(false);
  }, [state.roomId]);

  const closeDialog = () => setDialog(null);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Header
        appName={appName}
        online={state.online}
        reconnecting={state.signaling === 'reconnecting'}
        onSettings={() => setDialog('settings')}
      />

      <main className="flex min-h-0 flex-1 gap-4 px-2 pb-2 sm:px-4 sm:pb-4 lg:px-6">
        <Stage
          call={call}
          state={state}
          appName={appName}
          chatVisible={chatVisible && !desktop}
          onOpenChat={() => setSheetOpen(true)}
          onReport={() => setDialog('report')}
          onBlock={() => setDialog('block')}
        />

        {desktop && <ChatPanel call={call} state={state} className="w-[340px] xl:w-[380px]" />}
      </main>

      {/* Мобильный чат — нижняя выдвижная панель поверх видео */}
      {!desktop && sheetOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-label="Чат">
          <div className="absolute inset-0 animate-fade-in bg-black/40" onClick={() => setSheetOpen(false)} />
          <ChatPanel
            call={call}
            state={state}
            onClose={() => setSheetOpen(false)}
            className={cx('relative h-[62dvh] animate-slide-up rounded-b-none pb-[env(safe-area-inset-bottom)]')}
          />
        </div>
      )}

      <footer className="hidden shrink-0 justify-between px-6 pb-4 lg:flex">
        <FooterLinks />
        <span className="text-sm text-muted">Видео и переписка не записываются</span>
      </footer>

      <Toasts notices={state.notices} onDismiss={(id) => call.dismissNotice(id)} />
      <ReportDialog open={dialog === 'report'} onClose={closeDialog} call={call} />
      <BlockDialog open={dialog === 'block'} onClose={closeDialog} call={call} />
      <SettingsDialog open={dialog === 'settings'} onClose={closeDialog} call={call} state={state} />
    </div>
  );
}
