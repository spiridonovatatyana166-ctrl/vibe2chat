/**
 * Расширенный браузерный тест: компьютер + телефон (эмуляция iPhone),
 * чат, кнопки, «Следующий», обрыв сети, жалоба и бан через админку,
 * запрет камеры. Пишет видео и скриншоты в e2e/report/.
 * Запуск: npm run build && node e2e/browser-suite.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';

const PORT = 18200;
const BASE = `http://localhost:${PORT}`;
const OUT = path.resolve('e2e/report');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t, error: err.message.split('\n')[0] });
    console.log(`  ✖ ${name}\n      ${err.message.split('\n')[0]}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/index.ts'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    SESSION_SECRET: 'suite-secret-suite-secret-suite-secret',
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'vibechat-suite-')),
    LOG_LEVEL: 'warn',
    RECONNECT_GRACE_MS: '15000',
    ADMIN_BOOTSTRAP_USERNAME: 'moderator',
    ADMIN_BOOTSTRAP_PASSWORD: 'moderator-password-123',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * TCP-прокси для «телефона»: позволяет по-настоящему оборвать его соединение
 * с сервером (эмуляция offline в Chromium не закрывает уже открытые WebSocket).
 */
const PROXY_PORT = PORT + 1;
const proxySockets = new Set();
let proxyDown = false;
const proxy = net.createServer((client) => {
  if (proxyDown) return client.destroy();
  const upstream = net.connect(PORT, '127.0.0.1');
  for (const s of [client, upstream]) {
    proxySockets.add(s);
    s.on('close', () => proxySockets.delete(s));
    s.on('error', () => undefined);
  }
  client.pipe(upstream).pipe(client);
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
const dropNetwork = (ms) => {
  proxyDown = true;
  for (const s of proxySockets) s.destroy();
  setTimeout(() => (proxyDown = false), ms);
};

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const contexts = [];
const pageErrors = [];
async function newUser(name, opts = {}) {
  const ctx = await browser.newContext({
    permissions: ['camera', 'microphone'],
    recordVideo: { dir: path.join(OUT, `video-${name}`), size: opts.viewport ?? { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
    ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'viaProxy')),
  });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`[${name}] ${e.message}`));
  await page.goto(opts.viaProxy ? `http://localhost:${PROXY_PORT}` : BASE);
  return { ctx, page };
}
async function enter(page) {
  await page.getByText('Мне исполнилось 18 лет').click();
  await page.locator('label').filter({ hasText: 'Я принимаю' }).locator('input').check();
  await page.getByRole('button', { name: 'Войти в чат' }).click();
}
const remotePlaying = (page, timeout = 20_000) =>
  page.waitForFunction(
    () => {
      const v = document.querySelector('video[aria-label="Видео собеседника"]');
      return Boolean(v && v.videoWidth > 0 && v.currentTime > 0.3 && !v.paused);
    },
    null,
    { timeout },
  );
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

console.log('Браузерный тест VibeChat\n');
const alice = await newUser('alice-desktop');
const iphone = devices['iPhone 13'];
const bob = await newUser('bob-mobile', {
  viewport: iphone.viewport,
  userAgent: iphone.userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  viaProxy: true,
});

await check('Без подтверждения 18+ нельзя войти, кнопка неактивна', async () => {
  const btn = alice.page.getByRole('button', { name: 'Войти в чат' });
  expect(await btn.isDisabled(), 'кнопка активна без галочек');
  await shot(alice.page, '01-age-gate');
});

await check('После подтверждения виден экран ожидания, камера ещё выключена', async () => {
  await enter(alice.page);
  await alice.page.getByRole('heading', { name: /Познакомься/ }).waitFor();
  const videos = await alice.page.locator('video').count();
  expect(videos === 0, 'видео появилось до нажатия «Начать»');
});

await check('Онлайн-счётчик показывает реальные данные сервера', async () => {
  await enter(bob.page);
  await alice.page.getByText(/2 онлайн/).waitFor({ timeout: 15_000 });
});

await check('Поиск: анимация, статус и кнопка отмены', async () => {
  await alice.page.getByRole('button', { name: 'Начать' }).first().click();
  await alice.page.getByText('Ищем собеседника…').waitFor();
  await alice.page.getByRole('button', { name: 'Отменить поиск' }).waitFor();
  await shot(alice.page, '02-searching');
});

