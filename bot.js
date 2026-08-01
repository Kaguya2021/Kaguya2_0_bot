import { Bot, InlineKeyboard } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

// Список администраторов бота
const ADMIN_IDS = ['6511859639', '7470537453'];

const PAUSE_DURATION = 10 * 60 * 1000; // Пауза 10 минут при ответе владельца
const ANTI_SPAM_PAUSE = 3000;          // Анти-спам пауза 3 секунды

const processedMessages = new Set();
const localPauses = new Map();
const replyCache = new Map();

// Состояния для пошаговых команд (/sred и /post)
const stepState = new Map();

// Вспомогательная функция проверки админа
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

// --- КОМАНДА /start ---
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
    '✍️ <b>Обычный текст:</b> <code>/set Твой текст</code>\n' +
    '🎤 <b>Голосовое:</b> <code>/set gs</code>\n' +
    '🖼️ <b>Комбо (Текст + Стикер):</b> <code>/sred</code>\n' +
    '🔍 <b>Мой автоответ:</b> <code>/my</code>\n' +
    '🗑️ <b>Сбросить автоответ:</b> <code>/reset</code>\n' +
    '⏰ <b>Рабочие часы:</b> <code>/time 05:00 20:00</code> (Задать время работы)\n' +
    '❌ <b>Сбросить часы:</b> <code>/time off</code>';

  const keyboard = new InlineKeyboard()
    .url('📢 Подписаться на канал', 'https://t.me/kaguya_2_0_bots');

  await ctx.reply(welcomeText, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
});

// --- КОМАНДА /admins ---
bot.command('admins', async (ctx) => {
  await ctx.reply(
    '🔒 <b>Раздел для администраторов</b>\n\n' +
    'Эта система предназначена только для администраторов, которых добавил лично создатель проекта.\n\n' +
    '💬 Если вы хотите получить доступ или задать вопрос, попробуйте написать создателю бота (но не факт, что он сделает вас админом!).',
    { parse_mode: 'HTML' }
  );
});

// --- КОМАНДА /my ---
bot.command('my', async (ctx) => {
  const userId = String(ctx.from.id);
  const currentReply = replyCache.get(userId) || await db.getCustomReply(userId).catch(() => null);

  if (!currentReply) {
    return await ctx.reply('ℹ️ У вас установлен <b>дефолтный текст</b>:\n<i>Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓</i>', { parse_mode: 'HTML' });
  }

  if (currentReply.startsWith('combo:')) {
    const parts = currentReply.replace('combo:', '').split('|||');
    return await ctx.reply(`🔥 <b>Ваш автоответ (Комбо):</b>\n\n📝 Текст: <code>${parts[0]}</code>\n🖼️ Sticker ID: <code>${parts[1]}</code>`, { parse_mode: 'HTML' });
  }

  if (currentReply.startsWith('voice:')) {
    const voiceId = currentReply.replace('voice:', '');
    return await ctx.reply(`🎤 <b>Ваш автоответ (Голосовое):</b>\nID файла: <code>${voiceId}</code>`, { parse_mode: 'HTML' });
  }

  await ctx.reply(`✍️ <b>Ваш текущий автоответ:</b>\n\n${currentReply}`, { parse_mode: 'HTML' });
});

// --- КОМАНДА /reset ИЛИ /clear ---
bot.command(['reset', 'clear'], async (ctx) => {
  const userId = String(ctx.from.id);
  replyCache.delete(userId);
  await db.setCustomReply(userId, null).catch(console.error);
  stepState.delete(userId);

  await ctx.reply('🗑️ <b>Ваш автоответ успешно сброшен!</b> Теперь будет отправляться стандартный дефолтный текст.', { parse_mode: 'HTML' });
});

