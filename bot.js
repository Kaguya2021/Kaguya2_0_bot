import { Bot } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

const PAUSE_DURATION = 10 * 60 * 1000; // Пауза 10 минут при вашем ответе
const ANTI_SPAM_PAUSE = 3000;          // Анти-спам пауза 3 секунды

const processedMessages = new Set();
const localPauses = new Map();
const replyCache = new Map();

// Состояния для пошаговой настройки /sred
const stepState = new Map(); 

// --- КОМАНДА /start ---
bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 <b>Привет! Я бот Кагуя 2.0.</b>\n\n' +
    '⚙️ Я работаю как автоответчик для вашего Telegram Business!\n\n' +
    '✍️ <b>Обычный текст:</b> <code>/set Твой текст</code>\n' +
    '🎤 <b>Голосовое:</b> <code>/set gs</code>\n' +
    '🖼️ <b>Комбо (Текст + Стикер):</b> <code>/sred</code>\n' +
    '⏰ <b>Рабочие часы:</b> <code>/time 05:00 20:00</code> (Задать время работы)\n' +
    '❌ <b>Сбросить часы:</b> <code>/time off</code>',
    { parse_mode: 'HTML' }
  );
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

// --- КОМАНДА /sred (Комбо: Текст + Стикер) ---
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

// --- ОБРАБОТКА ОБЫЧНЫХ СООБЩЕНИЙ В ЛИЧКЕ БОТА (Для пошаговых команд) ---
bot.on('message:text', async (ctx, next) => {
  if (ctx.businessMessage) return next();

  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

  if (state && state.step === 'WAITING_TEXT') {
    stepState.set(userId, { step: 'WAITING_STICKER', text: ctx.message.text });
    return await ctx.reply('🖼️ <b>Шаг 2/2:</b> Отправьте стикер или вставьте ID стикера:');
  }

  return next();
});

// --- ОБРАБОТКА СТИКЕРОВ ---
bot.on('message:sticker', async (ctx) => {
  if (ctx.businessMessage) return;

  const userId = String(ctx.from.id);
  const stickerId = ctx.message.sticker.file_id;
  const state = stepState.get(userId);

  if (state && state.step === 'WAITING_STICKER') {
    const comboValue = `combo:${state.text}|||${stickerId}`;
    replyCache.set(userId, comboValue);
    db.setCustomReply(userId, comboValue).catch(console.error);
    stepState.delete(userId);

    return await ctx.reply('🔥 <b>Отлично!</b> Комбо автоответ (Текст + Стикер) успешно установлен!', { parse_mode: 'HTML' });
  }

  await ctx.reply(
    `🆔 <b>ID этого стикера:</b>\n<code>${stickerId}</code>\n\n` +
    `👉 Установить на автоответ: <code>/set sticker:${stickerId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// --- ОБРАБОТКА ГОЛОСОВЫХ ---
bot.on('message:voice', async (ctx) => {
  if (ctx.businessMessage) return;

  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

  if (state && state.step === 'WAITING_VOICE') {
    const fileId = ctx.message.voice.file_id;
    const value = `voice:${fileId}`;
    replyCache.set(userId, value);
    db.setCustomReply(userId, value).catch(console.error);
    stepState.delete(userId);
    return await ctx.reply('✅ <b>Голосовое сообщение успешно сохранено на автоответ!</b>', { parse_mode: 'HTML' });
  }
});

// --- ВНИМАНИЕ: ФУНКЦИЯ ПРОВЕРКИ РАБОЧИХ ЧАСОВ ---
async function isWithinWorkingHours(ownerId) {
  try {
    const schedule = await db.getSchedule(ownerId);
    if (!schedule || !schedule.start_time || !schedule.end_time) return true;

    // Время в UTC+6
    const now = new Date();
    const utcHours = now.getUTCHours() + 6;
    const currentMinutes = (utcHours % 24) * 60 + now.getUTCMinutes();

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

// --- АВТОМАТИЗАЦИЯ БИЗНЕС-ЧАТОВ ---
bot.on('business_message', async (ctx) => {
  try {
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

    const conn = await ctx.getBusinessConnection();
    const ownerId = conn && conn.user ? String(conn.user.id) : null;

    if (!ownerId) return;

    // 2. ЖЕЛЕЗОБЕТОННЫЙ СТОП-ТАЙМЕР: ЕСЛИ НАПИСАЛ ВЛАДЕЛЕЦ — СТАВИМ ПАУЗУ НА 10 МИНУТ!
    if (senderId === ownerId) {
      localPauses.set(chatId, Date.now() + PAUSE_DURATION);
      db.setPause(chatId, PAUSE_DURATION).catch(() => {});
      console.log(`🛑 Владелец ответил сам в чате ${chatId}. Автоответчик на паузе.`);
      return;
    }

    // 3. ПРОВЕРКА ПАУЗЫ (И в памяти, и в БД)
    const localPauseUntil = localPauses.get(chatId);
    if (localPauseUntil && localPauseUntil > Date.now()) return;

    const isDbPaused = await db.isPaused(chatId).catch(() => false);
    if (isDbPaused) return;

    // 4. ПРОВЕРКА РАБОЧИХ ЧАСОВ ПОЛЬЗОВАТЕЛЯ
    const active = await isWithinWorkingHours(ownerId);
    if (!active) {
      console.log(`⏰ Автоответчик пользователя ${ownerId} сейчас выключен по расписанию.`);
      return;
    }

    // Анти-спам задержка (3 секунды)
    localPauses.set(chatId, Date.now() + ANTI_SPAM_PAUSE);
    db.setPause(chatId, ANTI_SPAM_PAUSE).catch(() => {});

    // ПОЛУЧЕНИЕ НАСТРОЙКИ
    let replyText = replyCache.get(ownerId);
    if (!replyText) {
      try {
        replyText = await db.getCustomReply(ownerId);
        if (replyText) replyCache.set(ownerId, replyText);
      } catch (e) {}
    }

    let incomingContent = businessMessage.text || businessMessage.caption || '[Медиа]';
    db.saveMessage(chatId, 'user', incomingContent).catch(() => {});

    // А) КОМБО (ТЕКСТ + СТИКЕР)
    if (replyText && replyText.startsWith('combo:')) {
      const parts = replyText.replace('combo:', '').split('|||');
      const textToReply = parts[0];
      const stickerToReply = parts[1];

      if (textToReply) {
        await ctx.api.sendMessage(chatId, textToReply, { business_connection_id: connectionId, parse_mode: 'HTML' });
      }
      if (stickerToReply) {
        await ctx.api.sendSticker(chatId, stickerToReply, { business_connection_id: connectionId });
      }
      db.saveMessage(chatId, 'assistant', `[Комбо: Текст + Стикер]`).catch(() => {});
      return;
    }

    // Б) ГОЛОСОВОЕ
    if (replyText && replyText.startsWith('voice:')) {
      const voiceFileId = replyText.replace('voice:', '').trim();
      await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Голосовое]`).catch(() => {});
      return;
    }

    // В) СТИКЕР
    if (replyText && replyText.startsWith('sticker:')) {
      const stickerFileId = replyText.replace('sticker:', '').trim();
      await ctx.api.sendSticker(chatId, stickerFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Стикер]`).catch(() => {});
      return;
    }

    // Г) ДЕФОЛТНЫЙ ТЕКСТ
    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
    }

    // Д) ТЕКСТ
    await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId, parse_mode: 'HTML' });
    db.saveMessage(chatId, 'assistant', replyText).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
