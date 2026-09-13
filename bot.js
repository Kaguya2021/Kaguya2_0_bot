import { Bot, InlineKeyboard } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

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

  if (
    errorCode === 403 ||
    description.includes('blocked by the user') ||
    description.includes('user is deactivated') ||
    description.includes('chat not found') ||
    description.includes('bot was kicked')
  ) {
    return;
  }

  const updateId = err?.ctx?.update?.update_id;
  console.error(`❌ BotError [update ${updateId ?? '?'}]:`, description);
});

const ADMIN_IDS = ['6511859639', '7470537453'];

const PAUSE_DURATION = 10 * 60 * 1000;
const ANTI_SPAM_PAUSE = 3000;              // без режима "Таймер": обычная защита от дублей (~3 сек)
const AUTO_REPLY_COOLDOWN = 15 * 60 * 1000; // с режимом "Таймер": 1 автоответ раз в 15 минут на чат
const AUTO_OFF_DURATION = 5 * 60 * 1000; 

const processedMessages = new Set();
const localPauses = new Map();
const replyCache = new Map();
const stepState = new Map();
const autoOffUntil = new Map(); 
const connectionOwners = new Map();
const allowedUsernameCache = new Map(); // ownerId -> username (или null)
const timerModeCache = new Map();       // ownerId -> true/false (режим "Таймер 15 мин")

function isAutoReplyActive(userId) {
  const until = autoOffUntil.get(userId);
  if (!until) return true;
  if (Date.now() >= until) {
    autoOffUntil.delete(userId);
    return true;
  }
  return false;
}

function getAutoOffMinutesLeft(userId) {
  const until = autoOffUntil.get(userId);
  if (!until) return 0;
  return Math.max(1, Math.ceil((until - Date.now()) / 60000));
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

async function getTimerMode(userId) {
  let enabled = timerModeCache.get(userId);
  if (enabled === undefined) {
    enabled = await db.getTimerMode(userId).catch(() => false);
    timerModeCache.set(userId, enabled);
  }
  return enabled;
}

// Главное меню теперь строится как inline-кнопки (под сообщением), а не обычная клавиатура
function getMainInlineKeyboard(userId, timerOn) {
  const isActive = isAutoReplyActive(userId);
  const statusButtonText = isActive
    ? '🔕 Выключить автоответ (5 мин)'
    : `🔔 Включить автоответ (осталось ${getAutoOffMinutesLeft(userId)} мин)`;

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

bot.command('start', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (db.registerUser) {
    db.registerUser(userId, ctx.from.username || ctx.from.first_name).catch(() => {});
  }

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
    reply_markup: getMainInlineKeyboard(userId, await getTimerMode(userId))
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
  const currentReply = replyCache.get(userId) || await db.getCustomReply(userId).catch(() => null);
  if (!currentReply) {
    return await ctx.reply('ℹ️ У вас установлен <b>дефолтный текст</b>.', { parse_mode: 'HTML' });
  }
  await ctx.reply(`✍️ <b>Ваш текущий автоответ:</b>\n\n${escapeHTML(currentReply)}`, { parse_mode: 'HTML' });
});

bot.command(['reset', 'clear'], async (ctx) => {
  const userId = String(ctx.from.id);
  replyCache.delete(userId);
  await db.setCustomReply(userId, null).catch((e) => console.error('DB error:', e.message));
  stepState.delete(userId);
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

  replyCache.set(targetId, newReply);
  await db.setCustomReply(targetId, newReply);
  await ctx.reply(`👑 <b>Успешно отредактировано для ID ${targetId}!</b>`, { parse_mode: 'HTML' });
});

bot.command('stop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.trim().split(/\s+/);
  const target = args[1]?.toLowerCase();

  if (target === 'all') {
    globalThis.globalStop = true;
    return await ctx.reply('🛑 <b>Глобальный автоответчик ОСТАНОВЛЕН!</b>', { parse_mode: 'HTML' });
  }
  if (target) {
    localPauses.set(target, Date.now() + 24 * 60 * 60 * 1000);
    return await ctx.reply(`🛑 Автоответчик остановлен для ID: <code>${target}</code>`, { parse_mode: 'HTML' });
  }
  await ctx.reply('❌ Использование: <code>/stop all</code> или <code>/stop &lt;USER_ID&gt;</code>', { parse_mode: 'HTML' });
});

