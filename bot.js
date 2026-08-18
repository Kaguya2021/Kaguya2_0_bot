import { Bot, InlineKeyboard, Keyboard, GrammyError } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

// Функция экранирования HTML-тегов для защиты от ошибок Telegram API
function escapeHTML(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Список ошибок Telegram API, которые не нужно логировать
const SILENT_ERROR_PATTERNS = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  'CHAT_WRITE_FORBIDDEN',
  'not enough rights',
  'bot was kicked'
];

// Глобальный обработчик ошибок (полностью скрывает ошибки блокировки юзерами)
bot.catch((err) => {
  const e = err.error;
  const description = e?.description || err?.message || String(err);

  if (e instanceof GrammyError) {
    if (
      e.error_code === 403 ||
      SILENT_ERROR_PATTERNS.some((p) => description.includes(p))
    ) {
      return;
    }
  } else if (SILENT_ERROR_PATTERNS.some((p) => description.includes(p))) {
    return;
  }

  const updateId = err?.ctx?.update?.update_id;
  console.error(`❌ BotError [update ${updateId ?? '?'}]: ${description}`);
});

const ADMIN_IDS = ['6511859639', '7470537453'];

const PAUSE_DURATION = 10 * 60 * 1000;    
const ANTI_SPAM_PAUSE = 3000;          
const AUTO_OFF_DURATION = 5 * 60 * 1000; 

const processedMessages = new Set();
const localPauses = new Map();
const replyCache = new Map();
const stepState = new Map();
const autoOffUntil = new Map(); 
const connectionOwners = new Map();

// Проверяет, активен ли автоответ у пользователя
function isAutoReplyActive(userId) {
  const until = autoOffUntil.get(userId);
  if (!until) return true;
  if (Date.now() >= until) {
    autoOffUntil.delete(userId);
    return true;
  }
  return false;
}

