import { Bot, InlineKeyboard } from 'grammy';
import { db, DEFAULT_USER_SETTINGS } from './database.js';
import dotenv from 'dotenv';
import { BoundedCache } from './lib/cache.js';
import {
  parseAdminIds,
  validateTimeArgs,
  parseTzOffset,
  formatTzOffset,
  formatLocalTime,
  isWithinWorkingHours,
  pauseKey,
  isPauseActive,
  isAutoReplyActive,
  isBlocked,
  isIgnorableTelegramError,
  broadcast
} from './lib/utils.js';
import { extractChannelComment } from './lib/comments.js';
import { buildPostKeyboard, buildSendPayload } from './lib/publishing.js';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

// Функция экранирования HTML-тегов
function escapeHTML(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Глобальный обработчик ошибок
bot.catch((err) => {
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
});

const ADMIN_IDS = parseAdminIds(process.env.ADMIN_IDS) || (() => {
  console.warn('⚠️ ADMIN_IDS не задан в env — используется временный встроенный список администраторов.');
  return ['6511859639', '7470537453'];
})();

// Фаза 2: канал для публикаций (только после апрува админа) и группа обсуждений (сбор фидбека).
const TARGET_CHANNEL_ID = (process.env.TARGET_CHANNEL_ID || '').trim();
const DISCUSSION_GROUP_ID = (process.env.DISCUSSION_GROUP_ID || '').trim();

const PAUSE_DURATION = 10 * 60 * 1000;
const ANTI_SPAM_PAUSE = 3000;              // без режима "Таймер": обычная защита от дублей (~3 сек)
const AUTO_REPLY_COOLDOWN = 15 * 60 * 1000; // с режимом "Таймер": 1 автоответ раз в 15 минут на чат
const AUTO_OFF_DURATION = 5 * 60 * 1000;
const BLOCK_DURATION = 24 * 60 * 60 * 1000;
const DEFAULT_REPLY = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';

// Ограниченные кэши (защита от утечки памяти). Очистка протухших записей каждые 5 минут.
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const processedMessages = new BoundedCache({ maxSize: 10000, ttlMs: 30 * 1000 }).startCleanup(CLEANUP_INTERVAL);
// ключ `${ownerId}:${chatId}` -> pauseUntil (TTL записи = длительность паузы)
const localPauses = new BoundedCache({ maxSize: 20000 }).startCleanup(CLEANUP_INTERVAL);
const stepState = new BoundedCache({ maxSize: 5000, ttlMs: 60 * 60 * 1000 }).startCleanup(CLEANUP_INTERVAL);
const connectionOwners = new BoundedCache({ maxSize: 5000, ttlMs: 24 * 60 * 60 * 1000 }).startCleanup(CLEANUP_INTERVAL);
// userId -> полный объект настроек (в т.ч. дефолтный, если строки в БД нет)
const settingsCache = new BoundedCache({ maxSize: 5000, ttlMs: 30 * 60 * 1000 }).startCleanup(CLEANUP_INTERVAL);

let globalStop = false;
let botStateReady = null;

// Загружает персистентное состояние бота (global_stop) из БД. Вызывается при старте.
// Никогда не reject'ится; business_message дожидается её, чтобы не ответить до загрузки global_stop.
export function loadBotState() {
  botStateReady = (async () => {
    try {
      globalStop = (await db.getBotState('global_stop')) === 'true';
      if (globalStop) console.warn('🛑 global_stop = true (загружено из БД): автоответчик остановлен для всех.');
    } catch (e) {
      console.error('⚠️ Не удалось загрузить bot_state из БД:', e?.message || e);
    }
  })();
  return botStateReady;
}

// Настройки пользователя: кэш -> БД (один SELECT). Ошибку БД пробрасывает (в кэш не пишем).
async function getSettings(userId) {
  if (settingsCache.has(userId)) return settingsCache.get(userId);
  const settings = await db.getUserSettings(userId);
  settingsCache.set(userId, settings);
  return settings;
}

// Для меню: при недоступной БД возвращаем дефолт (как раньше getTimerMode -> false).
async function getSettingsSafe(userId) {
  try {
    return await getSettings(userId);
  } catch (e) {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

// Обновляет кэш после успешной записи в БД (если записи нет — следующий запрос подтянет из БД).
function patchSettings(userId, patch) {
  if (settingsCache.has(userId)) {
    settingsCache.set(userId, { ...settingsCache.get(userId), ...patch });
  }
}

function getAutoOffMinutesLeft(settings) {
  const until = Number(settings?.auto_off_until) || 0;
  if (!until) return 0;
  return Math.max(1, Math.ceil((until - Date.now()) / 60000));
}

function isValidTargetId(id) {
  return typeof id === 'string' && /^-?\d+$/.test(id);
}

// Сохраняет автоответ в БД и только после успеха кладёт в кэш.
// Раньше запись шла "в фоне" без проверки: при сбое БД бот писал "Сохранено",
// а после перезапуска автоответ откатывался на дефолтный.
async function saveReply(ctx, userId, value) {
  try {
    await db.setCustomReply(userId, value);
    patchSettings(userId, { custom_reply: value });
    return true;
  } catch (e) {
    await ctx.reply('⚠️ Не удалось сохранить автоответ (база данных недоступна). Попробуйте ещё раз через минуту.').catch(() => {});
    return false;
  }
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

// Главное меню теперь строится как inline-кнопки (под сообщением), а не обычная клавиатура
function getMainInlineKeyboard(userId, settings) {
  const isActive = isAutoReplyActive(settings);
  const timerOn = settings?.timer_mode === true;
  const statusButtonText = isActive
    ? '🔕 Выключить автоответ (5 мин)'
    : `🔔 Включить автоответ (осталось ${getAutoOffMinutesLeft(settings)} мин)`;

  const timerButtonText = timerOn
    ? '⛔ Таймер откл (сейчас: 1 автоответ / 15 мин)'
    : '⏱ Таймер 15 мин (сейчас: откл)';

  const kb = new InlineKeyboard()
    .text(statusButtonText, 'toggle_autoreply').row()
    .text('✍️ Установить текст', 'set_text').text('🎤 Голосовой автоответ', 'set_voice').row()
    .text('🖼️ Комбо (Текст + Стикер)', 'set_combo').text('🔍 Мой автоответ', 'my_reply').row()
    .text('⏰ Настроить время', 'set_time').text('🗑️ Сбросить', 'reset_reply').row()
    .text(timerButtonText, 'toggle_timer_mode').row()
    .text('⚙️ Настройки', 'settings_menu').row();

  if (isAdmin(userId)) {
    kb.text('🔒 ADMINPPA', 'admin_panel').row();
  }

  return kb;
}

function getSettingsInlineKeyboard() {
  return new InlineKeyboard()
    .text('➕ Добавить аккаунт', 'settings_add_account').row()
    .text('⬅️ Назад в меню', 'settings_back');
}

// ===== СБОР КОММЕНТАРИЕВ ИЗ ГРУППЫ ОБСУЖДЕНИЙ (Фаза 2) =====
// Зарегистрирован ДО команд: сообщения из группы обсуждений дальше не передаются,
// поэтому бот никогда не отвечает в группе (кроме /chatid от админа).
bot.on('message', async (ctx, next) => {
  if (!DISCUSSION_GROUP_ID || String(ctx.chat?.id) !== DISCUSSION_GROUP_ID) return next();
  if (ctx.hasCommand('chatid') && isAdmin(ctx.from?.id)) return next();

  const comment = extractChannelComment(ctx.message, DISCUSSION_GROUP_ID);
  if (!comment) return;
  try {
    await db.saveChannelComment(comment);
  } catch (e) {
    console.error('❌ saveChannelComment error:', e?.message || e);
  }
});

// Утилита для админов: показывает chat.id и chat.type (например, чтобы узнать DISCUSSION_GROUP_ID).
bot.command('chatid', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  await ctx.reply(`chat.id: <code>${ctx.chat.id}</code>\nchat.type: <code>${ctx.chat.type}</code>`, { parse_mode: 'HTML' });
});

bot.command('start', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (db.registerUser) {
    db.registerUser(userId, ctx.from.username || ctx.from.first_name).catch(() => {});
  }

  // Убираем старую обычную клавиатуру снизу экрана (осталась с прошлой версии бота).
  // Отправляем служебное сообщение с remove_keyboard и сразу его удаляем — визуально незаметно.
  try {
    const cleanup = await ctx.reply('🧹', { reply_markup: { remove_keyboard: true } });
    await ctx.api.deleteMessage(ctx.chat.id, cleanup.message_id);
  } catch (e) {}

  const welcomeText = 
    '👋 <b>Привет! Я бот Кагуя 2.0.</b>\n\n' +
    '⚙️ Я работающий автоответчик для вашего Telegram Business!\n\n' +
    '📢 <b>Наш официальный канал:</b> <a href="https://t.me/kaguya_2_0_bots">Kaguya 2.0 Channel</a>\n' +
    '<i>Подпишитесь, чтобы быть в курсе всех обновлений и новостей!</i>\n\n' +
    '👇 <b>Используйте удобное меню ниже для настройки:</b>';

  // Создание inline-кнопок с добавленной ссылкой подключения
  const inlineKb = new InlineKeyboard()
    .url('📢 Подписаться на канал', 'https://t.me/kaguya_2_0_bots')
    .row()
    .url('🔗 КАК ПОДКЛЮЧИТЬ', 'https://kaguya-gospoja.onrender.com');

  await ctx.reply(welcomeText, { 
    parse_mode: 'HTML', 
    reply_markup: inlineKb, 
    disable_web_page_preview: true 
  });

  await ctx.reply('🚀 <b>Главное меню автоответчика:</b>', {
    parse_mode: 'HTML',
    reply_markup: getMainInlineKeyboard(userId, await getSettingsSafe(userId))
  });
});

async function showAdminPanel(ctx) {
  if (!isAdmin(ctx.from.id)) {
    return await ctx.reply(
      '🔒 <b>Раздел для администраторов</b>\n\n' +
      'Эта система предназначена только для администраторов.',
      { parse_mode: 'HTML' }
    );
  }

  const adminText = 
    '👑 <b>ПАНЕЛЬ АДМИНИСТРАТОРА (ADMINPPA)</b>\n\n' +
    '🛠️ <b>Все доступные команды и их назначение:</b>\n\n' +
    '📢 <b>Массовые рассылки:</b>\n' +
    '• <code>/post</code> — Создать пост (с фото/видео/кнопками) и разослать всем пользователям бота.\n' +
    '• <code>/m Текст</code> — Быстрая рассылка простого текста всем юзерам.\n\n' +
    '📩 <b>Личные сообщения:</b>\n' +
    '• <code>/mm ID Сообщение</code> — Отправить личное сообщение от имени бота конкретному пользователю по его Telegram ID.\n\n' +
    '🛑 <b>Управление автоответчиком:</b>\n' +
    '• <code>/stop all</code> — Глобально остановить автоответчик для ВСЕХ пользователей.\n' +
    '• <code>/unstop all</code> — Включить глобальный автоответчик обратно.\n' +
    '• <code>/stop ID</code> — Заблокировать автоответ для конкретного ID.\n' +
    '• <code>/unstop ID</code> — Разблокировать автоответ для конкретного ID.\n\n' +
    '📊 <b>Редактирование и Инфо:</b>\n' +
    '• <code>/info ID</code> — Посмотреть всю информацию о пользователе (его ID, автоответ, график работы).\n' +
    '• <code>/setreply ID Текст</code> — Принудительно изменить автоответ для указанного пользователя.';

  await ctx.reply(adminText, { parse_mode: 'HTML' });
}

bot.command('admins', showAdminPanel);
bot.command('adminppa', showAdminPanel);

bot.command('my', async (ctx) => {
  const userId = String(ctx.from.id);
  let currentReply;
  try { currentReply = (await getSettings(userId)).custom_reply; }
  catch (e) { return await ctx.reply('⚠️ База данных временно недоступна, попробуйте позже.'); }
  if (!currentReply) {
    return await ctx.reply('ℹ️ У вас установлен <b>дефолтный текст</b>.', { parse_mode: 'HTML' });
  }
  await ctx.reply(`✍️ <b>Ваш текущий автоответ:</b>\n\n${escapeHTML(currentReply)}`, { parse_mode: 'HTML' });
});

bot.command(['reset', 'clear'], async (ctx) => {
  const userId = String(ctx.from.id);
  stepState.delete(userId);
  try {
    await db.setCustomReply(userId, null);
    patchSettings(userId, { custom_reply: null });
  } catch (e) {
    return await ctx.reply('⚠️ Не удалось сбросить (база данных недоступна). Попробуйте позже.');
  }
  await ctx.reply('🗑️ <b>Ваш автоответ успешно сброшен!</b>', { parse_mode: 'HTML' });
});

bot.command('setreply', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const fullText = ctx.message.text.replace(/^\/setreply\s*/i, '').trim();
  const args = fullText.split(/\s+/);
  const targetId = args[0];
  const newReply = args.slice(1).join(' ');

  if (!targetId || !newReply) {
    return await ctx.reply('👑 Использование: <code>/setreply ID Новый текст</code>', { parse_mode: 'HTML' });
  }

  try {
    await db.setCustomReply(targetId, newReply);
    patchSettings(targetId, { custom_reply: newReply });
  } catch (e) {
    return await ctx.reply('⚠️ Ошибка БД, не сохранено.');
  }
  await ctx.reply(`👑 <b>Успешно отредактировано для ID ${targetId}!</b>`, { parse_mode: 'HTML' });
});

bot.command('stop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.trim().split(/\s+/);
  const target = args[1]?.toLowerCase();

  if (target === 'all') {
    try {
      await db.setBotState('global_stop', 'true');
    } catch (e) {
      return await ctx.reply('⚠️ Ошибка БД, состояние не сохранено.');
    }
    globalStop = true;
    return await ctx.reply('🛑 <b>Глобальный автоответчик ОСТАНОВЛЕН!</b>', { parse_mode: 'HTML' });
  }
  if (target) {
    if (!isValidTargetId(target)) {
      return await ctx.reply('❌ ID должен быть числом: <code>/stop 123456789</code>', { parse_mode: 'HTML' });
    }
    const until = Date.now() + BLOCK_DURATION;
    try {
      await db.setBlockedUntil(target, until);
    } catch (e) {
      return await ctx.reply('⚠️ Ошибка БД, блокировка не сохранена.');
    }
    patchSettings(target, { blocked_until: until });
    return await ctx.reply(`🛑 Автоответчик остановлен на 24 ч для ID: <code>${target}</code>`, { parse_mode: 'HTML' });
  }
  await ctx.reply('❌ Использование: <code>/stop all</code> или <code>/stop &lt;USER_ID&gt;</code>', { parse_mode: 'HTML' });
});

