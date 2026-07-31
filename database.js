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

async function ensureDbInit() {
  if (isDbInitialized) return;
  try {
    const client = await pool.connect();
    
    // Таблица настроек пользователей
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id VARCHAR(50) PRIMARY KEY,
        custom_reply TEXT,
        start_time VARCHAR(10),
        end_time VARCHAR(10)
      );
    `);

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

    // Таблица логов сообщений
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
    console.error('⚠️ Ошибка инициализации БД (работаем в режиме памяти):', err.message);
  }
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
    return pool.query(query, [userId, username]);
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
    const res = await pool.query(query);
    return res.rows;
  },

  // 3. Получение подробной информации для команды /info <id>
  getUserInfo: async (userId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT username, created_at FROM users WHERE user_id = $1;', [userId]);
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
    return pool.query(query, [userId, reply]);
  },

  getCustomReply: async (userId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT custom_reply FROM user_settings WHERE user_id = $1;', [userId]);
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
    return pool.query(query, [userId, startTime, endTime]);
  },

  getSchedule: async (userId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT start_time, end_time FROM user_settings WHERE user_id = $1;', [userId]);
    return res.rows[0] || null;
  },

  setPause: async (chatId, durationMs) => {
    await ensureDbInit();
    const pauseUntil = Date.now() + durationMs;
    const query = `
      INSERT INTO chat_pauses (chat_id, pause_until)
      VALUES ($1, $2)
      ON CONFLICT (chat_id) 
      DO UPDATE SET pause_until = EXCLUDED.pause_until;
    `;
    return pool.query(query, [chatId, pauseUntil]);
  },

  removePause: async (chatId) => {
    await ensureDbInit();
    const query = `DELETE FROM chat_pauses WHERE chat_id = $1;`;
    return pool.query(query, [chatId]);
  },

  isPaused: async (chatId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT pause_until FROM chat_pauses WHERE chat_id = $1;', [chatId]);
    if (!res.rows[0]) return false;
    return Number(res.rows[0].pause_until) > Date.now();
  },

  saveMessage: async (chatId, role, content) => {
    await ensureDbInit();
    const query = `
      INSERT INTO message_logs (chat_id, role, content)
      VALUES ($1, $2, $3);
    `;
    return pool.query(query, [chatId, role, content]);
  }
};
