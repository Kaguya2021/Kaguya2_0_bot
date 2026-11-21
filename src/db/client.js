// Подключение к Neon DB через библиотеку 'postgres' + общие хелперы.
import postgres from 'postgres';
import { config } from '../config.js';

export const sql = postgres(config.databaseUrl || undefined, {
  ssl: 'require',
  connect_timeout: 30,   // Neon на бесплатном тарифе "просыпается" несколько секунд
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  prepare: false,        // нужно для пулера Neon (pgbouncer), иначе бывают случайные ошибки
  max: 10,
  onnotice: () => {}
});

export const hasDatabaseUrl = Boolean(config.databaseUrl);

// Чистое завершение пула (для локальных CLI-скриптов, чтобы процесс не зависал).
export async function closeDb() {
  await sql.end({ timeout: 5 });
}

// Повторяем запрос при временных сбоях БД (холодный старт Neon, обрыв соединения).
// Повторяем только идемпотентные upsert/select/update. INSERT черновика и атомарный захват
// не повторяем: повтор после "потерянного" ответа дал бы дубль черновика или ложный отказ.
export async function withRetry(fn, args, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn(...args);
    } catch (err) {
      lastErr = err;
      if (i < tries) await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  console.error('DB error after retries:', lastErr?.message);
  throw lastErr;
}
