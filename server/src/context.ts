import { makeIpHasher, TokenSigner } from './auth/tokens.js';
import type { AppConfig } from './config/env.js';
import type { Logger } from './lib/logger.js';
import { Moderation } from './moderation/moderation.js';
import { Hub } from './realtime/hub.js';
import type { Storage } from './storage/types.js';

export interface AppContext {
  config: AppConfig;
  log: Logger;
  storage: Storage;
  moderation: Moderation;
  hub: Hub;
  guestTokens: TokenSigner;
  adminTokens: TokenSigner;
  hashIp: (ip: string) => string;
  startedAt: number;
}

export function createContext(config: AppConfig, storage: Storage, log: Logger): AppContext {
  const moderation = new Moderation(
    storage,
    { autoBanThreshold: config.autoBanReportThreshold, autoBanHours: config.autoBanHours },
    log.child({ mod: 'moderation' }),
  );
  const hub = new Hub(storage, moderation, log.child({ mod: 'hub' }), { reconnectGraceMs: config.reconnectGraceMs });
  return {
    config,
    log,
    storage,
    moderation,
    hub,
    guestTokens: new TokenSigner(config.sessionSecret, 'guest'),
    adminTokens: new TokenSigner(config.sessionSecret, 'admin'),
    hashIp: makeIpHasher(config.sessionSecret),
    startedAt: Date.now(),
  };
}