await check('Компьютер и телефон соединяются, видео идёт в обе стороны', async () => {
  await bob.page.getByRole('button', { name: 'Начать' }).first().click();
  await Promise.all([remotePlaying(alice.page), remotePlaying(bob.page)]);
  await alice.page.getByText('В сети', { exact: true }).waitFor();
});

await check('Таймер разговора идёт', async () => {
  await alice.page.waitForTimeout(2200);
  const t = await alice.page.locator('span.font-mono').first().textContent();
  expect(/^00:0[1-9]$/.test(t ?? ''), `таймер: ${t}`);
});

await check('Чат: компьютер → телефон (с бейджем непрочитанного)', async () => {
  const box = alice.page.getByLabel('Текст сообщения');
  await box.fill('Привет! Как дела?');
  await box.press('Enter');
  await bob.page.locator('button[aria-label="Чат"] span').filter({ hasText: '1' }).waitFor();
  await shot(bob.page, '03-mobile-call');
  await bob.page.getByRole('button', { name: 'Чат' }).click();
  await bob.page.getByText('Привет! Как дела?').waitFor();
});

await check('Чат: телефон → компьютер', async () => {
  const box = bob.page.getByLabel('Текст сообщения');
  await box.fill('Отлично, пишу с телефона');
  await box.press('Enter');
  await alice.page.getByText('Отлично, пишу с телефона').waitFor();
  await shot(bob.page, '04-mobile-chat');
  await bob.page.getByRole('button', { name: 'Скрыть чат' }).click();
  await shot(alice.page, '05-desktop-call');
});

await check('Сообщение длиннее 500 символов не отправить', async () => {
  const box = alice.page.getByLabel('Текст сообщения');
  await box.fill('а'.repeat(520));
  expect(await alice.page.getByRole('button', { name: 'Отправить' }).isDisabled(), 'кнопка активна');
  await alice.page.getByText('520/500').waitFor();
  await box.fill('');
});

await check('Микрофон: выключение отображается на своём превью', async () => {
  await alice.page.getByRole('button', { name: 'Выключить микрофон' }).click();
  await alice.page.getByRole('button', { name: 'Включить микрофон' }).waitFor();
  const enabled = await alice.page.evaluate(() =>
    document.querySelector('video[aria-label="Ваша камера"]')?.srcObject?.getAudioTracks().every((t) => !t.enabled),
  );
  expect(enabled, 'аудиодорожка не выключена');
  await alice.page.getByRole('button', { name: 'Включить микрофон' }).click();
});

await check('Камера: собеседник видит «камера выключена»', async () => {
  await bob.page.getByRole('button', { name: 'Выключить камеру' }).click();
  await alice.page.getByText('Собеседник выключил камеру').waitFor();
  await shot(alice.page, '06-partner-camera-off');
  await bob.page.getByRole('button', { name: 'Включить камеру' }).click();
  await alice.page.getByText('Собеседник выключил камеру').waitFor({ state: 'detached' });
});

await check('Полноэкранный режим включается и выключается', async () => {
  await alice.page.getByRole('button', { name: 'Полный экран' }).click();
  await alice.page.waitForFunction(() => Boolean(document.fullscreenElement));
  await alice.page.getByRole('button', { name: 'Выйти из полноэкранного режима' }).click();
  await alice.page.waitForFunction(() => !document.fullscreenElement);
});

await check('Обрыв связи с сервером на телефоне: разговор восстанавливается', async () => {
  dropNetwork(4000);
  await bob.page.getByText('Восстанавливаем связь').waitFor({ timeout: 5000 });
  await alice.page.getByText(/переподключается/).first().waitFor({ timeout: 5000 });
  await shot(alice.page, '07-partner-reconnecting');
  await alice.page.getByText('В сети', { exact: true }).waitFor({ timeout: 20_000 });
  await bob.page.getByText('В сети', { exact: true }).waitFor({ timeout: 20_000 });
  await remotePlaying(alice.page);
  await bob.page.getByRole('button', { name: 'Чат' }).click();
  const box = bob.page.getByLabel('Текст сообщения');
  await box.fill('Я вернулся');
  await box.press('Enter');
  await alice.page.getByText('Я вернулся').waitFor();
  await bob.page.getByRole('button', { name: 'Скрыть чат' }).click();
});

