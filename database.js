import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Создаем пул соединений с таймаутом
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 10
});

// Безопасная инициализация таблиц без падения сервера
let isDbInitialized = false;
let lastFailTime = 0;
const INIT_RETRY_COOLDOWN_MS = 30 * 1000; // не долбим БД чаще раза в 30 сек, если она недоступна

async function ensureDbInit() {
  if (isDbInitialized) return;

  // Если БД недавно уже не отвечала — не пытаемся снова, просто выходим сразу
  // (иначе каждый await db.xxx() в обработчике сообщения будет ждать connectionTimeoutMillis)
  if (Date.now() - lastFailTime < INIT_RETRY_COOLDOWN_MS) return;

  if (!process.env.DATABASE_URL) {
    lastFailTime = Date.now();
    console.error('⚠️ DATABASE_URL не задан — работаем в режиме памяти');
    return;
  }

  try {
    const client = await pool.connect();
    
    // Таблица настроек пользователей (ДОБАВЛЕН reply_mode)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id VARCHAR(50) PRIMARY KEY,
        custom_reply TEXT,
        start_time VARCHAR(10),
        end_time VARCHAR(10),
        reply_mode VARCHAR(20) DEFAULT 'always',
        allowed_username VARCHAR(100),
        timer_mode BOOLEAN DEFAULT false
      );
    `);

    // Безопасное добавление колонки, если таблица уже была создана ранее
    try {
      await client.query(`ALTER TABLE user_settings ADD COLUMN reply_mode VARCHAR(20) DEFAULT 'always';`);
    } catch (e) {
      // Игнорируем ошибку 42701 (duplicate_column), если колонка уже есть
    }

    try {
      await client.query(`ALTER TABLE user_settings ADD COLUMN allowed_username VARCHAR(100);`);
    } catch (e) {
      // Игнорируем ошибку 42701 (duplicate_column), если колонка уже есть
    }

    try {
      await client.query(`ALTER TABLE user_settings ADD COLUMN timer_mode BOOLEAN DEFAULT false;`);
    } catch (e) {
      // Игнорируем ошибку 42701 (duplicate_column), если колонка уже есть
    }

    // Таблица зарегистрированных пользователей (для рассылок)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id VARCHAR(50) PRIMARY KEY,
        username VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Таблица паузы чатов
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_pauses (
        chat_id VARCHAR(50) PRIMARY KEY,
        pause_until BIGINT
      );
    `);

    // Таблица логов сообщений и ошибок
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_logs (
        id SERIAL PRIMARY KEY,
        chat_id VARCHAR(50),
        role VARCHAR(20),
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    client.release();
    isDbInitialized = true;
    console.log('✅ База данных готова к работе');
  } catch (err) {
    lastFailTime = Date.now();
    console.error('⚠️ Ошибка инициализации БД (работаем в режиме памяти):', err.message);
  }
}

// Обёртка над pool.query: если БД уже помечена недоступной — сразу кидаем ошибку,
// не дожидаясь connectionTimeoutMillis (5 сек) на реальном сетевом запросе.
// Это то, из-за чего бот "очень долго отвечал", когда БД недоступна/просрочена.
function safeQuery(text, params) {
  if (!isDbInitialized) {
    return Promise.reject(new Error('DB недоступна (пропущен запрос без реального подключения)'));
  }
  return pool.query(text, params);
}