// --- АДМИН-КОМАНДА /setreply ---
bot.command('setreply', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const fullText = ctx.message.text.replace(/^\/setreply\s*/i, '').trim();
  const args = fullText.split(/\s+/);
  const targetId = args[0];
  const newReply = args.slice(1).join(' ');

  if (!targetId || !newReply) {
    return await ctx.reply(
      '👑 <b>Использование админ-редактора автоответа:</b>\n\n' +
      '• <b>Текст:</b> <code>/setreply ID Новый текст</code>\n' +
      '• <b>Сброс:</b> <code>/setreply ID clear</code>\n' +
      '• <b>Голос:</b> <code>/setreply ID voice:FILE_ID</code>\n' +
      '• <b>Комбо:</b> <code>/setreply ID combo:Текст|||STICKER_ID</code>',
      { parse_mode: 'HTML' }
    );
  }

  try {
    if (newReply.toLowerCase() === 'clear') {
      replyCache.delete(targetId);
      await db.setCustomReply(targetId, null);
      return await ctx.reply(`✅ Автоответ для ID <code>${targetId}</code> успешно сброшен на стандартный!`, { parse_mode: 'HTML' });
    }

    replyCache.set(targetId, newReply);
    await db.setCustomReply(targetId, newReply);

    await ctx.reply(`👑 <b>Успешно отредактировано!</b>\n\nНовый автоответ для ID <code>${targetId}</code>:\n<code>${newReply}</code>`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ Ошибка при изменении: ${e.message}`);
  }
});

// --- АДМИН-КОМАНДЫ: /stop И /unstop ---
bot.command('stop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.trim().split(/\s+/);
  const target = args[1]?.toLowerCase();

  if (target === 'all') {
    globalThis.globalStop = true;
    return await ctx.reply('🛑 <b>Глобальный автоответчик ОСТАНОВЛЕН для всех пользователей!</b>', { parse_mode: 'HTML' });
  }

  if (target) {
    localPauses.set(target, Date.now() + 24 * 60 * 60 * 1000);
    if (db.setPause) db.setPause(target, 24 * 60 * 60 * 1000).catch(() => {});
    return await ctx.reply(`🛑 Автоответчик остановлен для пользователя ID: <code>${target}</code>`, { parse_mode: 'HTML' });
  }

  await ctx.reply('❌ Использование: <code>/stop all</code> или <code>/stop <USER_ID></code>', { parse_mode: 'HTML' });
});

bot.command('unstop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.trim().split(/\s+/);
  const target = args[1]?.toLowerCase();

  if (target === 'all') {
    globalThis.globalStop = false;
    return await ctx.reply('✅ <b>Глобальный автоответчик СНОВА ВКЛЮЧЕН для всех!</b>', { parse_mode: 'HTML' });
  }

  if (target) {
    localPauses.delete(target);
    if (db.removePause) db.removePause(target).catch(() => {});
    return await ctx.reply(`✅ Автоответчик снова возобновлен для пользователя ID: <code>${target}</code>`, { parse_mode: 'HTML' });
  }

  await ctx.reply('❌ Использование: <code>/unstop all</code> или <code>/unstop <USER_ID></code>', { parse_mode: 'HTML' });
});

// --- АДМИН-КОМАНДА /m (ОПТИМИЗИРОВАННАЯ ФОНОВАЯ РАССЫЛКА) ---
bot.command('m', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const text = ctx.message.text.replace(/^\/m\s*/i, '').trim();

  if (!text) {
    return await ctx.reply('❌ Напишите текст после команды. Пример: <code>/m Привет всем!</code>', { parse_mode: 'HTML' });
  }

  const users = (await db.getAllUsers?.()) || [];
  await ctx.reply(`📢 <b>Начинаю рассылку...</b> Всего получателей: ${users.length}`, { parse_mode: 'HTML' });

  // Запуск рассылки в фоновом режиме (без блокировки бота)
  (async () => {
    let successCount = 0;
    for (const u of users) {
      try {
        await ctx.api.sendMessage(u.user_id, text, { parse_mode: 'HTML' });
        successCount++;
      } catch (e) {}
      await new Promise((res) => setTimeout(res, 50)); // Пауза 50мс для плавной отправки
    }
    await ctx.reply(`🎉 <b>Рассылка текста завершена!</b> Доставлено: ${successCount}`, { parse_mode: 'HTML' });
  })();
});

// --- АДМИН-КОМАНДА /mm ---
bot.command('mm', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.replace(/^\/mm\s*/i, '').trim().split(/\s+/);
  const targetId = args[0];
  const messageText = args.slice(1).join(' ');

  if (!targetId || !messageText) {
    return await ctx.reply('❌ Использование: <code>/mm <ID> <Сообщение></code>', { parse_mode: 'HTML' });
  }

  try {
    await ctx.api.sendMessage(targetId, messageText, { parse_mode: 'HTML' });
    await ctx.reply(`✅ Сообщение успешно отправлено пользователю <code>${targetId}</code>`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ Не удалось отправить сообщение: ${e.message}`);
  }
});

