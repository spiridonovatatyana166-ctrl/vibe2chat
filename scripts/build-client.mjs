/**
 * Сборка клиента: esbuild (TS/React) + Tailwind CSS v4 (через его API компилятора).
 * Запуск: node scripts/build-client.mjs [--watch] [--dev]
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { compile } from 'tailwindcss';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'client');
const srcDir = path.join(clientDir, 'src');
const outDir = path.join(clientDir, 'dist');
const assetsDir = path.join(outDir, 'assets');
const require = createRequire(import.meta.url);

const watchMode = process.argv.includes('--watch');
const dev = watchMode || process.argv.includes('--dev');

const hash = (content) => createHash('sha256').update(content).digest('hex').slice(0, 10);

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

/** Кандидаты в классы Tailwind: все «слова» из исходников. Лишние Tailwind просто игнорирует. */
function scanCandidates() {
  const set = new Set();
  for (const file of walk(srcDir, ['.ts', '.tsx', '.html'])) {
    for (const token of readFileSync(file, 'utf8').split(/[\s"'`{}()<>;,]+/)) {
      if (token && token.length < 120) set.add(token);
    }
  }
  return [...set];
}

async function buildCss() {
  const entry = path.join(srcDir, 'styles.css');
  const compiler = await compile(readFileSync(entry, 'utf8'), {
    base: srcDir,
    loadStylesheet: async (id, base) => {
      const file =
        id === 'tailwindcss'
          ? require.resolve('tailwindcss/index.css')
          : id.startsWith('tailwindcss/')
            ? require.resolve(id.endsWith('.css') ? id : `${id}.css`)
            : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: readFileSync(file, 'utf8') };
    },
  });
  const css = compiler.build(scanCandidates());
  const result = await esbuild.transform(css, { loader: 'css', minify: !dev, target: ['chrome100', 'safari15', 'firefox100'] });
  return result.code;
}

function writeAsset(name, ext, content) {
  const file = `${name}-${hash(content)}.${ext}`;
  writeFileSync(path.join(assetsDir, file), content);
  return `/assets/${file}`;
}

const jsOptions = {
  entryPoints: [path.join(srcDir, 'main.tsx')],
  bundle: true,
  format: 'esm',
  target: ['chrome100', 'safari15', 'firefox100'],
  jsx: 'automatic',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  write: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  logLevel: 'warning',
};

async function buildAll(ctx) {
  const started = Date.now();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });
  const publicDir = path.join(clientDir, 'public');
  if (existsSync(publicDir)) cpSync(publicDir, outDir, { recursive: true });

  const js = ctx ? await ctx.rebuild() : await esbuild.build(jsOptions);
  const jsCode = js.outputFiles[0].text;
  const jsUrl = writeAsset('app', 'js', jsCode);
  const cssUrl = writeAsset('app', 'css', await buildCss());

  const html = readFileSync(path.join(clientDir, 'index.html'), 'utf8')
    .replace('<!--CSS-->', `<link rel="stylesheet" href="${cssUrl}" />`)
    .replace('<!--JS-->', `<script type="module" src="${jsUrl}"></script>`);
  writeFileSync(path.join(outDir, 'index.html'), html);
  console.log(`[client] собран за ${Date.now() - started} мс (${Math.round(jsCode.length / 1024)} КБ JS)`);
}

if (watchMode) {
  const ctx = await esbuild.context(jsOptions);
  let timer = null;
  let running = Promise.resolve();
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(() => buildAll(ctx)).catch((err) => console.error('[client] ошибка сборки:', err.message));
    }, 80);
  };
  await buildAll(ctx).catch((err) => console.error('[client] ошибка сборки:', err.message));
  watch(clientDir, { recursive: true }, (_event, file) => {
    if (file && !file.startsWith('dist')) schedule();
  });
  watch(path.join(root, 'shared'), { recursive: true }, schedule);
  console.log('[client] слежу за изменениями…');
} else {
  await buildAll(null);
}