export const db = {
  // --- АДМИН И РЕГИСТРАЦИЯ ЮЗЕРОВ ---
  
  // 1. Регистрация / Обновление юзера
  registerUser: async (userId, username) => {
    await ensureDbInit();
    const query = `
      INSERT INTO users (user_id, username)
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET username = EXCLUDED.username;
    `;
    return safeQuery(query, [userId, username]);
  },

  // 2. Получение ВСЕХ юзеров для рассылки (/post и /m)
  getAllUsers: async () => {
    await ensureDbInit();
    const query = `
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM users
        UNION
        SELECT user_id FROM user_settings
      ) AS combined_users;
    `;
    const res = await safeQuery(query);
    return res.rows;
  },

  // 3. Получение подробной информации для команды /info <id>
  getUserInfo: async (userId) => {
    await ensureDbInit();
    const res = await safeQuery('SELECT username, created_at FROM users WHERE user_id = $1;', [userId]);
    return res.rows[0] || null;
  },

  // --- НАСТРОЙКИ АВТООТВЕТА ---

  setCustomReply: async (userId, reply) => {
    await ensureDbInit();
    const query = `
      INSERT INTO user_settings (user_id, custom_reply)
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET custom_reply = EXCLUDED.custom_reply;
    `;
    return safeQuery(query, [userId, reply]);
  },

  getCustomReply: async (userId) => {
    await ensureDbInit();
    const res = await safeQuery('SELECT custom_reply FROM user_settings WHERE user_id = $1;', [userId]);
    return res.rows[0]?.custom_reply || null;
  },

  setSchedule: async (userId, startTime, endTime) => {
    await ensureDbInit();
    const query = `
      INSERT INTO user_settings (user_id, start_time, end_time)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) 
      DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time;
    `;
    return safeQuery(query, [userId, startTime, endTime]);
  },

  getSchedule: async (userId) => {
    await ensureDbInit();
    const res = await safeQuery('SELECT start_time, end_time FROM user_settings WHERE user_id = $1;', [userId]);
    return res.rows[0] || null;
  },

  // --- НАСТРОЙКИ РЕЖИМА АВТООТВЕТА (НОВОЕ) ---
  
  setReplyMode: async (userId, mode) => {
    await ensureDbInit();
    const query = `
      INSERT INTO user_settings (user_id, reply_mode)
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET reply_mode = EXCLUDED.reply_mode;
    `;
    return safeQuery(query, [userId, mode]);
  },

  getReplyMode: async (userId) => {
    await ensureDbInit();
    const res = await safeQuery('SELECT reply_mode FROM user_settings WHERE user_id = $1;', [userId]);
    // Возвращаем 'always' по умолчанию, если ничего не найдено
    return res.rows[0]?.reply_mode || 'always';
  },

  // --- ПРИВЯЗКА АВТООТВЕТА К КОНКРЕТНОМУ АККАУНТУ (НОВОЕ) ---

  setAllowedUsername: async (userId, username) => {
    await ensureDbInit();
    const query = `
      INSERT INTO user_settings (user_id, allowed_username)
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET allowed_username = EXCLUDED.allowed_username;
    `;
    return safeQuery(query, [userId, username]);
  },

  getAllowedUsername: async (userId) => {
    await ensureDbInit();
    const res = await safeQuery('SELECT allowed_username FROM user_settings WHERE user_id = $1;', [userId]);
    return res.rows[0]?.allowed_username || null;
  },

  // --- РЕЖИМ "ТАЙМЕР 15 МИН" (переключается кнопкой в меню) ---

  setTimerMode: async (userId, enabled) => {
    await ensureDbInit();
    const query = `
      INSERT INTO user_settings (user_id, timer_mode)
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET timer_mode = EXCLUDED.timer_mode;
    `;
    return safeQuery(query, [userId, enabled]);
  },

  getTimerMode: async (userId) => {
    await ensureDbInit();
    const res = await safeQuery('SELECT timer_mode FROM user_settings WHERE user_id = $1;', [userId]);
    return res.rows[0]?.timer_mode === true;
  },

  // --- РАБОТА С ПАУЗАМИ ---

  setPause: async (chatId, durationMs) => {
    await ensureDbInit();
    const pauseUntil = Date.now() + durationMs;
    const query = `
      INSERT INTO chat_pauses (chat_id, pause_until)
      VALUES ($1, $2)
      ON CONFLICT (chat_id) 
      DO UPDATE SET pause_until = EXCLUDED.pause_until;
    `;
    return safeQuery(query, [chatId, pauseUntil]);
  },

  removePause: async (chatId) => {
    await ensureDbInit();
    const query = `DELETE FROM chat_pauses WHERE chat_id = $1;`;
    return safeQuery(query, [chatId]);
  },

  isPaused: async (chatId) => {
    await ensureDbInit();
    const res = await safeQuery('SELECT pause_until FROM chat_pauses WHERE chat_id = $1;', [chatId]);
    if (!res.rows[0]) return false;
    return Number(res.rows[0].pause_until) > Date.now();
  },

  // --- ЭКОНОМНОЕ ЛОГИРОВАНИЕ (ТОЛЬКО ОШИБКИ И БАНЫ) ---
  
  saveErrorLog: async (chatId, errorType, errorDetails) => {
    await ensureDbInit();
    const query = `
      INSERT INTO message_logs (chat_id, role, content)
      VALUES ($1, $2, $3);
    `;
    const message = `[${errorType}] ${errorDetails}`;
    return safeQuery(query, [chatId, 'error', message]).catch(console.error);
  }
};