bot.command('unstop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.trim().split(/\s+/);
  const target = args[1]?.toLowerCase();

  if (target === 'all') {
    globalThis.globalStop = false;
    return await ctx.reply('✅ <b>Глобальный автоответчик ВКЛЮЧЕН!</b>', { parse_mode: 'HTML' });
  }
  if (target) {
    localPauses.delete(target);
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
    let successCount = 0;
    for (const u of users) {
      try {
        await ctx.api.sendMessage(u.user_id || u.telegram_id || u, text, { parse_mode: 'HTML' });
        successCount++;
      } catch (e) {}
      await new Promise((res) => setTimeout(res, 50));
    }
    await ctx.reply(`🎉 <b>Рассылка завершена!</b> Доставлено: ${successCount}`, { parse_mode: 'HTML' });
  })();
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

      const customReply = await db.getCustomReply?.(targetId).catch(() => null) || 'Стандартный дефолтный текст';
      const schedule = await db.getSchedule?.(targetId).catch(() => null);
      const autoReplyStatus = isAutoReplyActive(targetId)
        ? '✅ Включен'
        : `🔕 Выключен (осталось ${getAutoOffMinutesLeft(targetId)} мин)`;

      let infoText = `📊 <b>Информация о пользователе ID:</b> <code>${targetId}</code>\n\n`;
      infoText += `📅 <b>Подключен:</b> ${userInfo.created_at || userInfo.date || 'Неизвестно'}\n`;
      infoText += `👤 <b>Username/Имя:</b> ${userInfo.username || userInfo.name || 'Нет данных'}\n`;
      infoText += `🔔 <b>Статус автоответа:</b> ${autoReplyStatus}\n`;
      infoText += `💬 <b>Текущий автоответ:</b>\n<code>${escapeHTML(customReply)}</code>\n\n`;
      infoText += `⏰ <b>График работы:</b> ${schedule?.start_time ? `${schedule.start_time} - ${schedule.end_time}` : 'Круглосуточно'}`;

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

bot.command('time', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const fullText = ctx.message.text || '';
    const args = fullText.replace(/^\/time\s*/i, '').trim().split(/\s+/);

    if (args[0] && args[0].toLowerCase() === 'off') {
      await db.setSchedule(userId, null, null);
      return await ctx.reply('✅ <b>Ограничение по времени отключено.</b>', { parse_mode: 'HTML' });
    }

    if (args.length < 2) {
      return await ctx.reply('❌ Укажите время: <code>/time 05:00 20:00</code> или <code>/time off</code>', { parse_mode: 'HTML' });
    }

    await db.setSchedule(userId, args[0], args[1]);
    await ctx.reply(`✅ <b>График сохранен!</b> с ${args[0]} до ${args[1]}.`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
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

    if (!customText) return await ctx.reply('❌ Ошибка. Напишите текст после `/set`.', { parse_mode: 'HTML' });

    stepState.delete(userId);
    replyCache.set(userId, customText);
    db.setCustomReply(userId, customText).catch((e) => console.error('DB error:', e.message));

    await ctx.reply(`✅ <b>Успешно сохранено!</b>\n\n${escapeHTML(customText)}`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

// ===== ОБРАБОТЧИКИ INLINE-КНОПОК ГЛАВНОГО МЕНЮ =====

bot.callbackQuery('toggle_autoreply', async (ctx) => {
  const userId = String(ctx.from.id);
  if (isAutoReplyActive(userId)) {
    autoOffUntil.set(userId, Date.now() + AUTO_OFF_DURATION);
    await ctx.answerCallbackQuery({ text: '🔕 Автоответчик выключен на 5 минут' });
  } else {
    autoOffUntil.delete(userId);
    await ctx.answerCallbackQuery({ text: '🔔 Автоответчик включен!' });
  }
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: getMainInlineKeyboard(userId, await getTimerMode(userId)) });
  } catch (e) {}
});