bot.command('unstop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.trim().split(/\s+/);
  const target = args[1]?.toLowerCase();

  if (target === 'all') {
    try {
      await db.setBotState('global_stop', 'false');
    } catch (e) {
      return await ctx.reply('⚠️ Ошибка БД, состояние не сохранено.');
    }
    globalStop = false;
    return await ctx.reply('✅ <b>Глобальный автоответчик ВКЛЮЧЕН!</b>', { parse_mode: 'HTML' });
  }
  if (target) {
    if (!isValidTargetId(target)) {
      return await ctx.reply('❌ ID должен быть числом: <code>/unstop 123456789</code>', { parse_mode: 'HTML' });
    }
    try {
      await db.setBlockedUntil(target, null);
    } catch (e) {
      return await ctx.reply('⚠️ Ошибка БД, разблокировка не сохранена.');
    }
    patchSettings(target, { blocked_until: null });
    return await ctx.reply(`✅ Автоответчик возобновлен для ID: <code>${target}</code>`, { parse_mode: 'HTML' });
  }
  await ctx.reply('❌ Использование: <code>/unstop all</code> или <code>/unstop &lt;USER_ID&gt;</code>', { parse_mode: 'HTML' });
});

bot.command('m', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const text = ctx.message.text.replace(/^\/m\s*/i, '').trim();
  if (!text) return await ctx.reply('❌ Напишите текст после команды.', { parse_mode: 'HTML' });

  const users = (await db.getAllUsers?.()) || [];
  await ctx.reply(`📢 <b>Начинаю рассылку...</b> Всего получателей: ${users.length}`, { parse_mode: 'HTML' });

  (async () => {
    const ids = users.map((u) => u.user_id || u.telegram_id || u);
    const { delivered, failed } = await broadcast(ids, (id) => ctx.api.sendMessage(id, text, { parse_mode: 'HTML' }));
    await ctx.reply(`🎉 <b>Рассылка завершена!</b> Доставлено: ${delivered} / Ошибок: ${failed}`, { parse_mode: 'HTML' });
  })().catch((e) => console.error('Broadcast /m error:', e?.message || e));
});

