// Локальный прогон миграций БД.
// Использование: npm run migrate
// На Render миграции применяются автоматически при старте (index.js); этот скрипт — для локальной
// проверки/ручного прогона на любой БД из DATABASE_URL (.env).
import { config } from '../src/config.js';
import { sql, closeDb } from '../src/db/client.js';
import { runMigrations, listAppliedMigrations } from '../src/db/migrations.js';

async function main() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL не задан в .env');

  const { applied } = await runMigrations(sql);
  console.log(applied.length
    ? `✅ Применено миграций: ${applied.length}`
    : '✅ Схема актуальна: новых миграций нет');

  const rows = await listAppliedMigrations(sql);
  console.log('📋 Применённые версии:');
  for (const r of rows) {
    const at = r.applied_at instanceof Date ? r.applied_at.toISOString() : String(r.applied_at);
    console.log(`  - ${r.version}_${r.name} (${at})`);
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error(`❌ ${e?.message || e}`);
  exitCode = 1;
} finally {
  await closeDb().catch(() => {});
}
process.exitCode = exitCode;
