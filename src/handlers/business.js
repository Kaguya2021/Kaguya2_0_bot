// Telegram Business: подключения (права), .команды владельца, мут/автоудаление стикеров,
// анти-удаление/анти-редактирование и автоответчик (паузы, фильтры, кэши, логирование ошибок).
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { isIgnorableTelegramError } from '../services/broadcast.js';
import { BoundedCache } from '../services/cache.js';
import { parseDotCommand, extractMessageSummary, formatSenderName } from '../services/dotUtils.js';
import { queueBusinessDelete, isBotDeleted } from '../services/deleteQueue.js';
import {
  pauseKey,
  isPauseActive,
  isAutoReplyActive,
  isBlocked,
  isWithinWorkingHours
} from '../services/schedule.js';
import {
  processedMessages,
  localPauses,
  connectionOwners,
  connectionMeta,
  getSettings,
  getChatRule,
  isGlobalStop,
  waitBotStateReady
} from '../bot/state.js';
import { handleDotCommand, notifyOwner, RIGHTS_HINT } from './dotCommands.js';

const PAUSE_DURATION = 10 * 60 * 1000;
const ANTI_SPAM_PAUSE = 3000;              // без режима "Таймер": обычная защита от дублей (~3 сек)
const AUTO_REPLY_COOLDOWN = 15 * 60 * 1000; // с режимом "Таймер": 1 автоответ раз в 15 минут на чат
const RIGHTS_ALERT_TTL = 60 * 60 * 1000;    // уведомление "нет прав на удаление" — не чаще раза в час
const MAX_ALERT_LENGTH = 3800;              // запас до лимита 4096 символов Telegram
const MAX_ALERT_ITEM = 700;
export const DEFAULT_REPLY = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';

// ownerId -> true: троттлинг уведомлений об отсутствии прав на удаление (без фонового таймера).
const rightsAlertSent = new BoundedCache({ maxSize: 5000, ttlMs: RIGHTS_ALERT_TTL });

// BusinessConnection (Bot API) -> meta. Права: новые версии — conn.rights.*, старые — conn.can_reply.
export function connectionToMeta(conn) {
  const rights = conn?.rights || {};
  return {
    ownerId: String(conn.user.id),
    userChatId: conn.user_chat_id !== undefined ? String(conn.user_chat_id) : null,
    canReply: (rights.can_reply ?? conn.can_reply) === true,
    canDeleteSent: rights.can_delete_sent_messages === true,
    canDeleteAll: rights.can_delete_all_messages === true,
    isEnabled: conn.is_enabled !== false
  };
}

function rememberMeta(connectionId, meta) {
  connectionMeta.set(connectionId, meta);
  connectionOwners.set(connectionId, meta.ownerId);
}

// Права подключения: память -> БД -> Bot API (с сохранением в БД и кэш). null — не удалось.
export async function resolveConnectionMeta(api, connectionId) {
  const cached = connectionMeta.get(connectionId);
  if (cached) return cached;

  try {
    const fromDb = await db.getBusinessConnection(connectionId);
    if (fromDb?.ownerId) {
      const meta = {
        ownerId: String(fromDb.ownerId),
        userChatId: fromDb.userChatId ?? null,
        canReply: fromDb.canReply === true,
        canDeleteSent: fromDb.canDeleteSent === true,
        canDeleteAll: fromDb.canDeleteAll === true,
        isEnabled: fromDb.isEnabled !== false
      };
      rememberMeta(connectionId, meta);
      return meta;
    }
  } catch (e) {}

  try {
    const conn = await api.getBusinessConnection(connectionId);
    if (conn?.user) {
      const meta = connectionToMeta(conn);
      rememberMeta(connectionId, meta);
      db.upsertBusinessConnection({ connectionId, ...meta }).catch(() => {});
      return meta;
    }
  } catch (e) {}

  // Последний шанс: известен хотя бы владелец (права неизвестны).
  const ownerId = connectionOwners.get(connectionId);
  return ownerId ? { ownerId, userChatId: null, canReply: undefined, canDeleteSent: undefined, canDeleteAll: undefined, isEnabled: true } : null;
}

