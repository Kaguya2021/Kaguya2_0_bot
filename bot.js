import { Bot } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан в переменной ocean!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

const chatPauses = new Map();
const PAUSE_DURATION = 5 * 60 * 1000; 
const ADMIN_ID = 6511859639; 

// 1. Хранилище для тех, кто сейчас добавляет голосовое сообщение (ГС)
const waitingForVoice = new Map();

// --- ОБРАБОТКА КОМАНД И ХЕНДЛЕРОВ В ЛС ---

bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 <b>Привет! Я бот Кагуя 2.0.</b>\n\n' +
    '⚙️ Здесь можно настроить свой автоответ для business-аккаунта!\n\n' +
    '✍️ <b>Как установить ТЕКСТ:</b>\n<code>/set Твой текст</code>\n<i>(Поддерживаются HTML-теги для красоты: &lt;b&gt;жирный&lt;/b&gt;, &lt;i&gt;курсив&lt;/i&gt;, &lt;blockquote&gt;цитата&lt;/blockquote&gt;)</i>\n\n' +
    '🖼️ <b>Как установить СТИКЕР:</b>\n' +
    '1. Просто отправь/перешли мне любой стикер в этот чат.\n' +
    '2. Я выдам тебе его ID.\n' +
    '3. Напиши: <code>/set sticker:ПОЛУЧЕННЫЙ_ID</code>\n\n' +
    '🎤 <b>Как установить ГОЛОСОВОЕ СООБЩЕНИЕ (ГС):</b>\n' +
    'Напиши <code>/set gs</code> и следуй инструкции.',
    { parse_mode: 'HTML' }
  );
});

bot.command('set', async (ctx) => {
  try {
    const userId = String(ctx.from.id); 
    const customText = ctx.match.trim();

    // 2. Ловим команду /set gs для установки голосового сообщения
    if (customText.toLowerCase() === 'gs') {
      waitingForVoice.set(userId, true);
      return await ctx.reply('🎤 <b>Отправьте или перешлите мне голосовое сообщение</b> для автоответчика:', { parse_mode: 'HTML' });
    }

    if (!customText) {
      return await ctx.reply('❌ Ошибка. Напиши текст, команду <code>gs</code> или ID стикера после <code>/set</code>.', { parse_mode: 'HTML' });
    }

    await db.setCustomReply(userId, customText);
    
    if (customText.startsWith('sticker:')) {
      await ctx.reply('✅ <b>Успешно!</b> Теперь на входящие сообщения я буду отвечать этим стикером!', { parse_mode: 'HTML' });
    } else {
      // Поддержка HTML включена при ответе пользователю
      await ctx.reply(`✅ <b>Успешно!</b> Твой личный автоответ сохранен:\n\n${customText}`, { parse_mode: 'HTML' });
    }
    
    if (ctx.from.id !== ADMIN_ID) {
      // Экранируем текст для админа, чтобы не было ошибок парсинга HTML
      const safeText = customText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await bot.api.sendMessage(ADMIN_ID, `⚙️ <b>Пользователь обновил автоответ:</b>\n👤 ID: <code>${userId}</code>\n💬 Настройка:\n${safeText}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (err) {
    await ctx.reply(`❌ Ошибка внутри команды: ${err.message}`);
  }
});

// 3. Ловим само голосовое сообщение
bot.on('message:voice', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (waitingForVoice.has(userId)) {
    const fileId = ctx.message.voice.file_id;
    // Сохраняем ГС в базу так же, как стикеры, но с приставкой voice:
    const customText = `voice:${fileId}`; 
    
    await db.setCustomReply(userId, customText);
    waitingForVoice.delete(userId); // Выключаем режим ожидания
    
    return await ctx.reply('✅ <b>Голосовое сообщение успешно сохранено!</b> Теперь бот будет отвечать им клиентам.', { parse_mode: 'HTML' });
  }
});

bot.on('message:sticker', async (ctx) => {
  const stickerId = ctx.message.sticker.file_id;
  await ctx.reply(
    `🆔 <b>ID этого стикера:</b>\n<code>${stickerId}</code>\n\n` +
    `👉 Чтобы поставить его на автоответ, скопируй его и напиши командой:\n` +
    `<code>/set sticker:${stickerId}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.on('message:text', async (ctx) => {
  if (!ctx.message.text.startsWith('/')) {
    await ctx.reply(`✨ Кагуя на связи. Твой личный ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' });
  }
});

// --- АВТОМАТИЗАЦИЯ БИЗНЕС-ЧАТОВ ---
bot.on('business_message', async (ctx) => {
  try {
    const businessMessage = ctx.businessMessage;
    const connectionId = businessMessage.business_connection_id; 
    const chatId = businessMessage.chat.id;
    const text = businessMessage.text;
    
    if (!text) return;

    const conn = await ctx.getBusinessConnection();
    const ownerId = String(conn.user.id); 

    if (String(ctx.from.id) === ownerId) {
      chatPauses.set(chatId, Date.now() + PAUSE_DURATION);
      console.log(`⏳ Владелец ответил сам. Тихая пауза в чате ${chatId} на 5 минут.`);
      return;
    }

    if (chatPauses.has(chatId)) {
      if (Date.now() < chatPauses.get(chatId)) return;
      else chatPauses.delete(chatId);
    }

    db.saveMessage(chatId, 'user', text);

    let replyText = await db.getCustomReply(ownerId);
    
    const fromUser = businessMessage.from;
    const username = fromUser.username ? `@${fromUser.username}` : 'Нет юзернейма';

    if (replyText && replyText.startsWith('sticker:')) {
      const stickerFileId = replyText.replace('sticker:', '').trim();
      
      await ctx.api.sendSticker(chatId, stickerFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Стикер: ${stickerFileId}]`);
      
      await bot.api.sendMessage(ADMIN_ID, `🔔 <b>Новое сообщение в бизнесе!</b>\nБизнес-владелец (ID): <code>${ownerId}</code>\nКлиент: ${username}\nТекст: "${text}"\n🤖 Ответил стикером.`, { parse_mode: 'HTML' }).catch(() => {});
      
    } else if (replyText && replyText.startsWith('voice:')) {
      // 4. Логика отправки голосового сообщения клиенту
      const voiceFileId = replyText.replace('voice:', '').trim();
      
      await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Голосовое сообщение]`);
      
      await bot.api.sendMessage(ADMIN_ID, `🔔 <b>Новое сообщение в бизнесе!</b>\nБизнес-владелец (ID): <code>${ownerId}</code>\nКлиент: ${username}\nТекст: "${text}"\n🤖 Ответил голосовым сообщением.`, { parse_mode: 'HTML' }).catch(() => {});
      
    } else {
      if (!replyText) {
        replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
        if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
          replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
        }
      }

      db.saveMessage(chatId, 'assistant', replyText);
      
      // 5. Отправка текста с включенным parse_mode HTML
      await ctx.api.sendMessage(chatId, replyText, { 
        business_connection_id: connectionId,
        parse_mode: 'HTML' // Включаем поддержку шрифтов и цитат!
      });
      
      const safeReply = replyText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await bot.api.sendMessage(ADMIN_ID, `🔔 <b>Новое сообщение в бизнесе!</b>\nБизнес-владелец (ID): <code>${ownerId}</code>\nКлиент: ${username}\nТекст: "${text}"\n🤖 Ответил:\n${safeReply}`, { parse_mode: 'HTML' }).catch(() => {});
    }

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
