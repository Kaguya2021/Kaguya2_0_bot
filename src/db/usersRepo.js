// Репозиторий пользователей: users, user_settings (автоответ, расписание, таймзона, auto_off_until, blocked_until).
import { sql } from './client.js';
import { ensureSchema } from './migrations.js';
import { toNumOrNull } from './helpers.js';

export const DEFAULT_USER_SETTINGS = Object.freeze({
  custom_reply: null,
  start_time: null,
  end_time: null,
  allowed_username: null,
  timer_mode: false,
  timezone_offset_min: 0,
  auto_off_until: null,
  blocked_until: null,
  anti_delete_enabled: true
});

export function normalizeSettings(row) {
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
    blocked_until: toNumOrNull(row.blocked_until),
    // NULL/нет колонки (старая схема) -> включено по умолчанию
    anti_delete_enabled: row.anti_delete_enabled !== false
  };
}

export const usersRepo = {
  registerUser: async (userId, username) => {
    await ensureSchema();
    return sql`
      INSERT INTO users (user_id, username)
      VALUES (${userId}, ${username})
      ON CONFLICT (user_id) 
      DO UPDATE SET username = EXCLUDED.username;
    `;
  },

  getAllUsers: async () => {
    await ensureSchema();
    return sql`
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM users
        UNION
        SELECT user_id FROM user_settings
      ) AS combined_users;
    `;
  },

  getUserInfo: async (userId) => {
    await ensureSchema();
    const res = await sql`SELECT username, created_at FROM users WHERE user_id = ${userId};`;
    return res[0] || null;
  },

  // Карточка профиля в главном меню.
  getUserProfile: async (userId) => {
    await ensureSchema();
    const res = await sql`SELECT user_id, username, created_at FROM users WHERE user_id = ${String(userId)};`;
    return res[0] || null;
  },

  getUsersCount: async () => {
    await ensureSchema();
    const res = await sql`SELECT COUNT(*)::int AS count FROM users;`;
    return Number(res[0]?.count) || 0;
  },

  setCustomReply: async (userId, reply) => {
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, custom_reply)
      VALUES (${userId}, ${reply})
      ON CONFLICT (user_id) 
      DO UPDATE SET custom_reply = EXCLUDED.custom_reply;
    `;
  },

  getCustomReply: async (userId) => {
    await ensureSchema();
    const res = await sql`SELECT custom_reply FROM user_settings WHERE user_id = ${userId};`;
    return res[0]?.custom_reply || null;
  },

  setSchedule: async (userId, startTime, endTime) => {
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, start_time, end_time)
      VALUES (${userId}, ${startTime}, ${endTime})
      ON CONFLICT (user_id) 
      DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time;
    `;
  },

  getSchedule: async (userId) => {
    await ensureSchema();
    const res = await sql`SELECT start_time, end_time FROM user_settings WHERE user_id = ${userId};`;
    return res[0] || null;
  },

  setReplyMode: async (userId, mode) => {
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, reply_mode)
      VALUES (${userId}, ${mode})
      ON CONFLICT (user_id) 
      DO UPDATE SET reply_mode = EXCLUDED.reply_mode;
    `;
  },

  getReplyMode: async (userId) => {
    await ensureSchema();
    const res = await sql`SELECT reply_mode FROM user_settings WHERE user_id = ${userId};`;
    return res[0]?.reply_mode || 'always';
  },

  setAllowedUsername: async (userId, username) => {
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, allowed_username)
      VALUES (${userId}, ${username})
      ON CONFLICT (user_id) 
      DO UPDATE SET allowed_username = EXCLUDED.allowed_username;
    `;
  },

  getAllowedUsername: async (userId) => {
    await ensureSchema();
    const res = await sql`SELECT allowed_username FROM user_settings WHERE user_id = ${userId};`;
    return res[0]?.allowed_username || null;
  },

  setTimerMode: async (userId, enabled) => {
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, timer_mode)
      VALUES (${userId}, ${enabled})
      ON CONFLICT (user_id) 
      DO UPDATE SET timer_mode = EXCLUDED.timer_mode;
    `;
  },

  getTimerMode: async (userId) => {
    await ensureSchema();
    const res = await sql`SELECT timer_mode FROM user_settings WHERE user_id = ${userId};`;
    return res[0]?.timer_mode === true;
  },

  getUserSettings: async (userId) => {
    await ensureSchema();
    try {
      const res = await sql`
        SELECT custom_reply, start_time, end_time, allowed_username, timer_mode,
               timezone_offset_min, auto_off_until, blocked_until, anti_delete_enabled
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
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, timezone_offset_min)
      VALUES (${userId}, ${offsetMin})
      ON CONFLICT (user_id)
      DO UPDATE SET timezone_offset_min = EXCLUDED.timezone_offset_min;
    `;
  },

  setAutoOffUntil: async (userId, timestampMsOrNull) => {
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, auto_off_until)
      VALUES (${userId}, ${timestampMsOrNull})
      ON CONFLICT (user_id)
      DO UPDATE SET auto_off_until = EXCLUDED.auto_off_until;
    `;
  },

  setBlockedUntil: async (userId, timestampMsOrNull) => {
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, blocked_until)
      VALUES (${userId}, ${timestampMsOrNull})
      ON CONFLICT (user_id)
      DO UPDATE SET blocked_until = EXCLUDED.blocked_until;
    `;
  },

  setAntiDeleteEnabled: async (userId, enabled) => {
    await ensureSchema();
    return sql`
      INSERT INTO user_settings (user_id, anti_delete_enabled)
      VALUES (${userId}, ${enabled === true})
      ON CONFLICT (user_id)
      DO UPDATE SET anti_delete_enabled = EXCLUDED.anti_delete_enabled;
    `;
  }
};
