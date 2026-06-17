import { Bot } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан в переменной окружения!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

const chatPauses = new Map();
const PAUSE_DURATION = 5 * 60 * 1000; 
const ADMIN_ID = 6511859639; 

// --- ЗАЩИТА ОТ ЗАСЫПАНИЯ ---
const RENDER_URL = 'https://kaguya2-0-bot.onrender.com';
setInterval(() => {
  http.get(RENDER_URL, (res) => {
    console.log(`📡 Авто-пинг: Статус ${res.statusCode}`);
  }).on('error', (err) => {
    console.error('❌ Ошибка авто-пинга:', err.message);
  });
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kaguya Bot is Live!\n');
}).listen(PORT, () => {
  console.log(`🌐 Веб-сервер запущен на порту ${PORT}`);
});


// --- ОБРАБОТКА КОМАНД И ХЕНДЛЕРОВ В ЛС ---

bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 **Привет! Я бот Кагуя 2.0.**\n\n' +
    '⚙️ Здесь можно настроить свой автоответ для бизнес-аккаунта!\n\n' +
    '✍️ **Как установить ТЕКСТ:**\n`/set Твой текст ответа`\n\n' +
    '🖼️ **Как установить СТИКЕР:**\n' +
    '1. Просто отправь/перешли мне любой стикер в этот чат.\n' +
    '2. Я выдам тебе его ID.\n' +
    '3. Напиши: `/set sticker:ПОЛУЧЕННЫЙ_ID`'
  );
});

bot.command('set', async (ctx) => {
  try {
    const userId = String(ctx.from.id); 
    const customText = ctx.match.trim();

    if (!customText) {
      return await ctx.reply('❌ Ошибка. Напиши текст или ID стикера после команды.');
    }

    db.setCustomReply(userId, customText);
    
    if (customText.startsWith('sticker:')) {
      await ctx.reply('✅ **Успешно!** Теперь на входящие сообщения я буду отвечать этим стикером!');
    } else {
      await ctx.reply(`✅ **Успешно!** Твой личный автоответ сохранен:\n"${customText}"`);
    }
    
    if (ctx.from.id !== ADMIN_ID) {
      await bot.api.sendMessage(ADMIN_ID, `⚙️ **Пользователь обновил автоответ:**\n👤 ID: \`${userId}\`\n💬 Настройка: "${customText}"`).catch(() => {});
    }
  } catch (err) {
    await ctx.reply(`❌ Ошибка внутри команды: ${err.message}`);
  }
});

// УЗНАЁМ ID СТИКЕРА: Если пользователь шлёт стикер в ЛС бота
bot.on('message:sticker', async (ctx) => {
  const stickerId = ctx.message.sticker.file_id;
  await ctx.reply(
    `🆔 **ID этого стикера:**\n\`${stickerId}\`\n\n` +
    `👉 Чтобы поставить его на автоответ, скопируй его и напиши командой:\n` +
    \`/set sticker:${stickerId}\`, { parse_mode: 'Markdown' }
  );
});

bot.on('message:text', async (ctx) => {
  if (!ctx.message.text.startsWith('/')) {
    await ctx.reply(`✨ Кагуя на связи. Твой личный ID: \`${ctx.from.id}\``);
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

    // Стоп-таймер (тихая пауза)
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

    let replyText = db.getCustomReply(ownerId); 
    
    // ПРОВЕРКА: Что отправлять — стикер или текст?
    if (replyText && replyText.startsWith('sticker:')) {
      const stickerFileId = replyText.replace('sticker:', '').trim();
      
      // Отправляем стикер в бизнес-чат
      await ctx.api.sendSticker(chatId, stickerFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Стикер: ${stickerFileId}]`);
      
      await bot.api.sendMessage(ADMIN_ID, `🔔 **Новое в бизнесе!**\nБизнес-владелец: \`${ownerId}\`\n💬 Текст: "${text}"\n🤖 Ответил стикером.`).catch(() => {});
    } else {
      // Иначе обычный текст
      if (!replyText) {
        replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
        if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
          replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
        }
      }

      db.saveMessage(chatId, 'assistant', replyText);
      await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId });
      
      await bot.api.sendMessage(ADMIN_ID, `🔔 **Новое в бизнесе!**\nБизнес-владелец: \`${ownerId}\`\n💬 Текст: "${text}"\n🤖 Ответил: "${replyText}"`).catch(() => {});
    }

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
