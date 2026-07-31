import { Bot, InlineKeyboard } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

// Список администраторов бота
const ADMIN_IDS = ['6511859639'];

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
  
  // Регистрация/обновление пользователя в БД
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
    localPauses.set(target, Date.now() + 24 * 60 * 60 * 1000); // Остановка на 24ч
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

// --- АДМИН-КОМАНДА /m (Рассылка текста) ---
bot.command('m', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const text = ctx.message.text.replace(/^\/m\s*/i, '').trim();

  if (!text) {
    return await ctx.reply('❌ Напишите текст после команды. Пример: <code>/m Привет всем!</code>', { parse_mode: 'HTML' });
  }

  const users = (await db.getAllUsers?.()) || [];
  let successCount = 0;

  for (const u of users) {
    try {
      await ctx.api.sendMessage(u.user_id, text, { parse_mode: 'HTML' });
      successCount++;
    } catch (e) {}
  }

  await ctx.reply(`📢 <b>Рассылка завершена!</b> Доставлено пользователям: ${successCount}`, { parse_mode: 'HTML' });
});

// --- АДМИН-КОМАНДА /mm (Личное сообщение) ---
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

// --- АДМИН-КОМАНДА /info (Информация о пользователе) ---
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

// --- АДМИН-КОМАНДА /post (Мультимедиа рассылка) ---
bot.command('post', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const userId = String(ctx.from.id);
  stepState.set(userId, { step: 'WAITING_POST' });
  await ctx.reply('📢 <b>Режим создания поста:</b>\n\nОтправьте следующий пост (это может быть текст, фото с подписью или стикер). Я разошлю его всем пользователям!', { parse_mode: 'HTML' });
});

// --- КОМАНДА /time (Настройка расписания) ---
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

// --- ОБРАБОТКА ПОШАГОВЫХ ДЕЙСТВИЙ И ПОСТОВ ---
bot.on('message', async (ctx, next) => {
  if (ctx.businessMessage) return next();

  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

  // Обработка /post рассылки для админа
  if (state && state.step === 'WAITING_POST' && isAdmin(userId)) {
    stepState.delete(userId);
    await ctx.reply('🚀 Начинаю рассылку поста...');

    const users = (await db.getAllUsers?.()) || [];
    let successCount = 0;

    for (const u of users) {
      try {
        await ctx.api.copyMessage(u.user_id, ctx.chat.id, ctx.message.message_id);
        successCount++;
      } catch (e) {}
    }

    return await ctx.reply(`🎉 <b>Пост успешно отправлен!</b> Получили пользователей: ${successCount}`, { parse_mode: 'HTML' });
  }

  // Обработка /sred
  if (state && state.step === 'WAITING_TEXT' && ctx.message.text) {
    stepState.set(userId, { step: 'WAITING_STICKER', text: ctx.message.text });
    return await ctx.reply('🖼️ <b>Шаг 2/2:</b> Отправьте стикер или вставьте ID стикера:');
  }

  // Обработка стикера для /sred
  if (state && state.step === 'WAITING_STICKER' && ctx.message.sticker) {
    const stickerId = ctx.message.sticker.file_id;
    const comboValue = `combo:${state.text}|||${stickerId}`;
    replyCache.set(userId, comboValue);
    db.setCustomReply(userId, comboValue).catch(console.error);
    stepState.delete(userId);

    return await ctx.reply('🔥 <b>Отлично!</b> Комбо автоответ (Текст + Стикер) успешно установлен!', { parse_mode: 'HTML' });
  }

  // Обработка голосового
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

    // ЕСЛИ НАПИСАЛ АДМИН/ВЛАДЕЛЕЦ БОТА — РАБОТАЕТ ВСЕГДА КРУГЛОСУТОЧНО
    if (isAdmin(ownerId)) return true;

    const schedule = await db.getSchedule(ownerId);
    if (!schedule || !schedule.start_time || !schedule.end_time) return true;

    // Расчет времени по UTC
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

    // Получение подключения владельца
    let ownerId = null;
    try {
      const conn = await ctx.getBusinessConnection();
      if (conn && conn.user) {
        ownerId = String(conn.user.id);
      }
    } catch (e) {}

    // 2. ЕСЛИ НАПИСАЛ САМ ВЛАДЕЛЬЦ АККАУНТА — СТАВИМ ЛОКАЛЬНУЮ ПАУЗУ
    if (ownerId && senderId === ownerId) {
      localPauses.set(chatId, Date.now() + PAUSE_DURATION);
      console.log(`🛑 Владелец ответил сам в чате ${chatId}. Пауза 10 мин.`);
      return;
    }

    // 3. ПРОВЕРКА ПАУЗ
    const localPauseUntil = localPauses.get(chatId);
    if (localPauseUntil && localPauseUntil > Date.now()) return;

    const isDbPaused = await db.isPaused?.(chatId).catch(() => false);
    if (isDbPaused) return;

    // 4. ПРОВЕРКА РАБОЧИХ ЧАСОВ ПОЛЬЗОВАТЕЛЯ (Админы всегда активны)
    const active = await isWithinWorkingHours(ownerId);
    if (!active) return;

    // Анти-спам задержка (3 секунды)
    localPauses.set(chatId, Date.now() + ANTI_SPAM_PAUSE);

    // 5. ПОИСК НАСТРОЕК АВТООТВЕТА
    let replyText = null;

    if (ownerId) {
      replyText = replyCache.get(ownerId) || await db.getCustomReply(ownerId).catch(() => null);
    }

    // ЕСЛИ У ПОЛЬЗОВАТЕЛЯ НЕТ СВОЕГО ТЕКСТА — СТАВИМ ДЕФОЛТНЫЙ
    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
    } else if (ownerId) {
      replyCache.set(ownerId, replyText);
    }

    // 6. ОТПРАВКА ОТВЕТА
    let incomingContent = businessMessage.text || businessMessage.caption || '[Медиа]';
    if (db.saveMessage) db.saveMessage(chatId, 'user', incomingContent).catch(() => {});

    // А) КОМБО (ТЕКСТ + СТИКЕР)
    if (replyText.startsWith('combo:')) {
      const parts = replyText.replace('combo:', '').split('|||');
      const textToReply = parts[0];
      const stickerToReply = parts[1];

      if (textToReply) {
        await ctx.api.sendMessage(chatId, textToReply, { business_connection_id: connectionId, parse_mode: 'HTML' });
      }
      if (stickerToReply) {
        await ctx.api.sendSticker(chatId, stickerToReply, { business_connection_id: connectionId });
      }
      if (db.saveMessage) db.saveMessage(chatId, 'assistant', `[КомБО: Текст + Стикер]`).catch(() => {});
      return;
    }

    // Б) ГОЛОСОВОЕ
    if (replyText.startsWith('voice:')) {
      const voiceFileId = replyText.replace('voice:', '').trim();
      await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
      if (db.saveMessage) db.saveMessage(chatId, 'assistant', `[Голосовое]`).catch(() => {});
      return;
    }

    // В) СТИКЕР
    if (replyText.startsWith('sticker:')) {
      const stickerFileId = replyText.replace('sticker:', '').trim();
      await ctx.api.sendSticker(chatId, stickerFileId, { business_connection_id: connectionId });
      if (db.saveMessage) db.saveMessage(chatId, 'assistant', `[Стикер]`).catch(() => {});
      return;
    }

    // Г) ТЕКСТ
    await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId, parse_mode: 'HTML' });
    if (db.saveMessage) db.saveMessage(chatId, 'assistant', replyText).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