// Кэш сообщения для анти-удаления/.del (fire-and-forget, best-effort).
function cacheMessage(msg, connectionId, chatId, ownerId) {
  const { msgType, content } = extractMessageSummary(msg);
  db.saveCachedBusinessMessage({
    connectionId,
    chatId,
    messageId: msg.message_id,
    ownerId,
    senderId: msg.from ? String(msg.from.id) : null,
    senderName: formatSenderName(msg.from),
    senderUsername: msg.from?.username || null,
    msgType,
    content
  }).catch(() => {});
  return { msgType, content };
}

function isRightsError(err) {
  const d = String(err?.description || err?.message || '');
  return d.includes('MESSAGE_DELETE_FORBIDDEN') || d.toLowerCase().includes('not enough rights') ||
    d.includes('BOT_ACCESS_FORBIDDEN');
}

function makeDeleteErrorHandler(api, ownerId) {
  return (err) => {
    if (isRightsError(err)) {
      if (rightsAlertSent.has(ownerId)) return;
      rightsAlertSent.set(ownerId, true);
      notifyOwner(api, ownerId, `⚠️ Не удалось удалить сообщение собеседника: у бота нет прав.\n${RIGHTS_HINT}`);
      return;
    }
    if (isIgnorableTelegramError(err)) return;
    console.error('❌ deleteBusinessMessages error:', err?.description || err?.message || err);
  };
}

async function isAntiDeleteEnabled(ownerId) {
  try {
    return (await getSettings(ownerId)).anti_delete_enabled !== false;
  } catch (e) {
    return true; // по умолчанию включено
  }
}

function senderLine(name, username, senderId) {
  const parts = [`<b>${escapeHTML(name || 'Собеседник')}</b>`];
  if (username) parts.push(`@${escapeHTML(username)}`);
  if (senderId) parts.push(`<code>${escapeHTML(senderId)}</code>`);
  return parts.join(' · ');
}

const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export function formatDeletedAlert(rows) {
  const first = rows[0];
  const header = `🗑 <b>Удалено сообщений: ${rows.length}</b>\n${senderLine(first.sender_name, first.sender_username, first.sender_id)}\n`;
  let body = '';
  let shown = 0;
  for (const r of rows) {
    const item = `\n• ${escapeHTML(clip(r.content || `[${r.msg_type || 'сообщение'}]`, MAX_ALERT_ITEM))}`;
    if (header.length + body.length + item.length > MAX_ALERT_LENGTH) break;
    body += item;
    shown++;
  }
  if (shown < rows.length) body += `\n…и ещё ${rows.length - shown}`;
  return header + body;
}

export function formatEditedAlert({ name, username, senderId, before, after }) {
  return (
    `✏️ <b>Сообщение отредактировано</b>\n${senderLine(name, username, senderId)}\n\n` +
    `<b>Было:</b>\n${escapeHTML(clip(before, 1700))}\n\n` +
    `<b>Стало:</b>\n${escapeHTML(clip(after, 1700))}`
  );
}