// --- АДМИН-КОМАНДА /info ---
bot.command('info', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.trim().split(/\s+/);
  const targetId = args[1];

  if (!targetId) {
    return await ctx.reply('❌ Укажите ID: <code>/info <USER_ID></code>', { parse_mode: 'HTML' });
  }

  try {
    const userInfo = (await db.getUserInfo?.(targetId)) || {};
    const customReply = (await db.getCustomReply?.(targetId)) || 'Стандартный дефолтный текст';
    const schedule = (await db.getSchedule?.(targetId)) || null;

    let infoText = `📊 <b>Информация о пользователе ID:</b> <code>${targetId}</code>\n\n`;
    infoText += `📅 <b>Подключен:</b> ${userInfo.created_at || 'Неизвестно'}\n`;
    infoText += `👤 <b>Username/Имя:</b> ${userInfo.username || 'Нет данных'}\n`;
    infoText += `💬 <b>Текущий автоответ:</b>\n<code>${customReply}</code>\n\n`;
    infoText += `⏰ <b>График работы:</b> ${schedule?.start_time ? `${schedule.start_time} - ${schedule.end_time}` : 'Круглосуточно'}`;

    await ctx.reply(infoText, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ Ошибка получения информации: ${e.message}`);
  }
});

// --- АДМИН-КОМАНДА /post ---
bot.command('post', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const userId = String(ctx.from.id);
  stepState.set(userId, { step: 'WAITING_POST' });
  await ctx.reply('📢 <b>Режим создания поста:</b>\n\nОтправьте следующий пост. Я разошлю его всем пользователям!', { parse_mode: 'HTML' });
});

// --- КОМАНДА /time ---
bot.command('time', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const fullText = ctx.message.text || '';
    const args = fullText.replace(/^\/time\s*/i, '').trim().split(/\s+/);

    if (args[0] && args[0].toLowerCase() === 'off') {
      await db.setSchedule(userId, null, null);
      return await ctx.reply('✅ <b>Ограничение по времени отключено.</b> Бот работает круглосуточно!', { parse_mode: 'HTML' });
    }

    if (args.length < 2) {
      return await ctx.reply(
        '❌ <b>Неверный формат!</b>\n\n' +
        'Укажите время начала и конца работы.\n' +
        'Пример: <code>/time 05:00 20:00</code>\n' +
        'Чтобы отключить: <code>/time off</code>',
        { parse_mode: 'HTML' }
      );
    }

    const start = args[0];
    const end = args[1];

    await db.setSchedule(userId, start, end);
    await ctx.reply(`✅ <b>График работы сохранен!</b>\n\nАвтоответчик будет работать с <b>${start}</b> до <b>${end}</b>.`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Ошибка настройки времени: ${err.message}`);
  }
});

// --- КОМАНДА /sred ---
bot.command('sred', async (ctx) => {
  const userId = String(ctx.from.id);
  stepState.set(userId, { step: 'WAITING_TEXT' });
  await ctx.reply('✍️ <b>Шаг 1/2:</b> Напишите текст, который должен отправляться в автоответе:', { parse_mode: 'HTML' });
});

