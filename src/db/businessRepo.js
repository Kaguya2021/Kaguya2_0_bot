// Репозиторий Telegram Business: подключения (права), правила чатов (мут/стикеры)
// и кэш бизнес-сообщений для анти-удаления/анти-редактирования.
import { sql } from './client.js';
import { ensureSchema } from './migrations.js';
import { cut, strOrNull, normalizeIds } from './helpers.js';

// Neon Free (512 МБ): храним только текст/краткое описание медиа.
export const MAX_CACHED_CONTENT = 4000;
export const MAX_AUTO_AI_PROMPT = 500;

function rowToRule(r) {
  return {
    isMuted: r.is_muted === true,
    deleteStickersGifs: r.delete_stickers_gifs === true,
    autoAiPrompt: r.auto_ai_prompt ?? null,
    kawaiiEnabled: r.kawaii_enabled === true
  };
}


export const businessRepo = {
  // info: { connectionId, ownerId, userChatId, canReply, canDeleteSent, canDeleteAll, isEnabled }
  upsertBusinessConnection: async (info) => {
    await ensureSchema();
    return sql`
      INSERT INTO business_connections (
        connection_id, owner_id, user_chat_id, can_reply,
        can_delete_sent_messages, can_delete_all_messages, is_enabled, updated_at
      )
      VALUES (
        ${String(info.connectionId)}, ${String(info.ownerId)}, ${strOrNull(info.userChatId)},
        ${info.canReply === true}, ${info.canDeleteSent === true}, ${info.canDeleteAll === true},
        ${info.isEnabled !== false}, CURRENT_TIMESTAMP
      )
      ON CONFLICT (connection_id) DO UPDATE SET
        owner_id = EXCLUDED.owner_id,
        user_chat_id = EXCLUDED.user_chat_id,
        can_reply = EXCLUDED.can_reply,
        can_delete_sent_messages = EXCLUDED.can_delete_sent_messages,
        can_delete_all_messages = EXCLUDED.can_delete_all_messages,
        is_enabled = EXCLUDED.is_enabled,
        updated_at = CURRENT_TIMESTAMP;
    `;
  },

  getBusinessConnection: async (connectionId) => {
    await ensureSchema();
    const res = await sql`
      SELECT connection_id, owner_id, user_chat_id, can_reply,
             can_delete_sent_messages, can_delete_all_messages, is_enabled
      FROM business_connections WHERE connection_id = ${String(connectionId)};
    `;
    const r = res[0];
    if (!r) return null;
    return {
      connectionId: r.connection_id,
      ownerId: r.owner_id,
      userChatId: r.user_chat_id ?? null,
      canReply: r.can_reply === true,
      canDeleteSent: r.can_delete_sent_messages === true,
      canDeleteAll: r.can_delete_all_messages === true,
      isEnabled: r.is_enabled !== false
    };
  },

  // Статус подключения бизнес-бота для экрана меню (самая свежая активная запись владельца).
  getOwnerConnectionStatus: async (ownerId) => {
    await ensureSchema();
    const res = await sql`
      SELECT can_reply, can_delete_sent_messages, can_delete_all_messages, updated_at
      FROM business_connections
      WHERE owner_id = ${String(ownerId)} AND is_enabled = true
      ORDER BY updated_at DESC LIMIT 1;
    `;
    const r = res[0];
    if (!r) return { connected: false, canReply: false, canDeleteSent: false, canDeleteAll: false, updatedAt: null };
    return {
      connected: true,
      canReply: r.can_reply === true,
      canDeleteSent: r.can_delete_sent_messages === true,
      canDeleteAll: r.can_delete_all_messages === true,
      updatedAt: r.updated_at ?? null
    };
  },

  // patch: { isMuted, deleteStickersGifs, autoAiPrompt, kawaiiEnabled }.
  // undefined — не менять поле. autoAiPrompt: null — очистить (NULL), строка — записать (до 500 символов).
  setChatRule: async (ownerId, chatId, { isMuted, deleteStickersGifs, autoAiPrompt, kawaiiEnabled } = {}) => {
    await ensureSchema();
    const muted = typeof isMuted === 'boolean' ? isMuted : null;
    const stickers = typeof deleteStickersGifs === 'boolean' ? deleteStickersGifs : null;
    const kawaii = typeof kawaiiEnabled === 'boolean' ? kawaiiEnabled : null;
    // Явный null нельзя склеить через COALESCE (иначе .unautoai не очистит поле) — отдельный флаг.
    const aiTouch = autoAiPrompt !== undefined;
    const aiValue = typeof autoAiPrompt === 'string' && autoAiPrompt.trim()
      ? autoAiPrompt.trim().slice(0, MAX_AUTO_AI_PROMPT)
      : null;
    const res = await sql`
      INSERT INTO chat_rules (owner_id, chat_id, is_muted, delete_stickers_gifs, auto_ai_prompt, kawaii_enabled, updated_at)
      VALUES (
        ${String(ownerId)}, ${String(chatId)}, ${muted ?? false}, ${stickers ?? false},
        ${aiValue}::text, ${kawaii ?? false}, CURRENT_TIMESTAMP
      )
      ON CONFLICT (owner_id, chat_id) DO UPDATE SET
        is_muted = COALESCE(${muted}::boolean, chat_rules.is_muted),
        delete_stickers_gifs = COALESCE(${stickers}::boolean, chat_rules.delete_stickers_gifs),
        auto_ai_prompt = CASE WHEN ${aiTouch}::boolean THEN ${aiValue}::text ELSE chat_rules.auto_ai_prompt END,
        kawaii_enabled = COALESCE(${kawaii}::boolean, chat_rules.kawaii_enabled),
        updated_at = CURRENT_TIMESTAMP
      RETURNING is_muted, delete_stickers_gifs, auto_ai_prompt, kawaii_enabled;
    `;
    const r = res[0];
    return r ? rowToRule(r) : null;
  },

  getAllActiveChatRules: async () => {
    await ensureSchema();
    const rows = await sql`
      SELECT owner_id, chat_id, is_muted, delete_stickers_gifs, auto_ai_prompt, kawaii_enabled
      FROM chat_rules
      WHERE is_muted = true OR delete_stickers_gifs = true OR auto_ai_prompt IS NOT NULL OR kawaii_enabled = true;
    `;
    return rows.map((r) => ({ ownerId: r.owner_id, chatId: r.chat_id, ...rowToRule(r) }));
  },

  // msg: { connectionId, chatId, messageId, ownerId, senderId, senderName, senderUsername, msgType, content }
  // Upsert: при редактировании обновляет content/msg_type, created_at не трогает.
  saveCachedBusinessMessage: async (msg) => {
    await ensureSchema();
    return sql`
      INSERT INTO business_messages_cache (
        connection_id, chat_id, message_id, owner_id, sender_id,
        sender_name, sender_username, msg_type, content
      )
      VALUES (
        ${String(msg.connectionId)}, ${String(msg.chatId)}, ${Number(msg.messageId)}, ${String(msg.ownerId)},
        ${strOrNull(msg.senderId)}, ${cut(msg.senderName, 200)}, ${cut(msg.senderUsername, 100)},
        ${cut(msg.msgType || 'text', 30)}, ${cut(msg.content, MAX_CACHED_CONTENT)}
      )
      ON CONFLICT (connection_id, chat_id, message_id) DO UPDATE SET
        msg_type = EXCLUDED.msg_type,
        content = EXCLUDED.content;
    `;
  },

  getCachedBusinessMessages: async (connectionId, chatId, messageIds) => {
    const ids = normalizeIds(messageIds) || [];
    if (!ids.length) return [];
    await ensureSchema();
    const rows = await sql`
      SELECT message_id, owner_id, sender_id, sender_name, sender_username, msg_type, content, created_at
      FROM business_messages_cache
      WHERE connection_id = ${String(connectionId)} AND chat_id = ${String(chatId)}
        AND message_id = ANY(${ids}::bigint[])
      ORDER BY message_id ASC;
    `;
    return rows.map((r) => ({ ...r, message_id: Number(r.message_id) }));
  },

  // Последние message_id чата (по убыванию). beforeMessageId — строго меньше; senderId — только этого отправителя.
  getRecentCachedMessageIds: async (connectionId, chatId, limit = 1, { beforeMessageId = null, senderId = null } = {}) => {
    await ensureSchema();
    const lim = Math.max(1, Math.min(100, Number(limit) || 1));
    const before = beforeMessageId ? Number(beforeMessageId) : null;
    const sender = senderId ? String(senderId) : null;
    const rows = await sql`
      SELECT message_id FROM business_messages_cache
      WHERE connection_id = ${String(connectionId)} AND chat_id = ${String(chatId)}
        AND (${before}::bigint IS NULL OR message_id < ${before}::bigint)
        AND (${sender}::varchar IS NULL OR sender_id = ${sender}::varchar)
      ORDER BY message_id DESC LIMIT ${lim};
    `;
    return rows.map((r) => Number(r.message_id));
  },

  // Последние N сообщений чата в хронологическом порядке (для .dialog и контекста .autoai).
  getRecentCachedMessages: async (connectionId, chatId, limit = 20) => {
    await ensureSchema();
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = await sql`
      SELECT message_id, sender_id, sender_name, sender_username, msg_type, content, created_at FROM (
        SELECT message_id, sender_id, sender_name, sender_username, msg_type, content, created_at
        FROM business_messages_cache
        WHERE connection_id = ${String(connectionId)} AND chat_id = ${String(chatId)}
        ORDER BY message_id DESC LIMIT ${lim}
      ) t ORDER BY message_id ASC;
    `;
    return rows.map((r) => ({ ...r, message_id: Number(r.message_id) }));
  },

  // --- Квота ИИ: UTC-сутки (не зависит от TimeZone сессии Postgres) ---

  getAiUsageToday: async (ownerId) => {
    await ensureSchema();
    const res = await sql`
      SELECT requests_count FROM ai_usage
      WHERE owner_id = ${String(ownerId)} AND usage_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;
    `;
    return Number(res[0]?.requests_count ?? 0);
  },

  // Атомарный инкремент. Возвращает новое значение счётчика за сегодня.
  incrementAiUsage: async (ownerId) => {
    await ensureSchema();
    const res = await sql`
      INSERT INTO ai_usage (owner_id, usage_date, requests_count)
      VALUES (${String(ownerId)}, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT (owner_id, usage_date) DO UPDATE SET requests_count = ai_usage.requests_count + 1
      RETURNING requests_count;
    `;
    return Number(res[0]?.requests_count ?? 0);
  },

  // --- Кастомные RP-команды ---

  listCustomRp: async (ownerId) => {
    await ensureSchema();
    return sql`
      SELECT trigger, action_text, media_file_id, media_type FROM custom_rp_commands
      WHERE owner_id = ${String(ownerId)} ORDER BY created_at ASC, trigger ASC;
    `.then((rows) => rows.map((r) => ({
      trigger: r.trigger,
      action_text: r.action_text,
      media_file_id: r.media_file_id ?? null,
      media_type: r.media_type ?? null
    })));
  },

  upsertCustomRp: async (ownerId, { trigger, actionText, mediaFileId = null, mediaType = null }) => {
    await ensureSchema();
    return sql`
      INSERT INTO custom_rp_commands (owner_id, trigger, action_text, media_file_id, media_type)
      VALUES (${String(ownerId)}, ${cut(trigger, 50)}, ${cut(actionText, 200)}, ${strOrNull(mediaFileId)}, ${cut(mediaType, 20)})
      ON CONFLICT (owner_id, trigger) DO UPDATE SET
        action_text = EXCLUDED.action_text,
        media_file_id = EXCLUDED.media_file_id,
        media_type = EXCLUDED.media_type;
    `;
  },

  deleteCustomRp: async (ownerId, trigger) => {
    await ensureSchema();
    const res = await sql`
      DELETE FROM custom_rp_commands WHERE owner_id = ${String(ownerId)} AND trigger = ${String(trigger)};
    `;
    return (res.count ?? 0) > 0;
  },

  pruneOldBusinessMessages: async (days = 7) => {
    await ensureSchema();
    const d = Math.max(1, Number(days) || 7);
    const res = await sql`
      DELETE FROM business_messages_cache
      WHERE created_at < CURRENT_TIMESTAMP - (${d}::int * INTERVAL '1 day');
    `;
    return res.count ?? 0;
  }
};