// Сколько минут осталось до автовключения
function getAutoOffMinutesLeft(userId) {
  const until = autoOffUntil.get(userId);
  if (!until) return 0;
  return Math.max(1, Math.ceil((until - Date.now()) / 60000));
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

async function getMainKeyboard(userId) {
  const isActive = isAutoReplyActive(userId);
  const statusButtonText = isActive
    ? '🔕 Выключить автоответ (5 мин)'
    : `🔔 Включить автоответ (осталось ${getAutoOffMinutesLeft(userId)} мин)`;

  const kb = new Keyboard()
    .text(statusButtonText).row()
    .text('✍️ Установить текст').text('🎤 Голосовой автоответ').row()
    .text('🖼️ Комбо (Текст + Стикер)').text('🔍 Мой автоответ').row()
    .text('⏰ Настроить время').text('🗑️ Сбросить').row();

  if (isAdmin(userId)) {
    kb.text('🔒 ADMINPPA').row();
  }

  return kb.resized();
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

  const inlineKb = new InlineKeyboard()
    .url('📢 Подписаться на канал', 'https://t.me/kaguya_2_0_bots');

  await ctx.reply(welcomeText, { 
    parse_mode: 'HTML', 
    reply_markup: inlineKb, 
    disable_web_page_preview: true 
  });

  await ctx.reply('🚀 <b>Главное меню автоответчика:</b>', {
    reply_markup: await getMainKeyboard(userId)
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

bot.hears(/^🔕 Выключить автоответ/, async (ctx) => {
  const userId = String(ctx.from.id);
  autoOffUntil.set(userId, Date.now() + AUTO_OFF_DURATION);
  await ctx.reply(
    '🔕 <b>Автоответчик выключен на 5 минут.</b>\n' +
    'После этого он автоматически включится обратно. Если нужно включить раньше — нажмите кнопку ниже.',
    {
      parse_mode: 'HTML',
      reply_markup: await getMainKeyboard(userId)
    }
  );
});

bot.hears(/^🔔 Включить автоответ/, async (ctx) => {
  const userId = String(ctx.from.id);
  autoOffUntil.delete(userId);
  await ctx.reply('🔔 <b>Автоответчик включен!</b> Бот снова готов к работе.', {
    parse_mode: 'HTML',
    reply_markup: await getMainKeyboard(userId)
  });
});

bot.hears('✍️ Установить текст', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT_ONLY' });
  await ctx.reply('✍️ <b>Напишите текст автоответа, который вы хотите установить:</b>', { parse_mode: 'HTML' });
});

bot.hears('🎤 Голосовой автоответ', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_VOICE' });
  await ctx.reply('🎤 <b>Отправьте или перешлите мне голосовое сообщение для автоответа:</b>', { parse_mode: 'HTML' });
});

bot.hears('🖼️ Комбо (Текст + Стикер)', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT' });
  await ctx.reply('✍️ <b>Шаг 1/2:</b> Напишите текст, который должен отправляться со стикером:', { parse_mode: 'HTML' });
});

bot.hears('🔍 Мой автоответ', async (ctx) => {
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

bot.hears('🗑️ Сбросить', async (ctx) => {
  const userId = String(ctx.from.id);
  replyCache.delete(userId);
  await db.setCustomReply(userId, null).catch((e) => console.error('DB error:', e.message));
  stepState.delete(userId);

  await ctx.reply('🗑️ <b>Ваш автоответ успешно сброшен!</b> Теперь будет отправляться стандартный текст.', { parse_mode: 'HTML' });
});

bot.hears('⏰ Настроить время', async (ctx) => {
  await ctx.reply(
    '⏰ <b>Настройка рабочего времени:</b>\n\n' +
    'Отправьте команду с желаемым временем.\n' +
    '• Пример: <code>/time 05:00 20:00</code>\n' +
    '• Отключить лимит: <code>/time off</code>',
    { parse_mode: 'HTML' }
  );
});

bot.hears('🔒 ADMINPPA', async (ctx) => {
  if (isAdmin(ctx.from.id)) {
    await showAdminPanel(ctx);
  }
});

// Защита от перехвата кнопок меню и обработка шагов ввода
bot.on('message', async (ctx, next) => {
  if (ctx.businessMessage) return next();

  // Игнорируем нажатия кнопок меню, чтобы они не перехватывались как текст
  const menuButtons = [
    '🔕 Выключить автоответ', '🔔 Включить автоответ', 
    '✍️ Установить текст', '🎤 Голосовой автоответ', 
    '🖼️ Комбо (Текст + Стикер)', '🔍 Мой автоответ', 
    '⏰ Настроить время', '🗑️ Сбросить', '🔒 ADMINPPA'
  ];
  if (ctx.message.text && menuButtons.some(btn => ctx.message.text.startsWith(btn))) {
    return next();
  }

  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

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

  if (state && state.step === 'WAITING_VOICE' && ctx.message.voice) {
    const fileId = ctx.message.voice.file_id;
    const value = `voice:${fileId}`;
    replyCache.set(userId, value);
    db.setCustomReply(userId, value).catch((e) => console.error('DB error:', e.message));
    stepState.delete(userId);
    return await ctx.reply('✅ <b>Голосовой автоответ сохранён!</b>', { parse_mode: 'HTML' });
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

    const localPauseUntil = localPauses.get(chatId);
    if (localPauseUntil && localPauseUntil > Date.now()) return;

    if (await db.isPaused?.(chatId).catch(() => false)) return;
    if (!(await isWithinWorkingHours(ownerId))) return;

    localPauses.set(chatId, Date.now() + ANTI_SPAM_PAUSE);

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
        await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
        return;
      }

      await ctx.api.sendMessage(chatId, escapeHTML(replyText), { business_connection_id: connectionId, parse_mode: 'HTML' });
    } catch (sendError) {
      const errMsg = sendError.message || String(sendError);
      if (errMsg.includes('blocked by the user') || sendError.error_code === 403) {
        return; 
      }
      try {
        if (db.saveErrorLog) await db.saveErrorLog(chatId, 'SEND_ERROR', errMsg);
      } catch (e) {}
    }
  } catch (error) {}
});
