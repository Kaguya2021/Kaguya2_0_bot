// Автоответчик Telegram Business: паузы, фильтры, кэши и логирование ошибок.
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { isIgnorableTelegramError } from '../services/broadcast.js';
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
  getSettings,
  isGlobalStop,
  waitBotStateReady
} from '../bot/state.js';

const PAUSE_DURATION = 10 * 60 * 1000;
const ANTI_SPAM_PAUSE = 3000;              // без режима "Таймер": обычная защита от дублей (~3 сек)
const AUTO_REPLY_COOLDOWN = 15 * 60 * 1000; // с режимом "Таймер": 1 автоответ раз в 15 минут на чат
export const DEFAULT_REPLY = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';

export function registerBusinessHandlers(bot) {
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

      let ownerId = connectionOwners.get(connectionId);
      if (!ownerId) {
        try {
          const conn = await ctx.getBusinessConnection();
          if (conn?.user) {
            ownerId = String(conn.user.id);
            connectionOwners.set(connectionId, ownerId);
          }
        } catch (e) {}
      }

      if (!ownerId) return;

      const key = pauseKey(ownerId, chatId);

      // Владелец сам написал в чат — пауза автоответа в этом чате (только для этого владельца).
      if (senderId === ownerId) {
        localPauses.set(key, Date.now() + PAUSE_DURATION, PAUSE_DURATION);
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
}
