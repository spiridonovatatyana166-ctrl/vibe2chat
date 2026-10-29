/**
 * Режим разработки: пересборка клиента при изменениях + сервер с автоперезапуском.
 * Клиент и сервер работают на одном адресе (по умолчанию http://localhost:8080).
 */
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['scripts/build-client.mjs', '--watch'], { stdio: 'inherit' }),
  spawn(
    process.execPath,
    ['--env-file-if-exists=.env', '--disable-warning=ExperimentalWarning', '--watch-path=server/src', '--watch-path=shared', '--import', 'tsx', 'server/src/index.ts'],
    { stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'development' } },
  ),
];

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => code && code !== 0 && console.error(`процесс завершился с кодом ${code}`));