bot.callbackQuery('toggle_timer_mode', async (ctx) => {
  const userId = String(ctx.from.id);
  const current = await getTimerMode(userId);
  const next = !current;
  timerModeCache.set(userId, next);
  await db.setTimerMode(userId, next).catch((e) => console.error('DB error:', e.message));

  await ctx.answerCallbackQuery({
    text: next
      ? '⏱ Включено: 1 автоответ раз в 15 минут на чат.'
      : '⛔ Выключено: автоответ снова на каждое сообщение.'
  });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: getMainInlineKeyboard(userId, next) });
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
  const currentReply = replyCache.get(userId) || await db.getCustomReply(userId).catch(() => null);

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
  replyCache.delete(userId);
  await db.setCustomReply(userId, null).catch((e) => console.error('DB error:', e.message));
  stepState.delete(userId);

  await ctx.reply('🗑️ <b>Ваш автоответ успешно сброшен!</b> Теперь будет отправляться стандартный текст.', { parse_mode: 'HTML' });
});

bot.callbackQuery('set_time', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    '⏰ <b>Настройка рабочего времени:</b>\n\n' +
    'Отправьте команду с желаемым временем.\n' +
    '• Пример: <code>/time 05:00 20:00</code>\n' +
    '• Отключить лимит: <code>/time off</code>',
    { parse_mode: 'HTML' }
  );
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
  let allowedUsername = allowedUsernameCache.get(userId);
  if (allowedUsername === undefined) {
    allowedUsername = await db.getAllowedUsername(userId).catch(() => null);
    allowedUsernameCache.set(userId, allowedUsername);
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
    {  parse_mode: 'HTML' }
  );
});

bot.callbackQuery('settings_back', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  await ctx.reply('🚀 <b>Главное меню автоответчика:</b>', {
    parse_mode: 'HTML',
    reply_markup: getMainInlineKeyboard(userId, await getTimerMode(userId))
  });
});

bot.command('no', async (ctx) => {
  const arg = (ctx.match || '').trim().toLowerCase();
  if (arg !== 'us') {
    return await ctx.reply('❌ Использование: <code>/no us</code> — снять ограничение по аккаунту.', { parse_mode: 'HTML' });
  }
  const userId = String(ctx.from.id);
  allowedUsernameCache.set(userId, null);
  await db.setAllowedUsername(userId, null).catch((e) => console.error('DB error:', e.message));
  stepState.delete(userId);
  await ctx.reply('✅ <b>Ограничение по аккаунту снято.</b> Автоответчик снова работает для всех.', { parse_mode: 'HTML' });
});

bot.on('message', async (ctx, next) => {
  if (ctx.businessMessage) return next();

  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

  if (state && state.step === 'WAITING_ACCOUNT' && ctx.message.text) {
    const raw = ctx.message.text.trim().replace(/^@/, '');
    if (!raw) {
      return await ctx.reply('❌ Отправьте корректный username, например: <code>@kaguya2_0</code>', { parse_mode: 'HTML' });
    }
    const username = raw.toLowerCase();
    allowedUsernameCache.set(userId, username);
    await db.setAllowedUsername(userId, username).catch((e) => console.error('DB error:', e.message));
    stepState.delete(userId);
    return await ctx.reply(
      `✅ <b>Готово!</b> Автоответчик теперь работает только в переписке с <code>@${escapeHTML(username)}</code>.\n\n` +
      'Чтобы снять ограничение, отправьте команду <code>/no us</code>.',
      { parse_mode: 'HTML' }
    );
  }

  if (state && state.step === 'WAITING_TEXT_ONLY' && ctx.message.text) {
    const text = ctx.message.text;
    replyCache.set(userId, text);
    db.setCustomReply(userId, text).catch((e) => console.error('DB error:', e.message));
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
      let successCount = 0;
      for (const u of users) {
        try {
          await ctx.api.copyMessage(u.user_id || u.telegram_id || u, chatId, messageId);
          successCount++;
        } catch (e) {}
        await new Promise((res) => setTimeout(res, 50));
      }
      await ctx.api.sendMessage(chatId, `🎉 <b>Пост отправлен!</b> Получили: ${successCount}`, { parse_mode: 'HTML' });
    })();

    return;
  }

  if (state && state.step === 'WAITING_TEXT' && ctx.message.text) {
    stepState.set(userId, { step: 'WAITING_STICKER', text: ctx.message.text });
    return await ctx.reply('🖼️ <b>Шаг 2/2:</b> Теперь отправьте стикер:');
  }

  if (state && state.step === 'WAITING_STICKER' && ctx.message.sticker) {
    const stickerId = ctx.message.sticker.file_id;
    const comboValue = `combo:${state.text}|||${stickerId}`;
    replyCache.set(userId, comboValue);
    db.setCustomReply(userId, comboValue).catch((e) => console.error('DB error:', e.message));
    stepState.delete(userId);
    return await ctx.reply('🔥 <b>Комбо автоответ (Текст + Стикер) сохранён!</b>', { parse_mode: 'HTML' });
  }

  if (state && state.step === 'WAITING_VOICE' && (ctx.message.voice || ctx.message.audio)) {
    const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
    const value = `voice:${fileId}`;
    replyCache.set(userId, value);
    db.setCustomReply(userId, value).catch((e) => console.error('DB error:', e.message));
    stepState.delete(userId);
    return await ctx.reply('✅ <b>Голосовой/аудио автоответ сохранён!</b>', { parse_mode: 'HTML' });
  }

  return next();
});

