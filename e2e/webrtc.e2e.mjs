/**
 * Сквозной тест: настоящий сервер + два независимых браузера Chromium
 * с виртуальными камерами. Проверяет, что WebRTC-видео реально доходит
 * до собеседника, работают чат, «Следующий», выключение камеры и «Завершить».
 *
 * Требования: собранный клиент (npm run build:client) и браузер Playwright
 * (npx playwright install chromium).
 * Запуск: npm run test:e2e
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = Number(process.env.E2E_PORT ?? 18080);
const BASE = `http://localhost:${PORT}`;
const step = (s) => console.log(`  • ${s}`);

const server = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/index.ts'],
  {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
      DATA_DIR: mkdtempSync(path.join(tmpdir(), 'vibechat-e2e-')),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* ещё стартует */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('сервер не запустился');
}

/** Есть ли в видео собеседника живые кадры (ширина > 0 и время идёт). */
async function remoteVideoPlaying(page, timeout = 20_000) {
  return page.waitForFunction(
    () => {
      const v = document.querySelector('video[aria-label="Видео собеседника"]');
      return Boolean(v && v.videoWidth > 0 && v.currentTime > 0.3 && !v.paused);
    },
    null,
    { timeout },
  );
}

async function openUser(browser, name) {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] ошибка страницы:`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${name}] console:`, m.text()));
  await page.goto(BASE);
  await page.getByText('Мне исполнилось 18 лет').click();
  await page.locator('label').filter({ hasText: 'Я принимаю' }).locator('input').check();
  await page.getByRole('button', { name: 'Войти в чат' }).click();
  await page.getByRole('button', { name: 'Начать' }).first().click();
  return { context, page };
}

let browser;
let exitCode = 0;
try {
  await waitForServer();
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  console.log('E2E: видеозвонок между двумя браузерами');
  const alice = await openUser(browser, 'alice');
  await alice.page.getByText('Ищем собеседника…').waitFor();
  step('Алиса ищет собеседника');
  const bob = await openUser(browser, 'bob');
  step('Боб нажал «Начать»');

  await Promise.all([remoteVideoPlaying(alice.page), remoteVideoPlaying(bob.page)]);
  step('видео собеседника воспроизводится у обоих (WebRTC работает)');
  await alice.page.getByText('В сети', { exact: true }).waitFor();

  const box = alice.page.getByLabel('Текст сообщения');
  await box.fill('Привет, Боб!');
  await box.press('Enter');
  await bob.page.getByText('Привет, Боб!').waitFor({ timeout: 5000 });
  step('сообщение чата дошло');

  await bob.page.getByRole('button', { name: 'Выключить камеру' }).click();
  await alice.page.getByText('Собеседник выключил камеру').waitFor({ timeout: 5000 });
  await bob.page.getByRole('button', { name: 'Включить камеру' }).click();
  await alice.page.getByText('Собеседник выключил камеру').waitFor({ state: 'detached', timeout: 5000 });
  step('выключение камеры видно собеседнику');

  // Третий пользователь, чтобы «Следующий» было к кому вести.
  const carol = await openUser(browser, 'carol');
  await carol.page.getByText('Ищем собеседника…').waitFor();
  await alice.page.getByRole('button', { name: /Следующий/ }).click();
  step('Алиса нажала «Следующий»');
  await remoteVideoPlaying(carol.page);
  await remoteVideoPlaying(alice.page);
  step('Алиса соединилась с Кэрол без перезагрузки страницы');
  assert.equal(await alice.page.getByText('Привет, Боб!').count(), 0, 'чат очищен при смене собеседника');

  // Боба вернуло в поиск (автопоиск включён по умолчанию).
  await bob.page.getByText('Ищем собеседника…').waitFor({ timeout: 8000 });
  step('Боб получил уведомление и автоматически ищет дальше');

  await carol.page.getByRole('button', { name: 'Завершить' }).click();
  await carol.page.getByRole('button', { name: 'Начать' }).first().waitFor();
  const camOff = await carol.page.evaluate(() =>
    [...document.querySelectorAll('video')].every((v) => !v.srcObject || v.srcObject.getTracks().every((t) => t.readyState === 'ended')),
  );
  assert.ok(camOff, 'камера Кэрол освобождена');
  step('«Завершить» освобождает камеру');

  // Алиса после ухода Кэрол автоматически находит Боба.
  // Боб был предыдущим собеседником Алисы — повторная встреча разрешается после паузы 10 с.
  await remoteVideoPlaying(alice.page, 30_000);
  await remoteVideoPlaying(bob.page, 30_000);
  step('после ухода собеседника Алиса автоматически нашла Боба');

  await alice.page.screenshot({ path: 'e2e/screenshot-desktop.png' });
  console.log('E2E: все проверки пройдены ✔');
} catch (err) {
  console.error('E2E: ошибка ✖', err);
  exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  process.exit(exitCode);
}