export function registerBusinessHandlers(bot) {
  // Подключение/изменение прав/отключение бота в Telegram Business.
  bot.on('business_connection', async (ctx) => {
    try {
      const conn = ctx.update.business_connection;
      if (!conn?.id || !conn.user) return;
      const meta = connectionToMeta(conn);
      rememberMeta(conn.id, meta);
      await db.upsertBusinessConnection({ connectionId: conn.id, ...meta });
    } catch (error) {
      if (isIgnorableTelegramError(error)) return;
      const details = error?.description || error?.message || String(error);
      console.error('❌ business_connection error:', details);
      db.saveErrorLog('unknown', 'business_connection', details).catch(() => {});
    }
  });

  bot.on('business_message', async (ctx) => {
    let chatId = 'unknown';
    try {
      await waitBotStateReady();
      if (isGlobalStop()) return;
      const businessMessage = ctx.businessMessage;
      if (!businessMessage || businessMessage.from.is_bot) return;

      const connectionId = businessMessage.business_connection_id;
      chatId = String(businessMessage.chat.id);
      const messageId = businessMessage.message_id;
      const senderId = String(businessMessage.from.id);

      const uniqueKey = `${connectionId}:${chatId}:${messageId}`;
      if (processedMessages.has(uniqueKey)) return;
      processedMessages.set(uniqueKey, true);

      const meta = await resolveConnectionMeta(ctx.api, connectionId);
      const ownerId = meta?.ownerId;
      if (!ownerId) return;

      const key = pauseKey(ownerId, chatId);

      // Владелец сам написал в чат.
      if (senderId === ownerId) {
        // .команда (не эхо сообщения, отправленного самим ботом).
        if (!businessMessage.sender_business_bot) {
          const parsed = parseDotCommand(businessMessage.text || businessMessage.caption);
          if (parsed && await handleDotCommand(ctx, { parsed, businessMessage, connectionId, chatId, ownerId, meta })) {
            return;
          }
        }
        cacheMessage(businessMessage, connectionId, chatId, ownerId);
        // Пауза автоответа в этом чате (только для этого владельца).
        localPauses.set(key, Date.now() + PAUSE_DURATION, PAUSE_DURATION);
        return;
      }

      cacheMessage(businessMessage, connectionId, chatId, ownerId);

      // Правила чата — из памяти (0 SQL-запросов).
      const rule = getChatRule(ownerId, chatId);
      if (rule?.isMuted) {
        queueBusinessDelete(ctx.api, connectionId, [messageId], makeDeleteErrorHandler(ctx.api, ownerId));
        return; // замученному автоответ не отправляем
      }
      if (rule?.deleteStickersGifs && (businessMessage.sticker || businessMessage.animation)) {
        queueBusinessDelete(ctx.api, connectionId, [messageId], makeDeleteErrorHandler(ctx.api, ownerId));
        return;
      }

      if (isPauseActive(localPauses, ownerId, chatId)) return;

      // Все настройки владельца — одним запросом (с кэшем). БД недоступна — не отвечаем,
      // чтобы не нарушить ограничение по аккаунту и не отправить дефолт вместо кастомного текста.
      let settings;
      try {
        settings = await getSettings(ownerId);
      } catch (e) {
        return;
      }

      if (isBlocked(settings)) return;
      if (!isAutoReplyActive(settings)) return;

      // Ограничение автоответа на конкретный аккаунт (настраивается в "⚙️ Настройки")
      if (settings.allowed_username) {
        const senderUsername = (businessMessage.from.username || '').toLowerCase();
        if (senderUsername !== settings.allowed_username) return;
      }

      if (!isWithinWorkingHours(ownerId, settings, settings.timezone_offset_min)) return;

      // Если владелец включил режим "⏱ Таймер 15 мин" — после автоответа этот чат ставится
      // на паузу 15 минут (новое сообщение раньше не вызовет повторный автоответ).
      // Если режим выключен (по умолчанию) — обычная защита от дублей на ~3 секунды,
      // автоответ уходит почти на каждое сообщение.
      const cooldown = settings.timer_mode ? AUTO_REPLY_COOLDOWN : ANTI_SPAM_PAUSE;
      localPauses.set(key, Date.now() + cooldown, cooldown);

      const replyText = settings.custom_reply || DEFAULT_REPLY;

      if (replyText.startsWith('combo:')) {
        const parts = replyText.replace('combo:', '').split('|||');
        if (parts[0]) await ctx.api.sendMessage(chatId, escapeHTML(parts[0]), { business_connection_id: connectionId, parse_mode: 'HTML' });
        if (parts[1]) await ctx.api.sendSticker(chatId, parts[1], { business_connection_id: connectionId });
        return;
      }

      if (replyText.startsWith('voice:')) {
        const voiceFileId = replyText.replace('voice:', '').trim();
        try {
          await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
        } catch (e) {
          await ctx.api.sendAudio(chatId, voiceFileId, { business_connection_id: connectionId });
        }
        return;
      }

      await ctx.api.sendMessage(chatId, escapeHTML(replyText), { business_connection_id: connectionId, parse_mode: 'HTML' });
    } catch (error) {
      if (isIgnorableTelegramError(error)) return;
      const details = error?.description || error?.message || String(error);
      console.error('❌ business_message error:', details);
      db.saveErrorLog(chatId, 'business_message', details).catch(() => {});
    }
  });

  // Анти-редактирование: "Было / Стало" владельцу в личку.
  bot.on('edited_business_message', async (ctx) => {
    let chatId = 'unknown';
    try {
      const msg = ctx.editedBusinessMessage;
      if (!msg || msg.from?.is_bot) return;
      const connectionId = msg.business_connection_id;
      chatId = String(msg.chat.id);
      const senderId = msg.from ? String(msg.from.id) : null;

      const uniqueKey = `edit:${connectionId}:${chatId}:${msg.message_id}:${msg.edit_date ?? ''}`;
      if (processedMessages.has(uniqueKey)) return;
      processedMessages.set(uniqueKey, true);

      const meta = await resolveConnectionMeta(ctx.api, connectionId);
      const ownerId = meta?.ownerId;
      if (!ownerId) return;

      let original = null;
      try {
        [original = null] = await db.getCachedBusinessMessages(connectionId, chatId, [msg.message_id]);
      } catch (e) {}

      const { content } = cacheMessage(msg, connectionId, chatId, ownerId);

      if (senderId === ownerId) return;
      if (!original || (original.content ?? '') === content) return;
      if (!(await isAntiDeleteEnabled(ownerId))) return;

      await notifyOwner(ctx.api, ownerId, formatEditedAlert({
        name: formatSenderName(msg.from),
        username: msg.from?.username,
        senderId,
        before: original.content,
        after: content
      }));
    } catch (error) {
      if (isIgnorableTelegramError(error)) return;
      const details = error?.description || error?.message || String(error);
      console.error('❌ edited_business_message error:', details);
      db.saveErrorLog(chatId, 'edited_business_message', details).catch(() => {});
    }
  });

  // Анти-удаление: удалённые собеседником сообщения — владельцу в личку.
  bot.on('deleted_business_messages', async (ctx) => {
    let chatId = 'unknown';
    try {
      const upd = ctx.deletedBusinessMessages;
      if (!upd?.message_ids?.length) return;
      const connectionId = upd.business_connection_id;
      chatId = String(upd.chat.id);

      // Удалённое самим ботом (.mute/.wsag/.del/.burn) — не алертим.
      const ids = upd.message_ids.filter((id) => !isBotDeleted(connectionId, id));
      if (!ids.length) return;

      const meta = await resolveConnectionMeta(ctx.api, connectionId);
      const ownerId = meta?.ownerId;
      if (!ownerId) return;
      if (!(await isAntiDeleteEnabled(ownerId))) return;

      let rows;
      try {
        rows = await db.getCachedBusinessMessages(connectionId, chatId, ids);
      } catch (e) {
        return;
      }
      const foreign = rows.filter((r) => r.sender_id !== ownerId);
      if (!foreign.length) return;

      await notifyOwner(ctx.api, ownerId, formatDeletedAlert(foreign));
    } catch (error) {
      if (isIgnorableTelegramError(error)) return;
      const details = error?.description || error?.message || String(error);
      console.error('❌ deleted_business_messages error:', details);
      db.saveErrorLog(chatId, 'deleted_business_messages', details).catch(() => {});
    }
  });
}
