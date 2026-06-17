import { Bot } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан в переменной окружения!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

const chatPauses = new Map();
const PAUSE_DURATION = 5 * 60 * 1000; 
const ADMIN_ID = 6511859639; 

// Команды в ЛС бота
bot.command('start', async (ctx) => {
  await ctx.reply('👋 Привет! Я бот Кагуя 2.0.\n\n⚙️ **Установить кастомный ответ:**\n`/set [ID чата] [Текст ответа]`');
});

bot.command('set', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.match.trim().split(' ');
  if (args.length < 2) return await ctx.reply('❌ Ошибка. Формат: `/set [ID чата] [Текст]`');
  const targetChatId = args[0];
  const customText = args.slice(1).join(' ');
  db.setCustomReply(targetChatId, customText);
  await ctx.reply(`✅ Успешно для чата \`${targetChatId}\``);
});

bot.on('message:text', async (ctx) => {
  await ctx.reply(`✨ Кагуя на связи. ID этого чата: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
});

// АВТОМАТИЗАЦИЯ БИЗНЕС-ЧАТОВ
bot.on('business_message', async (ctx) => {
  try {
    const businessMessage = ctx.businessMessage;
    const connectionId = businessMessage.business_connection_id; 
    const chatId = businessMessage.chat.id;
    const text = businessMessage.text;
    
    if (!text) return;

    // Официальный способ grammY узнать, кто владелец этого бизнес-аккаунта
    const conn = await ctx.getBusinessConnection();
    const ownerId = conn.user.id;

    // Если ID отправителя совпадает с ID владельца аккаунта (ты пишешь твинку)
    if (ctx.from.id === ownerId) {
      chatPauses.set(chatId, Date.now() + PAUSE_DURATION);
      console.log(`⏳ Владелец ответил сам. Пауза автоответчика в чате ${chatId} на 5 минут.`);
      
      await bot.api.sendMessage(ADMIN_ID, `⏳ **Пауза 5 минут** активирована в чате \`${chatId}\`.`).catch(() => {});
      return;
    }

    // Проверяем паузу
    if (chatPauses.has(chatId)) {
      if (Date.now() < chatPauses.get(chatId)) return;
      else chatPauses.delete(chatId);
    }

    db.saveMessage(chatId, 'user', text);

    let replyText = db.getCustomReply(chatId); 
    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
      if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
        replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
      }
    }

    db.saveMessage(chatId, 'assistant', replyText);

    // Ответ в бизнес-чат
    await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId });
    
    const fromUser = businessMessage.from;
    const username = fromUser.username ? `@${fromUser.username}` : 'Нет юзернейма';
    await bot.api.sendMessage(ADMIN_ID, `🔔 **Новое сообщение!**\nЧат: \`${chatId}\`\nКлиент: ${username}\nТекст: "${text}"`).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