bot.command('mm', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.replace(/^\/mm\s*/i, '').trim().split(/\s+/);
  const targetId = args[0];
  const messageText = args.slice(1).join(' ');

  if (!targetId || !messageText) return await ctx.reply('❌ Использование: <code>/mm &lt;ID&gt; &lt;Сообщение&gt;</code>', { parse_mode: 'HTML' });

  try {
    await ctx.api.sendMessage(targetId, messageText, { parse_mode: 'HTML' });
    await ctx.reply(`✅ Сообщение отправлено пользователю <code>${targetId}</code>`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
});

bot.command('info', async (ctx) => {
  const userId = String(ctx.from.id);
  const args = ctx.message.text.trim().split(/\s+/);
  const targetId = args[1];

  if (isAdmin(userId) && targetId) {
    try {
      let userInfo = {};
      if (db.getUserInfo) {
        userInfo = await db.getUserInfo(targetId) || {};
      }

      const targetSettings = await db.getUserSettings(targetId).catch(() => ({ ...DEFAULT_USER_SETTINGS }));
      const customReply = targetSettings.custom_reply || 'Стандартный дефолтный текст';
      const schedule = targetSettings;
      const autoReplyStatus = isBlocked(targetSettings)
        ? '⛔ Заблокирован админом'
        : isAutoReplyActive(targetSettings)
          ? '✅ Включен'
          : `🔕 Выключен (осталось ${getAutoOffMinutesLeft(targetSettings)} мин)`;

      let infoText = `📊 <b>Информация о пользователе ID:</b> <code>${targetId}</code>\n\n`;
      infoText += `📅 <b>Подключен:</b> ${userInfo.created_at || userInfo.date || 'Неизвестно'}\n`;
      infoText += `👤 <b>Username/Имя:</b> ${userInfo.username || userInfo.name || 'Нет данных'}\n`;
      infoText += `🔔 <b>Статус автоответа:</b> ${autoReplyStatus}\n`;
      infoText += `💬 <b>Текущий автоответ:</b>\n<code>${escapeHTML(customReply)}</code>\n\n`;
      infoText += `⏰ <b>График работы:</b> ${schedule?.start_time ? `${schedule.start_time} - ${schedule.end_time}` : 'Круглосуточно'} (${formatTzOffset(targetSettings.timezone_offset_min)})`;

      return await ctx.reply(infoText, { parse_mode: 'HTML' });
    } catch (e) {
      return await ctx.reply(`❌ Ошибка получения информации: ${e.message}`);
    }
  }

  const infoText = 
    'ℹ️ <b>Информация о боте Кагуя 2.0</b>\n\n' +
    '🤖 Персональный автоответчик для Telegram Business.\n' +
    '• <b>Кнопка «Выключить автоответ»:</b> Останавливает автоответчик на 5 минут, после чего он включается сам. Можно включить раньше вручную.\n\n' +
    (isAdmin(userId) ? '👑 <i>Админ-совет:</i> Введите <code>/info ID_пользователя</code>, чтобы посмотреть его настройки.\n\n' : '') +
    '📢 <b>Канал проекта:</b> @kaguya_2_0_bots';
  
  await ctx.reply(infoText, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.command('post', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  stepState.set(String(ctx.from.id), { step: 'WAITING_POST' });
  await ctx.reply('📢 <b>Режим создания поста:</b> Отправьте следующий пост для рассылки!', { parse_mode: 'HTML' });
});

function tzInfoText(settings) {
  const offset = settings?.timezone_offset_min || 0;
  return `🌍 Ваш часовой пояс: <b>${formatTzOffset(offset)}</b>, сейчас по нему <b>${formatLocalTime(new Date(), offset)}</b>.\n` +
    'Изменить: <code>/tz +3</code> (формат: <code>+6</code>, <code>-3</code>, <code>0</code>, <code>+3:30</code>)';
}

function timeHelpText(settings) {
  return '⏰ <b>Настройка рабочего времени:</b>\n\n' +
    'Отправьте команду с желаемым временем (формат ЧЧ:ММ).\n' +
    '• Пример: <code>/time 05:00 20:00</code>\n' +
    '• Ночной интервал: <code>/time 22:00 06:00</code>\n' +
    '• Отключить лимит: <code>/time off</code>\n\n' +
    tzInfoText(settings);
}

bot.command('time', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const rawArgs = (ctx.match || '').trim();
    const args = rawArgs ? rawArgs.split(/\s+/) : [];

    if (args[0] && args[0].toLowerCase() === 'off') {
      await db.setSchedule(userId, null, null);
      patchSettings(userId, { start_time: null, end_time: null });
      return await ctx.reply('✅ <b>Ограничение по времени отключено.</b>', { parse_mode: 'HTML' });
    }

    const parsed = validateTimeArgs(args);
    if (!parsed.ok) {
      return await ctx.reply(
        '❌ Неверный формат. Укажите время как ЧЧ:ММ (00:00–23:59): <code>/time 05:00 20:00</code> или <code>/time off</code>\n\n' +
        tzInfoText(await getSettingsSafe(userId)),
        { parse_mode: 'HTML' }
      );
    }

    await db.setSchedule(userId, parsed.start, parsed.end);
    patchSettings(userId, { start_time: parsed.start, end_time: parsed.end });
    const settings = await getSettingsSafe(userId);
    await ctx.reply(
      `✅ <b>График сохранен!</b> с ${parsed.start} до ${parsed.end} (${formatTzOffset(settings.timezone_offset_min)}).\n\n` +
      tzInfoText(settings),
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('tz', async (ctx) => {
  const userId = String(ctx.from.id);
  const arg = (ctx.match || '').trim();

  if (!arg) {
    return await ctx.reply(tzInfoText(await getSettingsSafe(userId)) + '\nДиапазон: от -12 до +14 часов.', { parse_mode: 'HTML' });
  }

  const offset = parseTzOffset(arg);
  if (offset === null) {
    return await ctx.reply(
      '❌ Неверный часовой пояс. Примеры: <code>/tz +6</code>, <code>/tz -3</code>, <code>/tz 0</code>, <code>/tz +3:30</code> (от -12 до +14).',
      { parse_mode: 'HTML' }
    );
  }

  try {
    await db.setTimezoneOffset(userId, offset);
  } catch (e) {
    return await ctx.reply('⚠️ Не удалось сохранить часовой пояс (база данных недоступна). Попробуйте позже.');
  }
  patchSettings(userId, { timezone_offset_min: offset });
  await ctx.reply(
    `✅ <b>Часовой пояс сохранён:</b> ${formatTzOffset(offset)}\nСейчас по нему: <b>${formatLocalTime(new Date(), offset)}</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('sred', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT' });
  await ctx.reply('✍️ <b>Шаг 1/2:</b> Напишите текст автоответа:', { parse_mode: 'HTML' });
});

bot.command('set', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const customText = (ctx.message.text || '').replace(/^\/set\s*/i, '').trim();

    if (customText.toLowerCase() === 'gs') {
      stepState.set(userId, { step: 'WAITING_VOICE' });
      return await ctx.reply('🎤 <b>Отправьте голосовое сообщение:</b>', { parse_mode: 'HTML' });
    }

    if (!customText) return await ctx.reply('❌ Ошибка. Напишите текст после <code>/set</code>.', { parse_mode: 'HTML' });

    stepState.delete(userId);
    if (!(await saveReply(ctx, userId, customText))) return;

    await ctx.reply(`✅ <b>Успешно сохранено!</b>\n\n${escapeHTML(customText)}`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

// ===== ОБРАБОТЧИКИ INLINE-КНОПОК ГЛАВНОГО МЕНЮ =====

bot.callbackQuery('toggle_autoreply', async (ctx) => {
  const userId = String(ctx.from.id);
  let settings;
  try {
    settings = await getSettings(userId);
  } catch (e) {
    return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
  }

  const turnOff = isAutoReplyActive(settings);
  const until = turnOff ? Date.now() + AUTO_OFF_DURATION : null;
  try {
    await db.setAutoOffUntil(userId, until);
  } catch (e) {
    return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
  }
  patchSettings(userId, { auto_off_until: until });

  await ctx.answerCallbackQuery({ text: turnOff ? '🔕 Автоответчик выключен на 5 минут' : '🔔 Автоответчик включен!' });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: getMainInlineKeyboard(userId, await getSettingsSafe(userId)) });
  } catch (e) {}
});

bot.callbackQuery('toggle_timer_mode', async (ctx) => {
  const userId = String(ctx.from.id);
  const current = (await getSettingsSafe(userId)).timer_mode === true;
  const next = !current;
  try {
    await db.setTimerMode(userId, next);
    patchSettings(userId, { timer_mode: next });
  } catch (e) {
    return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
  }

  await ctx.answerCallbackQuery({
    text: next
      ? '⏱ Включено: 1 автоответ раз в 15 минут на чат.'
      : '⛔ Выключено: автоответ снова на каждое сообщение.'
  });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: getMainInlineKeyboard(userId, { ...(await getSettingsSafe(userId)), timer_mode: next }) });
  } catch (e) {}
});

bot.callbackQuery('set_text', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT_ONLY' });
  await ctx.answerCallbackQuery();
  await ctx.reply('✍️ <b>Напишите текст автоответа, который вы хотите установить:</b>', { parse_mode: 'HTML' });
});

bot.callbackQuery('set_voice', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_VOICE' });
  await ctx.answerCallbackQuery();
  await ctx.reply('🎤 <b>Отправьте или перешлите мне голосовое сообщение для автоответа:</b>', { parse_mode: 'HTML' });
});

bot.callbackQuery('set_combo', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT' });
  await ctx.answerCallbackQuery();
  await ctx.reply('✍️ <b>Шаг 1/2:</b> Напишите текст, который должен отправляться со стикером:', { parse_mode: 'HTML' });
});

bot.callbackQuery('my_reply', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  let currentReply;
  try { currentReply = (await getSettings(userId)).custom_reply; }
  catch (e) { return await ctx.reply('⚠️ База данных временно недоступна, попробуйте позже.'); }

  if (!currentReply) {
    return await ctx.reply('ℹ️ У вас установлен <b>дефолтный текст</b>:\n<i>Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓</i>', { parse_mode: 'HTML' });
  }

  if (currentReply.startsWith('combo:')) {
    const parts = currentReply.replace('combo:', '').split('|||');
    return await ctx.reply(`🔥 <b>Ваш автоответ (Комбо):</b>\n\n📝 Текст: <code>${escapeHTML(parts[0])}</code>\n🖼️ Sticker ID: <code>${parts[1]}</code>`, { parse_mode: 'HTML' });
  }

  if (currentReply.startsWith('voice:')) {
    const voiceId = currentReply.replace('voice:', '');
    return await ctx.reply(`🎤 <b>Ваш автоответ (Голосовое):</b>\nID файла: <code>${voiceId}</code>`, { parse_mode: 'HTML' });
  }

  await ctx.reply(`✍️ <b>Ваш текущий автоответ:</b>\n\n${escapeHTML(currentReply)}`, { parse_mode: 'HTML' });
});

bot.callbackQuery('reset_reply', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  stepState.delete(userId);
  try {
    await db.setCustomReply(userId, null);
    patchSettings(userId, { custom_reply: null });
  } catch (e) {
    return await ctx.reply('⚠️ Не удалось сбросить (база данных недоступна). Попробуйте позже.');
  }

  await ctx.reply('🗑️ <b>Ваш автоответ успешно сброшен!</b> Теперь будет отправляться стандартный текст.', { parse_mode: 'HTML' });
});

bot.callbackQuery('set_time', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(timeHelpText(await getSettingsSafe(String(ctx.from.id))), { parse_mode: 'HTML' });
});

bot.callbackQuery('admin_panel', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (isAdmin(ctx.from.id)) {
    await showAdminPanel(ctx);
  }
});

// ===== НАСТРОЙКИ: ПРИВЯЗКА АВТООТВЕТА К КОНКРЕТНОМУ АККАУНТУ =====

bot.callbackQuery('settings_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  let allowedUsername;
  try {
    allowedUsername = (await getSettings(userId)).allowed_username;
  } catch (e) {
    return await ctx.reply('⚠️ База данных временно недоступна, попробуйте позже.');
  }

  const statusLine = allowedUsername
    ? `🔗 Сейчас автоответчик работает только для <code>@${escapeHTML(allowedUsername)}</code>.`
    : '🔓 Сейчас автоответчик работает для всех, без ограничений.';

  await ctx.reply(
    '⚙️ <b>Настройки</b>\n\n' +
    'Здесь можно ограничить автоответчик так, чтобы он отвечал только одному конкретному аккаунту.\n\n' +
    `${statusLine}\n\n` +
    'Чтобы снять ограничение — отправьте команду <code>/no us</code>.',
    { parse_mode: 'HTML', reply_markup: getSettingsInlineKeyboard() }
  );
});

bot.callbackQuery('settings_add_account', async (ctx) => {
  await ctx.answerCallbackQuery();
  stepState.set(String(ctx.from.id), { step: 'WAITING_ACCOUNT' });
  await ctx.reply(
    '➕ <b>Добавление аккаунта</b>\n\n' +
    'Напишите username пользователя, для которого должен работать автоответчик.\n' +
    'Пример: <code>@kaguya2_0</code>\n\n' +
    'После этого автоответчик будет отвечать только этому аккаунту, всем остальным — нет.\n' +
    'Чтобы отключить ограничение — команда <code>/no us</code>.',
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery('settings_back', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  await ctx.reply('🚀 <b>Главное меню автоответчика:</b>', {
    parse_mode: 'HTML',
    reply_markup: getMainInlineKeyboard(userId, await getSettingsSafe(userId))
  });
});

// ===== HUMAN-IN-THE-LOOP ПУБЛИКАЦИЯ В КАНАЛ (Фаза 2) =====
// Пост попадает в канал ТОЛЬКО здесь — после клика админа по кнопке превью.

// Убирает с превью ряд одобрения, оставляя URL-кнопки самого поста.
async function removeApprovalButtons(ctx, draft) {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: buildPostKeyboard(draft?.buttons_json) || { inline_keyboard: [] } });
  } catch (e) {}
}

bot.callbackQuery(/^draft_approve:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return await ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
  }
  if (!TARGET_CHANNEL_ID) {
    return await ctx.answerCallbackQuery({ text: '⚠️ TARGET_CHANNEL_ID не задан — публикация в канал запрещена.', show_alert: true });
  }

  const draftId = Number(ctx.match[1]);
  let draft;
  try {
    draft = await db.claimDraftForPublishing(draftId);
  } catch (e) {
    return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
  }
  if (!draft) {
    return await ctx.answerCallbackQuery({ text: 'Черновик уже опубликован или отменён', show_alert: true });
  }
  await ctx.answerCallbackQuery({ text: '⏳ Публикую…' }).catch(() => {});

  let sent;
  try {
    const { method, args } = buildSendPayload(draft, TARGET_CHANNEL_ID, buildPostKeyboard(draft.buttons_json));
    sent = await ctx.api[method](...args);
  } catch (e) {
    const details = e?.description || e?.message || String(e);
    console.error(`❌ Публикация черновика #${draftId} не удалась:`, details);
    db.saveErrorLog(String(TARGET_CHANNEL_ID), 'draft_publish', `[draft ${draftId}] ${details}`).catch(() => {});
    let rollbackNote = 'Статус возвращён в pending_approval — можно исправить причину и нажать «Опубликовать» ещё раз.';
    try {
      await db.markDraftStatus(draftId, 'pending_approval', null, 'publishing');
    } catch (dbErr) {
      rollbackNote = `⚠️ Не удалось откатить статус (остался publishing): ${escapeHTML(dbErr?.message || dbErr)}`;
    }
    return await ctx.reply(
      `❌ Черновик #${draftId} не опубликован.\nОшибка Telegram: <code>${escapeHTML(details)}</code>\n\n${rollbackNote}`,
      { parse_mode: 'HTML' }
    );
  }

  // Пост уже в канале: при сбое БД статус НЕ откатываем (остаётся publishing — повторная публикация невозможна).
  try {
    await db.markDraftPublished(draftId, { approvedBy: String(ctx.from.id), publishedMessageId: sent.message_id });
  } catch (e) {
    console.error(`⚠️ Черновик #${draftId} опубликован, но статус не сохранён:`, e?.message || e);
  }
  await removeApprovalButtons(ctx, draft);
  await ctx.reply(`✅ Черновик #${draftId} опубликован в канал (message_id: ${sent.message_id})`);
});

bot.callbackQuery(/^draft_cancel:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return await ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
  }
  const draftId = Number(ctx.match[1]);
  let draft;
  try {
    draft = await db.markDraftStatus(draftId, 'cancelled', String(ctx.from.id), 'pending_approval');
  } catch (e) {
    return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
  }
  if (!draft) {
    return await ctx.answerCallbackQuery({ text: 'Черновик уже опубликован или отменён', show_alert: true });
  }
  await ctx.answerCallbackQuery().catch(() => {});
  await removeApprovalButtons(ctx, draft);
  await ctx.reply(`❌ Черновик #${draftId} отменён`);
});

bot.command('no', async (ctx) => {
  const arg = (ctx.match || '').trim().toLowerCase();
  if (arg !== 'us') {
    return await ctx.reply('❌ Использование: <code>/no us</code> — снять ограничение по аккаунту.', { parse_mode: 'HTML' });
  }
  const userId = String(ctx.from.id);
  try {
    await db.setAllowedUsername(userId, null);
    patchSettings(userId, { allowed_username: null });
  } catch (e) {
    return await ctx.reply('⚠️ Не удалось снять ограничение (база данных недоступна). Попробуйте позже.');
  }
  stepState.delete(userId);
  await ctx.reply('✅ <b>Ограничение по аккаунту снято.</b> Автоответчик снова работает для всех.', { parse_mode: 'HTML' });
});

bot.on('message', async (ctx, next) => {
  // Настройка через меню и stepState — только в личном чате с ботом (не в группах/каналах).
  if (ctx.businessMessage || ctx.chat?.type !== 'private') return next();

  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

  if (state && state.step === 'WAITING_ACCOUNT' && ctx.message.text) {
    const raw = ctx.message.text.trim().replace(/^@/, '');
    if (!raw) {
      return await ctx.reply('❌ Отправьте корректный username, например: <code>@kaguya2_0</code>', { parse_mode: 'HTML' });
    }
    const username = raw.toLowerCase();
    try {
      await db.setAllowedUsername(userId, username);
      patchSettings(userId, { allowed_username: username });
    } catch (e) {
      return await ctx.reply('⚠️ Не удалось сохранить (база данных недоступна). Отправьте username ещё раз.');
    }
    stepState.delete(userId);
    return await ctx.reply(
      `✅ <b>Готово!</b> Автоответчик теперь работает только в переписке с <code>@${escapeHTML(username)}</code>.\n\n` +
      'Чтобы снять ограничение, отправьте команду <code>/no us</code>.',
      { parse_mode: 'HTML' }
    );
  }

  if (state && state.step === 'WAITING_TEXT_ONLY' && ctx.message.text) {
    const text = ctx.message.text;
    if (!(await saveReply(ctx, userId, text))) return;
    stepState.delete(userId);
    return await ctx.reply(`✅ <b>Новый текстовый автоответ сохранён!</b>\n\n${escapeHTML(text)}`, { parse_mode: 'HTML' });
  }

  if (state && state.step === 'WAITING_POST' && isAdmin(userId)) {
    stepState.delete(userId);
    await ctx.reply('🚀 <b>Начинаю рассылку поста...</b>', { parse_mode: 'HTML' });

    const users = (await db.getAllUsers?.()) || [];
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    (async () => {
      const ids = users.map((u) => u.user_id || u.telegram_id || u);
      const { delivered, failed } = await broadcast(ids, (id) => ctx.api.copyMessage(id, chatId, messageId));
      await ctx.api.sendMessage(chatId, `🎉 <b>Пост отправлен!</b> Доставлено: ${delivered} / Ошибок: ${failed}`, { parse_mode: 'HTML' });
    })().catch((e) => console.error('Broadcast /post error:', e?.message || e));

    return;
  }

  if (state && state.step === 'WAITING_TEXT' && ctx.message.text) {
    stepState.set(userId, { step: 'WAITING_STICKER', text: ctx.message.text });
    return await ctx.reply('🖼️ <b>Шаг 2/2:</b> Теперь отправьте стикер:', { parse_mode: 'HTML' });
  }

  if (state && state.step === 'WAITING_STICKER' && ctx.message.sticker) {
    const stickerId = ctx.message.sticker.file_id;
    const comboValue = `combo:${state.text}|||${stickerId}`;
    if (!(await saveReply(ctx, userId, comboValue))) return;
    stepState.delete(userId);
    return await ctx.reply('🔥 <b>Комбо автоответ (Текст + Стикер) сохранён!</b>', { parse_mode: 'HTML' });
  }

  if (state && state.step === 'WAITING_VOICE' && (ctx.message.voice || ctx.message.audio)) {
    const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
    const value = `voice:${fileId}`;
    if (!(await saveReply(ctx, userId, value))) return;
    stepState.delete(userId);
    return await ctx.reply('✅ <b>Голосовой/аудио автоответ сохранён!</b>', { parse_mode: 'HTML' });
  }

  return next();
});

bot.on('business_message', async (ctx) => {
  let chatId = 'unknown';
  try {
    if (botStateReady) await botStateReady;
    if (globalStop) return;
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
