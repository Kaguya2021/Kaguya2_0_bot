import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

// Отключаем консоль, чтобы Render не тратил ресурсы на логирование
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};

// Подключение к Neon DB через библиотеку 'postgres'
const sql = postgres(process.env.DATABASE_URL, {
  ssl: 'require',
  connect_timeout: 10,
  idle_timeout: 20,
  max: 10 // Безопасный лимит подключений для бесплатного тарифа
});

let isDbInitialized = false;

// Автоматическая подготовка таблиц
async function ensureDbInit() {
  if (isDbInitialized || !process.env.DATABASE_URL) return;

  try {
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

    try { await sql`ALTER TABLE user_settings ADD COLUMN reply_mode VARCHAR(20) DEFAULT 'always';`; } catch (e) {}
    try { await sql`ALTER TABLE user_settings ADD COLUMN allowed_username VARCHAR(100);`; } catch (e) {}
    try { await sql`ALTER TABLE user_settings ADD COLUMN timer_mode BOOLEAN DEFAULT false;`; } catch (e) {}

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

    isDbInitialized = true;
  } catch (err) {}
}

export const db = {
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
