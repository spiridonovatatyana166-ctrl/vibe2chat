import type { IceConfig, Role, SignalData } from '../../../shared/protocol';

export type PeerState = 'new' | 'connecting' | 'connected' | 'unstable' | 'failed' | 'closed';

export interface PeerCallbacks {
  sendSignal(data: SignalData): void;
  onRemoteStream(stream: MediaStream): void;
  onState(state: PeerState): void;
}

const MAX_ICE_RESTARTS = 2;
const UNSTABLE_RESTART_MS = 4000;

/**
 * Одно WebRTC-соединение с собеседником. Роли фиксирует сервер:
 * offerer создаёт offer и отвечает за ICE restart, answerer только отвечает.
 */
export class PeerSession {
  readonly pc: RTCPeerConnection;
  private readonly remoteStream = new MediaStream();
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private restarts = 0;
  private unstableTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private makingOffer = false;
  state: PeerState = 'new';

  constructor(
    ice: IceConfig,
    readonly role: Role,
    localStream: MediaStream | null,
    private readonly cb: PeerCallbacks,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: ice.iceServers,
      iceTransportPolicy: ice.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
    });

    const tracks = localStream?.getTracks() ?? [];
    for (const track of tracks) this.pc.addTrack(track, localStream!);
    // Если своей камеры или микрофона нет, всё равно получаем видео и звук собеседника.
    if (role === 'offerer') {
      if (!tracks.some((t) => t.kind === 'audio')) this.pc.addTransceiver('audio', { direction: 'recvonly' });
      if (!tracks.some((t) => t.kind === 'video')) this.pc.addTransceiver('video', { direction: 'recvonly' });
    }

    this.pc.ontrack = (ev) => {
      if (!this.remoteStream.getTracks().includes(ev.track)) this.remoteStream.addTrack(ev.track);
      this.cb.onRemoteStream(this.remoteStream);
    };
    this.pc.onicecandidate = (ev) => {
      if (!ev.candidate || this.closed) return;
      const c = ev.candidate.toJSON();
      this.cb.sendSignal({
        kind: 'ice',
        candidate: {
          candidate: c.candidate ?? '',
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
          usernameFragment: c.usernameFragment ?? null,
        },
      });
    };
    this.pc.onconnectionstatechange = () => this.onConnectionState();
    this.setState('connecting');
  }

  private setState(s: PeerState) {
    if (this.state === s || this.closed) return;
    this.state = s;
    this.cb.onState(s);
  }

  private onConnectionState(): void {
    if (this.closed) return;
    const s = this.pc.connectionState;
    if (s === 'connected') {
      this.clearUnstable();
      this.restarts = 0;
      this.setState('connected');
    } else if (s === 'disconnected') {
      // Часто восстанавливается само (смена Wi-Fi/4G); если нет — перезапускаем ICE.
      this.setState('unstable');
      this.clearUnstable();
      this.unstableTimer = setTimeout(() => {
        if (this.pc.connectionState !== 'connected') void this.restartIce();
      }, UNSTABLE_RESTART_MS);
    } else if (s === 'failed') {
      if (this.role === 'offerer' && this.restarts < MAX_ICE_RESTARTS) void this.restartIce();
      else if (this.role === 'answerer') this.setState('unstable');
      else this.setState('failed');
    }
  }

  private clearUnstable() {
    if (this.unstableTimer) clearTimeout(this.unstableTimer);
    this.unstableTimer = null;
  }

  /** Offerer создаёт первоначальный offer. */
  async start(): Promise<void> {
    if (this.role !== 'offerer') return;
    await this.makeOffer(false);
  }

  private async makeOffer(iceRestart: boolean): Promise<void> {
    if (this.closed || this.makingOffer) return;
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer({ iceRestart });
      await this.pc.setLocalDescription(offer);
      this.cb.sendSignal({ kind: 'offer', sdp: this.pc.localDescription!.sdp });
    } finally {
      this.makingOffer = false;
    }
  }

  async restartIce(): Promise<void> {
    if (this.role !== 'offerer' || this.closed) return;
    if (this.restarts >= MAX_ICE_RESTARTS) {
      this.setState('failed');
      return;
    }
    this.restarts++;
    this.setState('unstable');
    await this.makeOffer(true);
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (this.closed) return;
    if (data.kind === 'offer') {
      if (this.role !== 'answerer') return;
      await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      await this.flushCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.cb.sendSignal({ kind: 'answer', sdp: this.pc.localDescription!.sdp });
    } else if (data.kind === 'answer') {
      if (this.role !== 'offerer' || this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      await this.flushCandidates();
    } else {
      const candidate: RTCIceCandidateInit = {
        candidate: data.candidate.candidate,
        sdpMid: data.candidate.sdpMid,
        sdpMLineIndex: data.candidate.sdpMLineIndex,
        usernameFragment: data.candidate.usernameFragment ?? undefined,
      };
      // Кандидаты могут прийти раньше описания сессии — копим их.
      if (!this.pc.remoteDescription) this.pendingCandidates.push(candidate);
      else await this.addCandidate(candidate);
    }
  }

  private async flushCandidates(): Promise<void> {
    const list = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of list) await this.addCandidate(c);
  }

  private async addCandidate(c: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(c);
    } catch {
      /* устаревший кандидат после ICE restart — не ошибка */
    }
  }

  /** Замена дорожки без пересогласования (смена камеры/микрофона). */
  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === track.kind);
    if (sender) await sender.replaceTrack(track);
    else {
      const tr = this.pc.getTransceivers().find((t) => t.receiver.track.kind === track.kind);
      if (tr) await tr.sender.replaceTrack(track);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearUnstable();
    this.pc.ontrack = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    // Локальные дорожки не останавливаем — камера нужна для следующего собеседника.
    for (const t of this.remoteStream.getTracks()) t.stop();
    this.pc.close();
    this.state = 'closed';
  }
}
