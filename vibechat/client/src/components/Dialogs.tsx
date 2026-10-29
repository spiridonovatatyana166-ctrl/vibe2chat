import { useEffect, useState } from 'react';
import { LANGUAGES, LIMITS, REPORT_REASONS, type LanguageCode, type ReportReason } from '../../../shared/protocol';
import type { CallController, CallState } from '../call/CallController';
import { load } from '../lib/storage';
import { useTheme } from '../lib/theme';
import type { DevicePrefs } from '../media/MediaManager';
import { Button, Modal, Toggle } from './ui';

export function ReportDialog({ open, onClose, call }: { open: boolean; onClose: () => void; call: CallController }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);

  useEffect(() => {
    if (!open) return;
    setReason(null);
    setDetails('');
    setAlsoBlock(true);
    call.holdAutoNext(true);
    return () => call.holdAutoNext(false);
  }, [open, call]);

  const submit = () => {
    if (!reason) return;
    if (call.report(reason, details) && alsoBlock) call.block();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Пожаловаться на собеседника">
      <p className="mb-4 text-sm text-muted">
        Жалобу увидят модераторы. Видео и переписка не записываются — опишите, что произошло, если это поможет.
      </p>
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Причина</legend>
        {REPORT_REASONS.map((r) => (
          <label
            key={r.code}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-3.5 py-2.5 transition has-checked:border-accent has-checked:bg-accent/10"
          >
            <input
              type="radio"
              name="reason"
              value={r.code}
              checked={reason === r.code}
              onChange={() => setReason(r.code)}
              className="accent-[#7c5cff]"
            />
            {r.label}
          </label>
        ))}
      </fieldset>
      <textarea
        value={details}
        onChange={(e) => setDetails(e.target.value.slice(0, LIMITS.reportDetailsMaxLength))}
        placeholder="Подробности (необязательно)"
        rows={3}
        className="mt-4 w-full resize-none rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 outline-none focus:border-accent"
      />
      <div className="mt-2">
        <Toggle checked={alsoBlock} onChange={setAlsoBlock} label="Также заблокировать собеседника" />
      </div>
      <div className="mt-5 flex gap-3">
        <Button className="flex-1" onClick={onClose}>
          Отмена
        </Button>
        <Button variant="danger" className="flex-1" disabled={!reason} onClick={submit}>
          Отправить
        </Button>
      </div>
    </Modal>
  );
}

export function BlockDialog({ open, onClose, call }: { open: boolean; onClose: () => void; call: CallController }) {
  useEffect(() => {
    if (!open) return;
    call.holdAutoNext(true);
    return () => call.holdAutoNext(false);
  }, [open, call]);
  return (
    <Modal open={open} onClose={onClose} title="Заблокировать собеседника?">
      <p className="text-muted">
        Разговор сразу завершится, и этот человек больше не попадётся вам в поиске. Собеседник не узнает о блокировке.
      </p>
      <div className="mt-6 flex gap-3">
        <Button className="flex-1" onClick={onClose}>
          Отмена
        </Button>
        <Button
          variant="danger"
          className="flex-1"
          onClick={() => {
            call.block();
            onClose();
          }}
        >
          Заблокировать
        </Button>
      </div>
    </Modal>
  );
}

export function SettingsDialog({
  open,
  onClose,
  call,
  state,
}: {
  open: boolean;
  onClose: () => void;
  call: CallController;
  state: CallState;
}) {
  const [devices, setDevices] = useState<{ audio: MediaDeviceInfo[]; video: MediaDeviceInfo[] }>({ audio: [], video: [] });
  const [prefs, setPrefs] = useState<DevicePrefs>({});
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    if (!open) return;
    setPrefs(load<DevicePrefs>('devices', {}));
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) =>
        setDevices({
          audio: all.filter((d) => d.kind === 'audioinput' && d.deviceId),
          video: all.filter((d) => d.kind === 'videoinput' && d.deviceId),
        }),
      )
      .catch(() => undefined);
  }, [open, state.local.stream]);

  const currentVideo = state.local.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? prefs.videoId ?? '';
  const currentAudio = state.local.stream?.getAudioTracks()[0]?.getSettings().deviceId ?? prefs.audioId ?? '';
  const noLabels = devices.video.concat(devices.audio).every((d) => !d.label);
  const select =
    'w-full rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 outline-none focus:border-accent';

  return (
    <Modal open={open} onClose={onClose} title="Настройки">
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-muted">Язык собеседника</span>
          <select
            className={select}
            value={state.language}
            onChange={(e) => call.setLanguage(e.target.value as LanguageCode)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        {noLabels && (
          <p className="rounded-xl bg-surface-2 p-3 text-sm text-muted">
            Названия камер и микрофонов появятся после того, как вы нажмёте «Начать» и разрешите доступ.
          </p>
        )}
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-muted">Камера</span>
          <select
            className={select}
            value={currentVideo}
            disabled={devices.video.length === 0}
            onChange={(e) => void call.setDevices({ videoId: e.target.value })}
          >
            {devices.video.length === 0 && <option value="">Не найдена</option>}
            {devices.video.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Камера ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-muted">Микрофон</span>
          <select
            className={select}
            value={currentAudio}
            disabled={devices.audio.length === 0}
            onChange={(e) => void call.setDevices({ audioId: e.target.value })}
          >
            {devices.audio.length === 0 && <option value="">Не найден</option>}
            {devices.audio.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Микрофон ${i + 1}`}
              </option>
            ))}
          </select>
        </label>

        <div className="divide-y divide-line border-t border-line pt-2">
          <Toggle
            checked={state.autoNext}
            onChange={(v) => call.setAutoNext(v)}
            label="Автоматически искать следующего, когда собеседник ушёл"
          />
          <Toggle checked={theme === 'light'} onChange={toggleTheme} label="Светлая тема" />
        </div>
      </div>
      <Button variant="primary" className="mt-6 w-full" onClick={onClose}>
        Готово
      </Button>
    </Modal>
  );
}