// --- КОМАНДА /set ---
bot.command('set', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const fullText = ctx.message.text || '';
    const customText = fullText.replace(/^\/set\s*/i, '').trim();

    if (customText.toLowerCase() === 'gs') {
      stepState.set(userId, { step: 'WAITING_VOICE' });
      return await ctx.reply('🎤 <b>Отправьте или перешлите мне голосовое сообщение:</b>', { parse_mode: 'HTML' });
    }

    if (!customText) {
      return await ctx.reply('❌ Ошибка. Напишите текст после `/set`.', { parse_mode: 'HTML' });
    }

    stepState.delete(userId);
    replyCache.set(userId, customText);
    db.setCustomReply(userId, customText).catch(console.error);

    await ctx.reply(`✅ <b>Успешно сохранено!</b>\n\n${customText}`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

// --- ОБРАБОТКА ПОШАГОВЫХ ДЕЙСТВИЙ И ПОСТОВ (ОПТИМИЗИРОВАННАЯ ФОНОВАЯ РАССЫЛКА) ---
bot.on('message', async (ctx, next) => {
  if (ctx.businessMessage) return next();

  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

  if (state && state.step === 'WAITING_POST' && isAdmin(userId)) {
    stepState.delete(userId);
    await ctx.reply('🚀 <b>Начинаю рассылку поста...</b>', { parse_mode: 'HTML' });

    const users = (await db.getAllUsers?.()) || [];
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    // Фоновая рассылка поста без лагов
    (async () => {
      let successCount = 0;
      for (const u of users) {
        try {
          await ctx.api.copyMessage(u.user_id, chatId, messageId);
          successCount++;
        } catch (e) {}
        await new Promise((res) => setTimeout(res, 50)); // Пауза 50мс
      }
      await ctx.api.sendMessage(chatId, `🎉 <b>Пост успешно отправлен!</b> Получили пользователей: ${successCount}`, { parse_mode: 'HTML' });
    })();

    return;
  }

  if (state && state.step === 'WAITING_TEXT' && ctx.message.text) {
    stepState.set(userId, { step: 'WAITING_STICKER', text: ctx.message.text });
    return await ctx.reply('🖼️ <b>Шаг 2/2:</b> Отправьте стикер или вставьте ID стикера:');
  }

  if (state && state.step === 'WAITING_STICKER' && ctx.message.sticker) {
    const stickerId = ctx.message.sticker.file_id;
    const comboValue = `combo:${state.text}|||${stickerId}`;
    replyCache.set(userId, comboValue);
    db.setCustomReply(userId, comboValue).catch(console.error);
    stepState.delete(userId);

    return await ctx.reply('🔥 <b>Отлично!</b> Комбо автоответ (Текст + Стикер) успешно установлен!', { parse_mode: 'HTML' });
  }

  if (state && state.step === 'WAITING_VOICE' && ctx.message.voice) {
    const fileId = ctx.message.voice.file_id;
    const value = `voice:${fileId}`;
    replyCache.set(userId, value);
    db.setCustomReply(userId, value).catch(console.error);
    stepState.delete(userId);
    return await ctx.reply('✅ <b>Голосовое сообщение успешно сохранено на автоответ!</b>', { parse_mode: 'HTML' });
  }

  return next();
});

// --- ФУНКЦИЯ ПРОВЕРКИ РАБОЧИХ ЧАСОВ ---
async function isWithinWorkingHours(ownerId) {
  try {
    if (!ownerId) return true;
    if (isAdmin(ownerId)) return true;

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
    console.error('Ошибка при проверке рабочего времени:', e);
    return true;
  }
}

// --- АВТОМАТИЗАЦИЯ БИЗНЕС-ЧАТОВ ---
bot.on('business_message', async (ctx) => {
  try {
    if (globalThis.globalStop) return;

    const businessMessage = ctx.businessMessage;
    if (!businessMessage) return;

    const connectionId = businessMessage.business_connection_id; 
    const chatId = String(businessMessage.chat.id);
    const messageId = businessMessage.message_id;
    const senderId = String(businessMessage.from.id);

    if (businessMessage.from.is_bot) return;

    // 1. ЗАЩИТА ОТ ДУБЛЕЙ
    const uniqueKey = `${chatId}:${messageId}`;
    if (processedMessages.has(uniqueKey)) return;
    processedMessages.add(uniqueKey);
    setTimeout(() => processedMessages.delete(uniqueKey), 30 * 1000);

    let ownerId = null;
    try {
      const conn = await ctx.getBusinessConnection();
      if (conn && conn.user) {
        ownerId = String(conn.user.id);
      }
    } catch (e) {}

    // 2. ВЛАДЕЛЕЦ ОТВЕТИЛ САМ
    if (ownerId && senderId === ownerId) {
      localPauses.set(chatId, Date.now() + PAUSE_DURATION);
      return;
    }

    // 3. ПРОВЕРКА ПАУЗ
    const localPauseUntil = localPauses.get(chatId);
    if (localPauseUntil && localPauseUntil > Date.now()) return;

    const isDbPaused = await db.isPaused?.(chatId).catch(() => false);
    if (isDbPaused) return;

    // 4. ПРОВЕРКА РАБОЧИХ ЧАСОВ
    const active = await isWithinWorkingHours(ownerId);
    if (!active) return;

    localPauses.set(chatId, Date.now() + ANTI_SPAM_PAUSE);

    // 5. ПОИСК НАСТРОЕК АВТООТВЕТА
    let replyText = null;

    if (ownerId) {
      replyText = replyCache.get(ownerId) || await db.getCustomReply(ownerId).catch(() => null);
    }

    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
    } else if (ownerId) {
      replyCache.set(ownerId, replyText);
    }

    // 6. ОТПРАВКА ОТВЕТА (ЗАПИСЬ В БД ТОЛЬКО ПРИ ОШИБКАХ/БАНАХ)
    try {
      if (replyText.startsWith('combo:')) {
        const parts = replyText.replace('combo:', '').split('|||');
        if (parts[0]) await ctx.api.sendMessage(chatId, parts[0], { business_connection_id: connectionId, parse_mode: 'HTML' });
        if (parts[1]) await ctx.api.sendSticker(chatId, parts[1], { business_connection_id: connectionId });
        return;
      }

      if (replyText.startsWith('voice:')) {
        const voiceFileId = replyText.replace('voice:', '').trim();
        await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
        return;
      }

      if (replyText.startsWith('sticker:')) {
        const stickerFileId = replyText.replace('sticker:', '').trim();
        await ctx.api.sendSticker(chatId, stickerFileId, { business_connection_id: connectionId });
        return;
      }

      await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId, parse_mode: 'HTML' });

    } catch (sendError) {
      const errorMsg = sendError.description || sendError.message || 'Ошибка отправки';
      console.error(`⚠️ Ошибка автоответа в чате ${chatId}:`, errorMsg);

      // Пишем в БД только если произошла ошибка (например, бан бота)
      if (db.saveErrorLog) {
        await db.saveErrorLog(chatId, 'SEND_ERROR', errorMsg);
      }
    }

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
