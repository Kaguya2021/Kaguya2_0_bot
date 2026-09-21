import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 10
});

let isDbInitialized = false;

async function ensureDbInit() {
  if (isDbInitialized) return;
  try {
    const client = await pool.connect();
    
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

      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reply_mode VARCHAR(20) DEFAULT 'always';
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS allowed_username VARCHAR(100);
      ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timer_mode BOOLEAN DEFAULT false;

      CREATE TABLE IF NOT EXISTS users (
        user_id VARCHAR(50) PRIMARY KEY,
        username VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chat_pauses (
        chat_id VARCHAR(50) PRIMARY KEY,
        pause_until BIGINT
      );

      CREATE TABLE IF NOT EXISTS error_logs (
        id SERIAL PRIMARY KEY,
        chat_id VARCHAR(50),
        error_type VARCHAR(50),
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    client.release();
    isDbInitialized = true;
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
}

export const db = {
  // --- АДМИН И РЕГИСТРАЦИЯ ЮЗЕРОВ ---
  registerUser: async (userId, username) => {
    await ensureDbInit();
    const query = `
      INSERT INTO users (user_id, username)
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET username = EXCLUDED.username;
    `;
    return pool.query(query, [userId, username]).catch((e) => db.saveErrorLog(userId, 'DB_REGISTER_USER', e.message));
  },

  getAllUsers: async () => {
    await ensureDbInit();
    const query = `
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM users
        UNION
        SELECT user_id FROM user_settings
      ) AS combined_users;
    `;
    const res = await pool.query(query).catch((e) => {
      db.saveErrorLog('SYSTEM', 'DB_GET_ALL_USERS', e.message);
      return { rows: [] };
    });
    return res.rows;
  },

  getUserInfo: async (userId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT username, created_at FROM users WHERE user_id = $1;', [userId]).catch((e) => {
      db.saveErrorLog(userId, 'DB_GET_USER_INFO', e.message);
      return { rows: [] };
    });
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
    return pool.query(query, [userId, reply]).catch((e) => db.saveErrorLog(userId, 'DB_SET_CUSTOM_REPLY', e.message));
  },

  getCustomReply: async (userId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT custom_reply FROM user_settings WHERE user_id = $1;', [userId]).catch((e) => {
      db.saveErrorLog(userId, 'DB_GET_CUSTOM_REPLY', e.message);
      return { rows: [] };
    });
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
    return pool.query(query, [userId, startTime, endTime]).catch((e) => db.saveErrorLog(userId, 'DB_SET_SCHEDULE', e.message));
  },

  getSchedule: async (userId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT start_time, end_time FROM user_settings WHERE user_id = $1;', [userId]).catch((e) => {
      db.saveErrorLog(userId, 'DB_GET_SCHEDULE', e.message);
      return { rows: [] };
    });
    return res.rows[0] || null;
  },

  setAllowedUsername: async (userId, username) => {
    await ensureDbInit();
    const query = `
      INSERT INTO user_settings (user_id, allowed_username)
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET allowed_username = EXCLUDED.allowed_username;
    `;
    return pool.query(query, [userId, username]).catch((e) => db.saveErrorLog(userId, 'DB_SET_ALLOWED_USERNAME', e.message));
  },

  getAllowedUsername: async (userId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT allowed_username FROM user_settings WHERE user_id = $1;', [userId]).catch((e) => {
      db.saveErrorLog(userId, 'DB_GET_ALLOWED_USERNAME', e.message);
      return { rows: [] };
    });
    return res.rows[0]?.allowed_username || null;
  },

  setTimerMode: async (userId, enabled) => {
    await ensureDbInit();
    const query = `
      INSERT INTO user_settings (user_id, timer_mode)
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET timer_mode = EXCLUDED.timer_mode;
    `;
    return pool.query(query, [userId, enabled]).catch((e) => db.saveErrorLog(userId, 'DB_SET_TIMER_MODE', e.message));
  },

  getTimerMode: async (userId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT timer_mode FROM user_settings WHERE user_id = $1;', [userId]).catch((e) => {
      db.saveErrorLog(userId, 'DB_GET_TIMER_MODE', e.message);
      return { rows: [] };
    });
    return res.rows[0]?.timer_mode === true;
  },

  isPaused: async (chatId) => {
    await ensureDbInit();
    const res = await pool.query('SELECT pause_until FROM chat_pauses WHERE chat_id = $1;', [chatId]).catch((e) => {
      db.saveErrorLog(chatId, 'DB_IS_PAUSED', e.message);
      return { rows: [] };
    });
    if (!res.rows[0]) return false;
    return Number(res.rows[0].pause_until) > Date.now();
  },

  // --- ТОЛЬКО ЛОГИ ОШИБОК ---
  saveErrorLog: async (chatId, errorType, errorDetails) => {
    await ensureDbInit();
    const query = `
      INSERT INTO error_logs (chat_id, error_type, details)
      VALUES ($1, $2, $3);
    `;
    return pool.query(query, [String(chatId), String(errorType), String(errorDetails)]).catch(() => {});
  }
};
