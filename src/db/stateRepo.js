// Репозиторий состояния: bot_state (global_stop), chat_pauses, message_logs (ошибки бота).
import { sql } from './client.js';
import { ensureSchema } from './migrations.js';
import { assertStatus, normalizeIds, COMMENT_STATUSES } from './helpers.js';

export const stateRepo = {
  getBotState: async (key) => {
    await ensureSchema();
    const res = await sql`SELECT value FROM bot_state WHERE key = ${key};`;
    return res[0]?.value ?? null;
  },

  setBotState: async (key, value) => {
    await ensureSchema();
    return sql`
      INSERT INTO bot_state (key, value, updated_at)
      VALUES (${key}, ${value}, CURRENT_TIMESTAMP)
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;
    `;
  },

  setPause: async (chatId, durationMs) => {
    await ensureSchema();
    const pauseUntil = Date.now() + durationMs;
    return sql`
      INSERT INTO chat_pauses (chat_id, pause_until)
      VALUES (${chatId}, ${pauseUntil})
      ON CONFLICT (chat_id) 
      DO UPDATE SET pause_until = EXCLUDED.pause_until;
    `;
  },

  removePause: async (chatId) => {
    await ensureSchema();
    return sql`DELETE FROM chat_pauses WHERE chat_id = ${chatId};`;
  },

  isPaused: async (chatId) => {
    await ensureSchema();
    const res = await sql`SELECT pause_until FROM chat_pauses WHERE chat_id = ${chatId};`;
    if (!res[0]) return false;
    return Number(res[0].pause_until) > Date.now();
  },

  saveErrorLog: async (chatId, errorType, errorDetails) => {
    await ensureSchema();
    const message = `[${errorType}] ${errorDetails}`;
    return sql`
      INSERT INTO message_logs (chat_id, role, content)
      VALUES (${chatId}, 'error', ${message});
    `.catch(() => {});
  },

  getNewErrorLogs: async (limit = 100) => {
    await ensureSchema();
    return sql`
      SELECT id, chat_id, content, created_at
      FROM message_logs WHERE role = 'error' AND (status = 'new' OR status IS NULL)
      ORDER BY id ASC LIMIT ${limit};
    `;
  },

  markErrorLogsStatus: async (ids, status) => {
    await ensureSchema();
    assertStatus(COMMENT_STATUSES, status);
    const list = normalizeIds(ids);
    if (list && !list.length) return 0;
    const res = list
      ? await sql`UPDATE message_logs SET status = ${status} WHERE role = 'error' AND id = ANY(${list}::int[]) RETURNING id;`
      : await sql`UPDATE message_logs SET status = ${status} WHERE role = 'error' AND (status = 'new' OR status IS NULL) RETURNING id;`;
    return res.length;
  }
};
