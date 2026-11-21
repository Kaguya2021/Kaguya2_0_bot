import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

// Подключение к Neon DB через библиотеку 'postgres'
const sql = postgres(process.env.DATABASE_URL, {
  ssl: 'require',
  connect_timeout: 30,   // Neon на бесплатном тарифе "просыпается" несколько секунд
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  prepare: false,        // нужно для пулера Neon (pgbouncer), иначе бывают случайные ошибки
  max: 10,
  onnotice: () => {}
});

let isDbInitialized = false;
let initPromise = null;

// Автоматическая подготовка таблиц
async function ensureDbInit() {
  if (isDbInitialized || !process.env.DATABASE_URL) return;
  if (!initPromise) {
    // Ошибка создания таблиц НЕ должна ломать все запросы: таблицы обычно уже существуют.
    // Логируем причину; initPromise сбрасывается, поэтому следующий запрос повторит инициализацию.
    initPromise = runDbInit()
      .catch((err) => { console.error('DB init error (будет повторная попытка):', err?.message || err); })
      .finally(() => { initPromise = null; });
  }
  return initPromise;
}

// Колонки user_settings, которые добавлялись после первой версии схемы.
// Только ADD COLUMN IF NOT EXISTS — никаких DROP/RENAME (обратная совместимость).
// Функции, а не готовые запросы: запрос postgres.js выполняется один раз, а init может повторяться.
const USER_SETTINGS_COLUMNS = {
  reply_mode: () => sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reply_mode VARCHAR(20) DEFAULT 'always'`,
  allowed_username: () => sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS allowed_username VARCHAR(100)`,
  timer_mode: () => sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timer_mode BOOLEAN DEFAULT false`,
  timezone_offset_min: () => sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timezone_offset_min SMALLINT DEFAULT 0`,
  auto_off_until: () => sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_off_until BIGINT`,
  blocked_until: () => sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS blocked_until BIGINT`
};