async function isWithinWorkingHours(ownerId) {
  try {
    if (!ownerId || isAdmin(ownerId)) return true;
    const schedule = await db.getSchedule(ownerId);
    if (!schedule || !schedule.start_time || !schedule.end_time) return true;

    const now = new Date();
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [startH, startM] = schedule.start_time.split(':').map(Number);
    const [endH, endM] = schedule.end_time.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
  } catch (e) {
    return true;
  }
}

bot.on('business_message', async (ctx) => {
  try {
    if (globalThis.globalStop) return;
    const businessMessage = ctx.businessMessage;
    if (!businessMessage || businessMessage.from.is_bot) return;

    const connectionId = businessMessage.business_connection_id; 
    const chatId = String(businessMessage.chat.id);
    const messageId = businessMessage.message_id;
    const senderId = String(businessMessage.from.id);

    const uniqueKey = `${chatId}:${messageId}`;
    if (processedMessages.has(uniqueKey)) return;
    processedMessages.add(uniqueKey);
    setTimeout(() => processedMessages.delete(uniqueKey), 30 * 1000);

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

    if (!isAutoReplyActive(ownerId)) return; 

    if (senderId === ownerId) {
      localPauses.set(chatId, Date.now() + PAUSE_DURATION);
      return;
    }

    // Ограничение автоответа на конкретный аккаунт (настраивается в "⚙️ Настройки")
    let allowedUsername = allowedUsernameCache.get(ownerId);
    if (allowedUsername === undefined) {
      allowedUsername = await db.getAllowedUsername(ownerId).catch(() => null);
      allowedUsernameCache.set(ownerId, allowedUsername);
    }
    if (allowedUsername) {
      const senderUsername = (businessMessage.from.username || '').toLowerCase();
      if (senderUsername !== allowedUsername) return;
    }

    const localPauseUntil = localPauses.get(chatId);
    if (localPauseUntil && localPauseUntil > Date.now()) return;

    if (await db.isPaused?.(chatId).catch(() => false)) return;
    if (!(await isWithinWorkingHours(ownerId))) return;

    // Если владелец включил режим "⏱ Таймер 15 мин" — после автоответа этот чат ставится
    // на паузу 15 минут (новое сообщение раньше не вызовет повторный автоответ).
    // Если режим выключен (по умолчанию) — обычная защита от дублей на ~3 секунды,
    // автоответ уходит почти на каждое сообщение.
    const timerOn = await getTimerMode(ownerId);
    const cooldown = timerOn ? AUTO_REPLY_COOLDOWN : ANTI_SPAM_PAUSE;
    localPauses.set(chatId, Date.now() + cooldown);

    let replyText = replyCache.get(ownerId);
    if (!replyText) {
      replyText = await db.getCustomReply(ownerId).catch(() => null);
      if (replyText) {
        replyCache.set(ownerId, replyText);
      }
    }

    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
    }

    try {
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
    } catch (sendError) {
      const errMsg = sendError.message || String(sendError);
      if (errMsg.includes('blocked by the user') || sendError.error_code === 403) {
        return; 
      }
    }
  } catch (error) {}
});
