// Сборка бота: создание Bot, глобальный обработчик ошибок и регистрация обработчиков.
import { Bot } from 'grammy';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { isIgnorableTelegramError } from '../services/broadcast.js';
import { registerChannelHandlers } from '../handlers/channel.js';
import { registerAdminHandlers } from '../handlers/admin.js';
import { registerCommandHandlers } from '../handlers/commands.js';
import { registerCallbackHandlers } from '../handlers/callbacks.js';
import { registerPrivateStepHandlers } from '../handlers/privateSteps.js';
import { registerBusinessHandlers } from '../handlers/business.js';
import { registerGameCallbacks } from '../handlers/gameCommands.js';

export { loadBotState, stopCacheCleanup } from './state.js';

// Глобальный обработчик ошибок
function handleBotError(err) {
  const e = err.error;

  const errorCode = e?.error_code || e?.code;
  const description = e?.description || err?.message || String(err);

  if (isIgnorableTelegramError({ error_code: errorCode, description })) {
    return;
  }

  const updateId = err?.ctx?.update?.update_id;
  console.error(`❌ BotError [update ${updateId ?? '?'}]:`, description);
  const logChatId = String(err?.ctx?.chat?.id ?? err?.ctx?.from?.id ?? 'unknown');
  db.saveErrorLog(logChatId, 'bot_catch', `[update ${updateId ?? '?'}] ${description}`).catch(() => {});
}

// token/botOptions переопределяются в тестах (фиктивный токен, botInfo без getMe).
export function createBot(token = config.botToken, botOptions = undefined) {
  if (!token) {
    throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
  }
  if (!config.adminIdsFromEnv) {
    console.warn('⚠️ ADMIN_IDS не задан в env — используется временный встроенный список администраторов.');
  }

  const bot = new Bot(token, botOptions);
  bot.catch(handleBotError);

  // ПОРЯДОК ВАЖЕН:
  // 1. Сборщик комментариев группы обсуждений — первым: глушит всё из DISCUSSION_GROUP_ID,
  //    кроме /chatid от админа (его пропускает дальше).
  registerChannelHandlers(bot);
  // 2. Команды (админские + пользовательские) и callback-кнопки — ДО общего message-обработчика,
  //    чтобы /start, /reset, /chatid и т.п. не проваливались в stepState.
  registerAdminHandlers(bot);
  registerCommandHandlers(bot);
  // Кнопки мини-игр (g:*) — ДО гейта подписки: их жмут оба участника бизнес-чата.
  registerGameCallbacks(bot);
  registerCallbackHandlers(bot);
  // 3. Пошаговая настройка в личке (bot.on('message')) — только private-чаты.
  registerPrivateStepHandlers(bot);
  // 4. Автоответчик Telegram Business — отдельный тип апдейта.
  registerBusinessHandlers(bot);

  return bot;
}
