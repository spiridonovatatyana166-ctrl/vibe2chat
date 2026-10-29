import { useSyncExternalStore } from 'react';
import { getIceConfig, getSession } from '../lib/api';
import { load, save } from '../lib/storage';
import { MediaManager } from '../media/MediaManager';
import { PeerSession } from '../rtc/PeerSession';
import { SignalingClient } from '../signaling/SignalingClient';
import { CallController, type CallState } from './CallController';

export function createCallController(onUnauthorized: () => void): CallController {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  return new CallController({
    createSignaling: (events) =>
      new SignalingClient(wsUrl, events, undefined, async () => (await getSession()).authenticated),
    createPeer: (ice, role, stream, cb) => new PeerSession(ice, role, stream, cb),
    media: new MediaManager(navigator.mediaDevices, window.isSecureContext),
    getIce: getIceConfig,
    loadPref: load,
    savePref: save,
    onUnauthorized,
  });
}

export function useCallState(call: CallController): CallState {
  return useSyncExternalStore(call.subscribe, call.getState);
}
