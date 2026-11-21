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

  // --- Фаза 2: фидбек из группы обсуждений и черновики постов (только CREATE/ADD IF NOT EXISTS) ---

  const logColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'message_logs';
  `;
  if (!logColumns.some((r) => r.column_name === 'status')) {
    await sql`ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'new'`;
    console.log('🛠️ DB: добавлена колонка message_logs.status');
  }

  await sql`
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
    );
  `;

  await sql`
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
    );
  `;

  isDbInitialized = true;
}

// Чистое завершение пула (для локальных CLI-скриптов, чтобы процесс не зависал).
export async function closeDb() {
  await sql.end({ timeout: 5 });
}

const COMMENT_STATUSES = new Set(['new', 'processed', 'ignored']);
const DRAFT_STATUSES = new Set(['pending_approval', 'publishing', 'published', 'cancelled', 'failed']);

function assertStatus(allowed, status) {
  if (!allowed.has(status)) throw new Error(`Недопустимый статус: ${status}`);
}

// null — "все"; массив — только валидные положительные целые.
function normalizeIds(ids) {
  if (!Array.isArray(ids)) return null;
  return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

const cut = (v, max) => (v === null || v === undefined ? null : String(v).slice(0, max));
const strOrNull = (v) => (v === null || v === undefined ? null : String(v));

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
  },

  // --- КОММЕНТАРИИ ИЗ ГРУППЫ ОБСУЖДЕНИЙ ---

  // Идемпотентно: повтор вебхука с тем же (chat_id, message_id) ничего не меняет.
  saveChannelComment: async (c) => {
    await ensureDbInit();
    return sql`
      INSERT INTO channel_comments
        (chat_id, message_id, reply_to_message_id, thread_id, user_id, username, first_name, text)
      VALUES (
        ${String(c.chat_id)}, ${c.message_id}, ${c.reply_to_message_id ?? null}, ${c.thread_id ?? null},
        ${strOrNull(c.user_id)}, ${cut(c.username, 100)}, ${cut(c.first_name, 100)}, ${c.text}
      )
      ON CONFLICT (chat_id, message_id) DO NOTHING;
    `;
  },

  getNewComments: async (limit = 100) => {
    await ensureDbInit();
    return sql`
      SELECT id, chat_id, message_id, reply_to_message_id, thread_id, user_id, username, first_name, text, created_at
      FROM channel_comments WHERE status = 'new'
      ORDER BY id ASC LIMIT ${limit};
    `;
  },

  // ids не переданы — помечает все 'new'. Возвращает число обновлённых строк.
  markCommentsStatus: async (ids, status) => {
    await ensureDbInit();
    assertStatus(COMMENT_STATUSES, status);
    const list = normalizeIds(ids);
    if (list && !list.length) return 0;
    const res = list
      ? await sql`UPDATE channel_comments SET status = ${status} WHERE id = ANY(${list}::int[]) RETURNING id;`
      : await sql`UPDATE channel_comments SET status = ${status} WHERE status = 'new' RETURNING id;`;
    return res.length;
  },

  // --- ОШИБКИ БОТА (message_logs.role = 'error') ---

  getNewErrorLogs: async (limit = 100) => {
    await ensureDbInit();
    return sql`
      SELECT id, chat_id, content, created_at
      FROM message_logs WHERE role = 'error' AND (status = 'new' OR status IS NULL)
      ORDER BY id ASC LIMIT ${limit};
    `;
  },

  markErrorLogsStatus: async (ids, status) => {
    await ensureDbInit();
    assertStatus(COMMENT_STATUSES, status);
    const list = normalizeIds(ids);
    if (list && !list.length) return 0;
    const res = list
      ? await sql`UPDATE message_logs SET status = ${status} WHERE role = 'error' AND id = ANY(${list}::int[]) RETURNING id;`
      : await sql`UPDATE message_logs SET status = ${status} WHERE role = 'error' AND (status = 'new' OR status IS NULL) RETURNING id;`;
    return res.length;
  },

  // --- ЧЕРНОВИКИ ПОСТОВ В КАНАЛ (Human-in-the-loop) ---

  createPostDraft: async ({ htmlText, buttons, mediaType, mediaFileId, createdBy }) => {
    await ensureDbInit();
    const res = await sql`
      INSERT INTO post_drafts (html_text, buttons_json, media_type, media_file_id, created_by)
      VALUES (
        ${htmlText}, ${buttons && buttons.length ? sql.json(buttons) : null},
        ${mediaType || null}, ${mediaFileId || null}, ${strOrNull(createdBy)}
      )
      RETURNING *;
    `;
    return res[0];
  },

  getPostDraft: async (id) => {
    await ensureDbInit();
    const res = await sql`SELECT * FROM post_drafts WHERE id = ${id};`;
    return res[0] || null;
  },

  // Атомарный захват: из двух параллельных кликов строку получит только один.
  claimDraftForPublishing: async (id) => {
    await ensureDbInit();
    const res = await sql`
      UPDATE post_drafts SET status = 'publishing'
      WHERE id = ${id} AND status = 'pending_approval'
      RETURNING *;
    `;
    return res[0] || null;
  },

  markDraftPublished: async (id, { approvedBy, publishedMessageId }) => {
    await ensureDbInit();
    const res = await sql`
      UPDATE post_drafts
      SET status = 'published', approved_by = ${strOrNull(approvedBy)},
          published_message_id = ${publishedMessageId ?? null}, published_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
      RETURNING *;
    `;
    return res[0] || null;
  },

  // fromStatus (опционально) — атомарный переход только из этого статуса. Возвращает строку или null.
  markDraftStatus: async (id, status, approvedBy = null, fromStatus = null) => {
    await ensureDbInit();
    assertStatus(DRAFT_STATUSES, status);
    const by = strOrNull(approvedBy);
    const res = fromStatus
      ? await sql`
          UPDATE post_drafts SET status = ${status}, approved_by = COALESCE(${by}, approved_by)
          WHERE id = ${id} AND status = ${fromStatus} RETURNING *;`
      : await sql`
          UPDATE post_drafts SET status = ${status}, approved_by = COALESCE(${by}, approved_by)
          WHERE id = ${id} RETURNING *;`;
    return res[0] || null;
  }
};

// Повторяем запрос при временных сбоях БД (холодный старт Neon, обрыв соединения).
// Повторяем только идемпотентные upsert/select/update. INSERT черновика и атомарный захват
// не повторяем: повтор после "потерянного" ответа дал бы дубль черновика или ложный отказ.
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

const NO_RETRY = new Set(['saveErrorLog', 'createPostDraft', 'claimDraftForPublishing']);

export const db = Object.fromEntries(
  Object.entries(rawDb).map(([name, fn]) => [
    name,
    NO_RETRY.has(name) ? fn : (...args) => withRetry(fn, args)
  ])
);
