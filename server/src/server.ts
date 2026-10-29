import { hashPassword } from './auth/tokens.js';
import type { AppConfig } from './config/env.js';
import { createContext } from './context.js';
import { createApp } from './http/app.js';
import { createLogger } from './lib/logger.js';
import { attachGateway } from './realtime/gateway.js';
import { SqliteStorage } from './storage/sqlite.js';

export async function startServer(config: AppConfig, opts: { silent?: boolean; clientDist?: string } = {}) {
  const log = createLogger(config.logLevel, { app: 'vibechat' }, opts.silent);
  const storage = new SqliteStorage(config.dbPath);

  if (config.adminBootstrap && storage.countAdmins() === 0) {
    storage.upsertAdmin(config.adminBootstrap.username, await hashPassword(config.adminBootstrap.password));
    log.info('bootstrap admin created', { admin: config.adminBootstrap.username });
  }

  const ctx = createContext(config, storage, log);
  const server = createApp(ctx, opts.clientDist);
  const gateway = attachGateway(server, ctx);

  // Политика хранения: удаляем старые разобранные жалобы, блокировки и истёкшие баны.
  const retention = setInterval(
    () => {
      try {
        const day = 86_400_000;
        const purged = storage.purgeExpired({
          reportOlderThanMs: Date.now() - config.reportRetentionDays * day,
          blockOlderThanMs: Date.now() - config.blockRetentionDays * day,
          banExpiredBeforeMs: Date.now() - 30 * day,
        });
        if (purged.reports + purged.blocks + purged.bans > 0) log.info('retention purge', purged);
      } catch (err) {
        log.error('retention purge failed', { err });
      }
    },
    6 * 3600_000,
  );
  retention.unref();

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log.info('server started', { port, env: config.env, turn: config.turnUrls.length > 0 });

  return {
    ctx,
    port,
    async close() {
      clearInterval(retention);
      ctx.hub.stop();
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      storage.close();
    },
  };
}