async function runDbInit() {
  await sql`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id VARCHAR(50) PRIMARY KEY,
      custom_reply TEXT,
      start_time VARCHAR(10),
      end_time VARCHAR(10),
      reply_mode VARCHAR(20) DEFAULT 'always',
      allowed_username VARCHAR(100),
      timer_mode BOOLEAN DEFAULT false
    );
  `;

  // ALTER выполняем только для реально отсутствующих колонок (без лишних DDL на каждом старте).
  const existing = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'user_settings';
  `;
  const existingNames = new Set(existing.map((r) => r.column_name));
  for (const [column, alter] of Object.entries(USER_SETTINGS_COLUMNS)) {
    if (!existingNames.has(column)) {
      await alter();
      console.log(`🛠️ DB: добавлена колонка user_settings.${column}`);
    }
  }

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      user_id VARCHAR(50) PRIMARY KEY,
      username VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_pauses (
      chat_id VARCHAR(50) PRIMARY KEY,
      pause_until BIGINT
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS message_logs (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50),
      role VARCHAR(20),
      content TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS bot_state (
      key VARCHAR(50) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  isDbInitialized = true;
}

const toNumOrNull = (v) => (v === null || v === undefined ? null : Number(v));

export const DEFAULT_USER_SETTINGS = Object.freeze({
  custom_reply: null,
  start_time: null,
  end_time: null,
  allowed_username: null,
  timer_mode: false,
  timezone_offset_min: 0,
  auto_off_until: null,
  blocked_until: null
});

function normalizeSettings(row) {
  if (!row) return { ...DEFAULT_USER_SETTINGS };
  return {
    custom_reply: row.custom_reply ?? null,
    start_time: row.start_time ?? null,
    end_time: row.end_time ?? null,
    allowed_username: row.allowed_username ?? null,
    timer_mode: row.timer_mode === true,
    timezone_offset_min: Number(row.timezone_offset_min) || 0,
    // BIGINT приходит из postgres.js строкой
    auto_off_until: toNumOrNull(row.auto_off_until),
    blocked_until: toNumOrNull(row.blocked_until)
  };
}

const rawDb = {
  // --- АДМИН И РЕГИСТРАЦИЯ ЮЗЕРОВ ---
  
  registerUser: async (userId, username) => {
    await ensureDbInit();
    return sql`
      INSERT INTO users (user_id, username)
      VALUES (${userId}, ${username})
      ON CONFLICT (user_id) 
      DO UPDATE SET username = EXCLUDED.username;
    `;
  },

  getAllUsers: async () => {
    await ensureDbInit();
    return sql`
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM users
        UNION
        SELECT user_id FROM user_settings
      ) AS combined_users;
    `;
  },

  getUserInfo: async (userId) => {
    await ensureDbInit();
    const res = await sql`SELECT username, created_at FROM users WHERE user_id = ${userId};`;
    return res[0] || null;
  },

  // --- НАСТРОЙКИ АВТООТВЕТА ---

  setCustomReply: async (userId, reply) => {
    await ensureDbInit();
    return sql`
      INSERT INTO user_settings (user_id, custom_reply)
      VALUES (${userId}, ${reply})
      ON CONFLICT (user_id) 
      DO UPDATE SET custom_reply = EXCLUDED.custom_reply;
    `;
  },

  getCustomReply: async (userId) => {
    await ensureDbInit();
    const res = await sql`SELECT custom_reply FROM user_settings WHERE user_id = ${userId};`;
    return res[0]?.custom_reply || null;
  },

  setSchedule: async (userId, startTime, endTime) => {
    await ensureDbInit();
    return sql`
      INSERT INTO user_settings (user_id, start_time, end_time)
      VALUES (${userId}, ${startTime}, ${endTime})
      ON CONFLICT (user_id) 
      DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time;
    `;
  },

  getSchedule: async (userId) => {
    await ensureDbInit();
    const res = await sql`SELECT start_time, end_time FROM user_settings WHERE user_id = ${userId};`;
    return res[0] || null;
  },

  // --- НАСТРОЙКИ РЕЖИМА АВТООТВЕТА ---
  
  setReplyMode: async (userId, mode) => {
    await ensureDbInit();
    return sql`
      INSERT INTO user_settings (user_id, reply_mode)
      VALUES (${userId}, ${mode})
      ON CONFLICT (user_id) 
      DO UPDATE SET reply_mode = EXCLUDED.reply_mode;
    `;
  },

  getReplyMode: async (userId) => {
    await ensureDbInit();
    const res = await sql`SELECT reply_mode FROM user_settings WHERE user_id = ${userId};`;
    return res[0]?.reply_mode || 'always';
  },

  // --- ПРИВЯЗКА К АККАУНТУ ---

  setAllowedUsername: async (userId, username) => {
    await ensureDbInit();
    return sql`
      INSERT INTO user_settings (user_id, allowed_username)
      VALUES (${userId}, ${username})
      ON CONFLICT (user_id) 
      DO UPDATE SET allowed_username = EXCLUDED.allowed_username;
    `;
  },

  getAllowedUsername: async (userId) => {
    await ensureDbInit();
    const res = await sql`SELECT allowed_username FROM user_settings WHERE user_id = ${userId};`;
    return res[0]?.allowed_username || null;
  },

  // --- РЕЖИМ ТАЙМЕРА ---

  setTimerMode: async (userId, enabled) => {
    await ensureDbInit();
    return sql`
      INSERT INTO user_settings (user_id, timer_mode)
      VALUES (${userId}, ${enabled})
      ON CONFLICT (user_id) 
      DO UPDATE SET timer_mode = EXCLUDED.timer_mode;
    `;
  },

  getTimerMode: async (userId) => {
    await ensureDbInit();
    const res = await sql`SELECT timer_mode FROM user_settings WHERE user_id = ${userId};`;
    return res[0]?.timer_mode === true;
  },

  // --- ВСЕ НАСТРОЙКИ ОДНИМ ЗАПРОСОМ ---

  getUserSettings: async (userId) => {
    await ensureDbInit();
    try {
      const res = await sql`
        SELECT custom_reply, start_time, end_time, allowed_username, timer_mode,
               timezone_offset_min, auto_off_until, blocked_until
        FROM user_settings WHERE user_id = ${userId};
      `;
      return normalizeSettings(res[0]);
    } catch (err) {
      // 42703 = undefined_column: новые колонки ещё не добавлены (миграция не прошла).
      // Не ломаем автоответ — читаем старые колонки, новые берём по умолчанию.
      if (err?.code !== '42703') throw err;
      const res = await sql`
        SELECT custom_reply, start_time, end_time, allowed_username, timer_mode
        FROM user_settings WHERE user_id = ${userId};
      `;
      return normalizeSettings(res[0]);
    }
  },

  setTimezoneOffset: async (userId, offsetMin) => {
    await ensureDbInit();
    return sql`
      INSERT INTO user_settings (user_id, timezone_offset_min)
      VALUES (${userId}, ${offsetMin})
      ON CONFLICT (user_id)
      DO UPDATE SET timezone_offset_min = EXCLUDED.timezone_offset_min;
    `;
  },

  setAutoOffUntil: async (userId, timestampMsOrNull) => {
    await ensureDbInit();
    return sql`
      INSERT INTO user_settings (user_id, auto_off_until)
      VALUES (${userId}, ${timestampMsOrNull})
      ON CONFLICT (user_id)
      DO UPDATE SET auto_off_until = EXCLUDED.auto_off_until;
    `;
  },

  setBlockedUntil: async (userId, timestampMsOrNull) => {
    await ensureDbInit();
    return sql`
      INSERT INTO user_settings (user_id, blocked_until)
      VALUES (${userId}, ${timestampMsOrNull})
      ON CONFLICT (user_id)
      DO UPDATE SET blocked_until = EXCLUDED.blocked_until;
    `;
  },

  // --- СОСТОЯНИЕ БОТА (global_stop и т.п.) ---

  getBotState: async (key) => {
    await ensureDbInit();
    const res = await sql`SELECT value FROM bot_state WHERE key = ${key};`;
    return res[0]?.value ?? null;
  },

  setBotState: async (key, value) => {
    await ensureDbInit();
    return sql`
      INSERT INTO bot_state (key, value, updated_at)
      VALUES (${key}, ${value}, CURRENT_TIMESTAMP)
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;
    `;
  },

  // --- РАБОТА С ПАУЗАМИ ---

  setPause: async (chatId, durationMs) => {
    await ensureDbInit();
    const pauseUntil = Date.now() + durationMs;
    return sql`
      INSERT INTO chat_pauses (chat_id, pause_until)
      VALUES (${chatId}, ${pauseUntil})
      ON CONFLICT (chat_id) 
      DO UPDATE SET pause_until = EXCLUDED.pause_until;
    `;
  },

  removePause: async (chatId) => {
    await ensureDbInit();
    return sql`DELETE FROM chat_pauses WHERE chat_id = ${chatId};`;
  },

  isPaused: async (chatId) => {
    await ensureDbInit();
    const res = await sql`SELECT pause_until FROM chat_pauses WHERE chat_id = ${chatId};`;
    if (!res[0]) return false;
    return Number(res[0].pause_until) > Date.now();
  },

  // --- ЛОГИ ОШИБОК ---
  
  saveErrorLog: async (chatId, errorType, errorDetails) => {
    await ensureDbInit();
    const message = `[${errorType}] ${errorDetails}`;
    return sql`
      INSERT INTO message_logs (chat_id, role, content)
      VALUES (${chatId}, 'error', ${message});
    `.catch(() => {});
  }
};

// Повторяем запрос при временных сбоях БД (холодный старт Neon, обрыв соединения).
// Все запросы — идемпотентные upsert/select, поэтому повтор безопасен.
async function withRetry(fn, args, tries = 4) {
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

export const db = Object.fromEntries(
  Object.entries(rawDb).map(([name, fn]) => [
    name,
    name === 'saveErrorLog' ? fn : (...args) => withRetry(fn, args)
  ])
);
