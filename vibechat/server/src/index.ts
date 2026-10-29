import { ConfigError, loadConfig, type AppConfig } from './config/env.js';
import { startServer } from './server.js';

// Точка входа: проверка окружения, запуск и корректная остановка.
let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
if (!config.isProd && !process.env.SESSION_SECRET) {
  console.warn('[vibechat] SESSION_SECRET не задан — используется временный, сессии сбросятся при перезапуске');
}
const app = await startServer(config);
const shutdown = async (signal: string) => {
  app.ctx.log.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => app.ctx.log.error('unhandled rejection', { err }));
