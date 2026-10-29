import { classifyMediaError, type MediaErrorKind } from './mediaErrors';

export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

export interface DevicePrefs {
  audioId?: string;
  videoId?: string;
}

export interface LocalMediaState {
  stream: MediaStream | null;
  hasCamera: boolean;
  hasMic: boolean;
  camOn: boolean;
  micOn: boolean;
  canSwitchCamera: boolean;
  facing: 'user' | 'environment';
  /** Предупреждение, если что-то удалось включить лишь частично. */
  warning: string | null;
}

export class MediaAccessError extends Error {
  constructor(readonly kind: MediaErrorKind) {
    super(kind);
  }
}

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const videoConstraints = (facing: 'user' | 'environment', deviceId?: string): MediaTrackConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: facing }),
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
});

/**
 * Управляет камерой и микрофоном: получение с запасными вариантами
 * (только звук, если нет камеры), включение/выключение, смена камеры и
 * полное освобождение устройств.
 */
export class MediaManager {
  state: LocalMediaState = {
    stream: null,
    hasCamera: false,
    hasMic: false,
    camOn: false,
    micOn: false,
    canSwitchCamera: false,
    facing: 'user',
    warning: null,
  };

  constructor(
    private readonly devices: MediaDevicesLike | undefined,
    private readonly secureContext: boolean,
  ) {}

  async acquire(prefs: DevicePrefs = {}): Promise<LocalMediaState> {
    if (this.state.stream) return this.state;
    if (!this.devices?.getUserMedia) throw new MediaAccessError(this.secureContext ? 'unsupported' : 'insecure');

    const audio = prefs.audioId ? { ...AUDIO, deviceId: { exact: prefs.audioId } } : AUDIO;
    const video = videoConstraints('user', prefs.videoId);
    let stream: MediaStream | null = null;
    let warning: string | null = null;

    try {
      stream = await this.devices.getUserMedia({ audio, video });
    } catch (err) {
      const kind = classifyMediaError(err);
      if (kind === 'denied' || kind === 'unsupported') throw new MediaAccessError(kind);
      // Сохранённое устройство могло пропасть — пробуем устройства по умолчанию.
      if (prefs.audioId || prefs.videoId) {
        try {
          stream = await this.devices.getUserMedia({ audio: AUDIO, video: videoConstraints('user') });
        } catch {
          /* переходим к частичным вариантам */
        }
      }
      if (!stream) {
        try {
          stream = await this.devices.getUserMedia({ audio: AUDIO });
          warning =
            kind === 'busy'
              ? 'Камера занята другим приложением — общаемся только голосом'
              : 'Камера не найдена — общаемся только голосом';
        } catch (audioErr) {
          if (classifyMediaError(audioErr) === 'denied') throw new MediaAccessError('denied');
          try {
            stream = await this.devices.getUserMedia({ video: videoConstraints('user') });
            warning = 'Микрофон не найден — собеседник вас не услышит';
          } catch {
            throw new MediaAccessError(kind);
          }
        }
      }
    }

    const hasCamera = stream.getVideoTracks().length > 0;
    const hasMic = stream.getAudioTracks().length > 0;
    const facing = (stream.getVideoTracks()[0]?.getSettings().facingMode as 'user' | 'environment' | undefined) ?? 'user';
    this.state = {
      stream,
      hasCamera,
      hasMic,
      camOn: hasCamera,
      micOn: hasMic,
      canSwitchCamera: hasCamera && (await this.countCameras()) > 1,
      facing,
      warning,
    };
    return this.state;
  }

  private async countCameras(): Promise<number> {
    try {
      return (await this.devices!.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
    } catch {
      return 0;
    }
  }

  async listDevices(): Promise<{ audio: MediaDeviceInfo[]; video: MediaDeviceInfo[] }> {
    if (!this.devices) return { audio: [], video: [] };
    const all = await this.devices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    return { audio: all.filter((d) => d.kind === 'audioinput'), video: all.filter((d) => d.kind === 'videoinput') };
  }

  setMic(on: boolean): void {
    for (const t of this.state.stream?.getAudioTracks() ?? []) t.enabled = on;
    this.state = { ...this.state, micOn: on && this.state.hasMic };
  }

  setCam(on: boolean): void {
    for (const t of this.state.stream?.getVideoTracks() ?? []) t.enabled = on;
    this.state = { ...this.state, camOn: on && this.state.hasCamera };
  }

  /**
   * Заменяет видеодорожку (смена камеры или устройства). Старая дорожка
   * останавливается до запроса новой: многие телефоны не открывают две камеры сразу.
   */
  async replaceVideo(opts: { facing?: 'user' | 'environment'; deviceId?: string }): Promise<MediaStreamTrack | null> {
    const stream = this.state.stream;
    if (!stream || !this.devices) return null;
    const old = stream.getVideoTracks()[0];
    const facing = opts.facing ?? this.state.facing;
    old?.stop();
    let fresh: MediaStream;
    try {
      fresh = await this.devices.getUserMedia({
        video: opts.deviceId ? videoConstraints(facing, opts.deviceId) : { ...videoConstraints(facing), facingMode: { exact: facing } },
      });
    } catch {
      // Не получилось — возвращаем прежнюю камеру.
      fresh = await this.devices.getUserMedia({ video: videoConstraints(this.state.facing) });
    }
    const track = fresh.getVideoTracks()[0]!;
    track.enabled = this.state.camOn;
    if (old) stream.removeTrack(old);
    stream.addTrack(track);
    const actualFacing = (track.getSettings().facingMode as 'user' | 'environment' | undefined) ?? facing;
    this.state = { ...this.state, facing: opts.deviceId ? this.state.facing : actualFacing, hasCamera: true };
    return track;
  }

  async replaceAudio(deviceId: string): Promise<MediaStreamTrack | null> {
    const stream = this.state.stream;
    if (!stream || !this.devices) return null;
    const fresh = await this.devices.getUserMedia({ audio: { ...AUDIO, deviceId: { exact: deviceId } } });
    const track = fresh.getAudioTracks()[0]!;
    track.enabled = this.state.micOn;
    for (const old of stream.getAudioTracks()) {
      old.stop();
      stream.removeTrack(old);
    }
    stream.addTrack(track);
    this.state = { ...this.state, hasMic: true };
    return track;
  }

  /** Полностью освобождает камеру и микрофон (гаснет индикатор камеры). */
  release(): void {
    for (const t of this.state.stream?.getTracks() ?? []) t.stop();
    this.state = { ...this.state, stream: null, camOn: false, micOn: false, warning: null };
  }
}
