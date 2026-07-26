import { Bot } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

const PAUSE_DURATION = 5 * 60 * 1000; // Пауза 5 минут при твоем ответе
const ADMIN_IDS = [6511859639, 8028803176]; 

// Локальный кэш в памяти (защита от тупящей базы данных)
const processedMessages = new Set();
const localPauses = new Map();

async function sendAdminLog(text) {
  for (const adminId of ADMIN_IDS) {
    await bot.api.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
}

const waitingForVoice = new Map();

// --- КОМАНДЫ В ЛИЧКЕ С БОТОМ ---
bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 <b>Привет! Я бот Кагуя 2.0.</b>\n\n' +
    '⚙️ Я работаю как автоответчик для вашего Telegram Business!\n\n' +
    '✍️ <b>Установить текст:</b> <code>/set Твой текст</code>\n' +
    '🖼️ <b>Установить стикер:</b> <code>/set sticker:ID_стикера</code>\n' +
    '🎤 <b>Установить ГС:</b> Напиши <code>/set gs</code>',
    { parse_mode: 'HTML' }
  );
});

bot.command('set', async (ctx) => {
  try {
    const userId = String(ctx.from.id); 
    const customText = ctx.match.trim();

    if (customText.toLowerCase() === 'gs') {
      waitingForVoice.set(userId, true);
      return await ctx.reply('🎤 <b>Отправьте или перешлите мне голосовое сообщение:</b>', { parse_mode: 'HTML' });
    }

    if (!customText) {
      return await ctx.reply('❌ Ошибка. Напишите текст после `/set`.', { parse_mode: 'HTML' });
    }

    await db.setCustomReply(userId, customText);
    await ctx.reply(`✅ <b>Успешно сохранено!</b>\n\n${customText}`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.on('message:voice', async (ctx) => {
  if (ctx.businessMessage) return; // Игнорируем голосовухи из бизнес-чатов

  const userId = String(ctx.from.id);
  if (waitingForVoice.has(userId)) {
    const fileId = ctx.message.voice.file_id;
    await db.setCustomReply(userId, `voice:${fileId}`);
    waitingForVoice.delete(userId);
    return await ctx.reply('✅ <b>Голосовое сообщение успешно сохранено на автоответ!</b>', { parse_mode: 'HTML' });
  }
});

bot.on('message:sticker', async (ctx) => {
  if (ctx.businessMessage) return; // Игнорируем стикеры из бизнес-чатов

  const stickerId = ctx.message.sticker.file_id;
  await ctx.reply(
    `🆔 <b>ID этого стикера:</b>\n<code>${stickerId}</code>\n\n` +
    `👉 Установить на автоответ: <code>/set sticker:${stickerId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// --- АВТОМАТИЗАЦИЯ БИЗНЕС-ЧАТОВ ---
bot.on('business_message', async (ctx) => {
  try {
    const businessMessage = ctx.businessMessage;
    if (!businessMessage) return;

    const connectionId = businessMessage.business_connection_id; 
    const chatId = String(businessMessage.chat.id);
    const messageId = businessMessage.message_id;
    const senderId = String(businessMessage.from.id);

    // 1. ИГНОРИРУЕМ БОТОВ
    if (businessMessage.from.is_bot) return;

    // 2. ЗАЩИТА ОТ ДУБЛЕЙ ВЕБХУКА
    const uniqueKey = `${chatId}:${messageId}`;
    if (processedMessages.has(uniqueKey)) return;
    processedMessages.add(uniqueKey);
    setTimeout(() => processedMessages.delete(uniqueKey), 60 * 1000);

    // 3. ПОЛУЧАЕМ ВЛАДЕЛЬЦА ПОДКЛЮЧЕНИЯ
    const conn = await ctx.getBusinessConnection();
    const ownerId = conn && conn.user ? String(conn.user.id) : null;

    if (!ownerId) return;

    // 4. ЕСЛИ ПИШЕТ ВЛАДЕЛЬЕЦ АККАУНТА — МГНОВЕННО СТАВИМ ПАУЗУ И МОЛЧИМ!
    if (senderId === ownerId) {
      localPauses.set(chatId, Date.now() + PAUSE_DURATION);
      db.setPause(chatId, PAUSE_DURATION).catch(() => {});
      console.log(`🛑 Владелец написал в чат ${chatId}. Автоответчик остановлен.`);
      return;
    }

    // 5. ПРОВЕРКА ПАУЗЫ (Сначала локально в памяти, потом в БД)
    const localPauseUntil = localPauses.get(chatId);
    if (localPauseUntil && localPauseUntil > Date.now()) {
      console.log(`⏸️ Чат ${chatId} на локальной паузе.`);
      return;
    }

    const isDbPaused = await db.isPaused(chatId).catch(() => false);
    if (isDbPaused) {
      console.log(`⏸️ Чат ${chatId} на паузе в БД.`);
      return;
    }

    // Ставим паузу 15 секунд прямо сейчас, чтобы предотвратить повторный спам
    localPauses.set(chatId, Date.now() + 15000);
    db.setPause(chatId, 15000).catch(() => {});

    // 6. ПОЛУЧАЕМ НАСТРОЙКИ ОТВЕТА
    let replyText = await db.getCustomReply(ownerId);

    let incomingContent = businessMessage.text || businessMessage.caption || '[Медиа]';
    db.saveMessage(chatId, 'user', incomingContent);

    const fromUser = businessMessage.from;
    const username = fromUser.username ? `@${fromUser.username}` : (fromUser.first_name || 'Клиент');

    // А) ГОЛОСОВОЕ
    if (replyText && replyText.startsWith('voice:')) {
      const voiceFileId = replyText.replace('voice:', '').trim();
      await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Голосовое]`);
      await sendAdminLog(`🔔 <b>Бизнес-отклик!</b>\nВладелец: <code>${ownerId}</code>\nКлиент: ${username}\n🤖 <b>Ответил ГС.</b>`);
      return;
    }

    // Б) СТИКЕР
    if (replyText && replyText.startsWith('sticker:')) {
      const stickerFileId = replyText.replace('sticker:', '').trim();
      await ctx.api.sendSticker(chatId, stickerFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Стикер]`);
      await sendAdminLog(`🔔 <b>Бизнес-отклик!</b>\nВладелец: <code>${ownerId}</code>\nКлиент: ${username}\n🤖 <b>Ответил стикером.</b>`);
      return;
    }

    // В) ДЕФОЛТНЫЙ ТЕКСТ
    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
    }

    // Г) ТЕКСТ
    db.saveMessage(chatId, 'assistant', replyText);
    await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId, parse_mode: 'HTML' });
    
    const safeReply = replyText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await sendAdminLog(`🔔 <b>Бизнес-отклик!</b>\nВладелец: <code>${ownerId}</code>\nКлиент: ${username}\n🤖 <b>Ответил:</b> ${safeReply}`);

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