const carol = await newUser('carol-desktop');
await check('«Следующий»: переход к новому собеседнику без перезагрузки', async () => {
  await enter(carol.page);
  await carol.page.getByRole('button', { name: 'Начать' }).first().click();
  await carol.page.getByText('Ищем собеседника…').waitFor();
  await alice.page.getByRole('button', { name: /Следующий/ }).click();
  await remotePlaying(carol.page);
  await remotePlaying(alice.page);
  expect((await alice.page.getByText('Привет! Как дела?').count()) === 0, 'старый чат не очищен');
});

await check('Ушедший собеседник получает статус и автопоиск', async () => {
  await bob.page.getByText('Ищем собеседника…').waitFor({ timeout: 10_000 });
});

await check('Жалоба и блокировка с телефона', async () => {
  // Кэрол уходит, Алиса после паузы снова встречает Боба.
  await carol.page.getByRole('button', { name: 'Завершить' }).click();
  await remotePlaying(bob.page, 30_000);
  await bob.page.getByRole('button', { name: 'Пожаловаться' }).click();
  await bob.page.getByText('Оскорбления или травля').click();
  await bob.page.getByPlaceholder('Подробности (необязательно)').fill('Тестовая жалоба из браузерного теста');
  await shot(bob.page, '08-report-dialog');
  await bob.page.getByRole('button', { name: 'Отправить' }).click();
  await bob.page.getByText(/Жалоба отправлена/).waitFor();
  // Вместе с жалобой — блокировка, разговор прекращается у обоих.
  await alice.page.getByText(/Собеседник отключился|Ищем собеседника…/).first().waitFor();
});

await check('«Завершить» полностью выключает камеру', async () => {
  await carol.page.getByRole('button', { name: 'Начать' }).first().waitFor();
  const active = await carol.page.evaluate(() => document.querySelectorAll('video').length);
  expect(active === 0, 'видео осталось на странице');
});

const admin = await newUser('admin');
await check('Админка: без входа данных нет, после входа видна жалоба', async () => {
  const r = await admin.page.request.get(`${BASE}/api/admin/reports`);
  expect(r.status() === 401, `статус ${r.status()}`);
  await admin.page.goto(`${BASE}/admin`);
  await admin.page.getByPlaceholder('Логин').fill('moderator');
  await admin.page.getByPlaceholder('Пароль').fill('moderator-password-123');
  await admin.page.getByRole('button', { name: 'Войти' }).click();
  await admin.page.getByText('Тестовая жалоба из браузерного теста').waitFor();
  await shot(admin.page, '09-admin');
});

await check('Бан из админки сразу отключает нарушителя', async () => {
  await admin.page.getByRole('button', { name: 'Забанить' }).first().click();
  await admin.page.getByRole('button', { name: 'Заблокировать' }).click();
  await alice.page.getByText('Доступ ограничен').waitFor({ timeout: 10_000 });
  await shot(alice.page, '10-banned');
  await alice.page.reload();
  await alice.page.getByText('Доступ ограничен').waitFor();
});

await check('Запрет доступа к камере: понятная инструкция', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(ctx);
  // Так браузер отвечает, когда пользователь нажал «Блокировать» в запросе доступа.
  await ctx.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await enter(page);
  await page.getByRole('button', { name: 'Начать' }).first().click();
  await page.getByText('Нет доступа к камере и микрофону').waitFor();
  await page.getByRole('button', { name: 'Попробовать снова' }).waitFor();
  await shot(page, '11-camera-denied');
});

await check('Светлая тема и страница правил', async () => {
  await carol.page.getByRole('button', { name: 'Светлая тема' }).click();
  await carol.page.getByRole('link', { name: 'Правила' }).first().click();
  await carol.page.getByRole('heading', { name: 'Правила сообщества' }).waitFor();
  await shot(carol.page, '12-light-rules');
});

await check('Ошибок JavaScript на страницах нет', async () => {
  expect(pageErrors.length === 0, pageErrors.join('; '));
});

for (const c of contexts) await c.close();
await browser.close();
server.kill('SIGTERM');
proxy.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\nИтог: ${results.length - failed} из ${results.length} проверок пройдено`);
await import('node:fs').then((fs) => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2)));
process.exit(failed ? 1 : 0);
