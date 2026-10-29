/**
 * Создание или смена пароля администратора.
 *   npm run admin:create -- <логин>
 * Пароль вводится в терминале (или передаётся через ADMIN_PASSWORD для автоматизации).
 */
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../server/src/auth/tokens.js';
import { SqliteStorage } from '../server/src/storage/sqlite.js';

const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) {
  console.error('Использование: npm run admin:create -- <логин>  (3–64 символа: латиница, цифры, _ . -)');
  process.exit(1);
}

let password = process.env.ADMIN_PASSWORD ?? '';
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Пароль (не короче 12 символов): ');
  rl.close();
}
if (password.length < 12) {
  console.error('Пароль должен быть не короче 12 символов');
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const storage = new SqliteStorage(path.join(dataDir, 'vibechat.sqlite'));
storage.upsertAdmin(username, await hashPassword(password));
storage.close();
console.log(`Администратор «${username}» сохранён в ${dataDir}. Вход: /admin`);
