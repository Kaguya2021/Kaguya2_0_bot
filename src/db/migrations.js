// Версионированные миграции БД.
//
// Render Free: нет Shell/one-off jobs, поэтому миграции запускаются автоматически при старте
// (и лениво при первом запросе из CLI-скриптов). Применённые версии хранятся в schema_migrations:
// если всё уже применено — один SELECT и ни одного CREATE/ALTER (нет DDL-блокировок на холодном старте).
//
// Все миграции идемпотентны (IF NOT EXISTS): на боевой БД, созданной до Фазы 3
// (таблицы есть, schema_migrations ещё нет), они проходят без ошибок и просто фиксируются.
// Правило: только CREATE/ADD ... IF NOT EXISTS — никаких DROP/RENAME (обратная совместимость).
import { sql as defaultSql, hasDatabaseUrl } from './client.js';

// Произвольная константа для pg_advisory_xact_lock: сериализует миграции,
// если два инстанса (старый и новый при деплое) стартуют одновременно.
const MIGRATION_LOCK_ID = 7_202_603;

export const MIGRATIONS = Object.freeze([
  {
    version: '001',
    name: 'initial_schema',
    async up(tx) {
      await tx`
        CREATE TABLE IF NOT EXISTS user_settings (
          user_id VARCHAR(50) PRIMARY KEY,
          custom_reply TEXT,
          start_time VARCHAR(10),
          end_time VARCHAR(10),
          reply_mode VARCHAR(20) DEFAULT 'always',
          allowed_username VARCHAR(100),
          timer_mode BOOLEAN DEFAULT false
        )
      `;
      // Колонки, которых нет в самых старых версиях user_settings.
      await tx`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reply_mode VARCHAR(20) DEFAULT 'always'`;
      await tx`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS allowed_username VARCHAR(100)`;
      await tx`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timer_mode BOOLEAN DEFAULT false`;
      await tx`
        CREATE TABLE IF NOT EXISTS users (
          user_id VARCHAR(50) PRIMARY KEY,
          username VARCHAR(100),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS chat_pauses (
          chat_id VARCHAR(50) PRIMARY KEY,
          pause_until BIGINT
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS message_logs (
          id SERIAL PRIMARY KEY,
          chat_id VARCHAR(50),
          role VARCHAR(20),
          content TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
    }
  },
  {
    version: '002',
    name: 'phase1_stability',
    async up(tx) {
      await tx`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timezone_offset_min SMALLINT DEFAULT 0`;
      await tx`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_off_until BIGINT`;
      await tx`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS blocked_until BIGINT`;
      await tx`
        CREATE TABLE IF NOT EXISTS bot_state (
          key VARCHAR(50) PRIMARY KEY,
          value TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
    }
  },
  {
    version: '003',
    name: 'phase2_feedback_publishing',
    async up(tx) {
      await tx`ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'new'`;
      await tx`
        CREATE TABLE IF NOT EXISTS channel_comments (
          id SERIAL PRIMARY KEY,
          chat_id VARCHAR(50) NOT NULL,
          message_id BIGINT NOT NULL,
          reply_to_message_id BIGINT,
          thread_id BIGINT,
          user_id VARCHAR(50),
          username VARCHAR(100),
          first_name VARCHAR(100),
          text TEXT NOT NULL,
          status VARCHAR(20) DEFAULT 'new',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (chat_id, message_id)
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS post_drafts (
          id SERIAL PRIMARY KEY,
          html_text TEXT NOT NULL,
          buttons_json JSONB,
          media_type VARCHAR(20),
          media_file_id TEXT,
          status VARCHAR(20) DEFAULT 'pending_approval',
          created_by VARCHAR(50),
          approved_by VARCHAR(50),
          published_message_id BIGINT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          published_at TIMESTAMP
        )
      `;
      await tx`CREATE INDEX IF NOT EXISTS idx_channel_comments_status_created ON channel_comments (status, created_at)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_message_logs_role_status_created ON message_logs (role, status, created_at)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_post_drafts_status ON post_drafts (status)`;
    }
  }
]);

export function migrationId(m) {
  return `${m.version}_${m.name}`;
}

const UNDEFINED_TABLE = '42P01';

async function readAppliedVersions(sql) {
  try {
    const rows = await sql`SELECT version FROM schema_migrations`;
    return new Set(rows.map((r) => r.version));
  } catch (err) {
    if (err?.code !== UNDEFINED_TABLE) throw err;
    return null; // таблицы ещё нет
  }
}

async function createMigrationsTable(sql) {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (err) {
    // Гонка двух инстансов: параллельный CREATE TABLE IF NOT EXISTS может упасть с 23505/42P07.
    if (err?.code !== '23505' && err?.code !== '42P07') throw err;
  }
}

// Прогоняет неприменённые миграции. Возвращает { applied: [...id], skipped: [...id] }.
// Быстрый путь (всё применено): ровно один SELECT, без DDL.
export async function runMigrations(sql, { migrations = MIGRATIONS, log = console.log } = {}) {
  let applied = await readAppliedVersions(sql);
  if (applied === null) {
    await createMigrationsTable(sql);
    applied = new Set();
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  const result = { applied: [], skipped: migrations.filter((m) => applied.has(m.version)).map(migrationId) };
  if (!pending.length) return result;

  for (const m of pending) {
    const done = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
      // Перепроверка под блокировкой: миграцию мог только что применить другой инстанс.
      const already = await tx`SELECT 1 FROM schema_migrations WHERE version = ${m.version}`;
      if (already.length) return false;
      await m.up(tx);
      await tx`
        INSERT INTO schema_migrations (version, name)
        VALUES (${m.version}, ${m.name})
        ON CONFLICT (version) DO NOTHING
      `;
      return true;
    });
    if (done) {
      result.applied.push(migrationId(m));
      log(`🛠️ DB: применена миграция ${migrationId(m)}`);
    } else {
      result.skipped.push(migrationId(m));
    }
  }
  return result;
}

// Список применённых миграций (для CLI).
export async function listAppliedMigrations(sql = defaultSql) {
  return sql`SELECT version, name, applied_at FROM schema_migrations ORDER BY version`;
}

// --- Ленивая гарантия схемы для репозиториев (замена прежнего ensureDbInit) ---
// Ошибка миграции НЕ ломает запросы: таблицы обычно уже существуют.
// Логируем причину; промис сбрасывается, поэтому следующий запрос повторит попытку.
let schemaReady = false;
let schemaPromise = null;

export function ensureSchema() {
  if (schemaReady || !hasDatabaseUrl) return undefined;
  if (!schemaPromise) {
    schemaPromise = runMigrations(defaultSql)
      .then(() => { schemaReady = true; })
      .catch((err) => { console.error('DB init error (будет повторная попытка):', err?.message || err); })
      .finally(() => { schemaPromise = null; });
  }
  return schemaPromise;
}
