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

// --- НАДЁЖНАЯ ЗАЩИТА ОТ ЗАСЫПАНИЯ (ЖЕСТКАЯ ССЫЛКА) ---
const RENDER_URL = 'https://kaguya2-0-bot.onrender.com';

setInterval(() => {
  http.get(RENDER_URL, (res) => {
    console.log(`📡 Авто-пинг (жесткий URL): Статус ${res.statusCode}`);
  }).on('error', (err) => {
    console.error('❌ Ошибка авто-пинга:', err.message);
  });
}, 5 * 60 * 1000); // Пинг каждые 5 минут

// Веб-сервер для Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kaguya Bot is Live!\n');
}).listen(PORT, () => {
  console.log(`🌐 Веб-сервер запущен на порту ${PORT}`);
});


// --- ОБРАБОТКА КОМАНД В ЛС БОТА ---

bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 **Привет! Я бот Кагуя 2.0.**\n\n' +
    '⚙️ Здесь ты можешь настроить, что я буду отвечать людям, когда они пишут тебе в бизнес-чате!\n\n' +
    '✍️ **Чтобы установить свой личный автоответ, напиши:**\n' +
    '`/set Твой текст ответа`'
  );
});

bot.command('set', async (ctx) => {
  try {
    const userId = String(ctx.from.id); 
    const customText = ctx.match.trim();

    if (!customText) {
      return await ctx.reply('❌ Ошибка. Напиши текст после команды, например:\n`/set Я сейчас занят, напишу позже!`');
    }

    db.setCustomReply(userId, customText);
    await ctx.reply(`✅ **Успешно!** Твой личный автоответ сохранен:\n"${customText}"`);
    
    if (ctx.from.id !== ADMIN_ID) {
      await bot.api.sendMessage(ADMIN_ID, `⚙️ **Пользователь обновил автоответ:**\n👤 ID: \`${userId}\`\n💬 Текст: "${customText}"`).catch(() => {});
    }
  } catch (err) {
    await ctx.reply(`❌ Ошибка внутри команды: ${err.message}`);
  }
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

    // Проверяем паузу
    if (chatPauses.has(chatId)) {
      if (Date.now() < chatPauses.get(chatId)) return;
      else chatPauses.delete(chatId);
    }

    db.saveMessage(chatId, 'user', text);

    let replyText = db.getCustomReply(ownerId); 
    
    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
      if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
        replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
      }
    }

    db.saveMessage(chatId, 'assistant', replyText);

    await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId });
    
    const fromUser = businessMessage.from;
    const username = fromUser.username ? `@${fromUser.username}` : 'Нет юзернейма';
    await bot.api.sendMessage(ADMIN_ID, `🔔 **Новое сообщение в бизнесе!**\nБизнес-владелец (ID): \`${ownerId}\`\nКлиент: ${username}\nТекст: "${text}"\n🤖 Ответил: "${replyText}"`).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
