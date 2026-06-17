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

// --- ОБРАБОТКА КОМАНД В ЛС БОТА ---
bot.command('start', async (ctx) => {
  await ctx.reply('👋 Привет! Я бот Кагуя 2.0.\n\n⚙️ **Как установить кастомный ответ для чата:**\nНапиши мне команду в формате:\n`/set `[ID чата] [Текст ответа]\n\n*Пример:*\n`/set -1001234567 Привет! Хозяин на тренировке, ответит позже!`', { parse_mode: 'Markdown' });
});

// Команда для настройки кастомного ответа
bot.command('set', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return; // Только для тебя
  
  const args = ctx.match.trim().split(' ');
  if (args.length < 2) {
    return await ctx.reply('❌ Ошибка. Правильный формат:\n`/set [ID чата] [Текст ответа]`', { parse_mode: 'Markdown' });
  }

  const targetChatId = args[0];
  const customText = args.slice(1).join(' ');

  // Сохраняем в базу
  db.setCustomReply(targetChatId, customText);
  await ctx.reply(`✅ Успешно! Для чата \`${targetChatId}\` установлен текст:\n"${customText}"`, { parse_mode: 'Markdown' });
});

bot.on('message:text', async (ctx) => {
  await ctx.reply(`✨ Кагуя на связи. Твой ID чата: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
});

// --- АВТОМАТИЗАЦИЯ ЧАТОВ (TELEGRAM BUSINESS API) ---
bot.on('business_message', async (ctx) => {
  try {
    const businessMessage = ctx.businessMessage;
    const connectionId = businessMessage.business_connection_id; 
    const chatId = businessMessage.chat.id;
    const text = businessMessage.text;
    
    if (!text) return;

    const fromUser = businessMessage.from;
    const username = fromUser.username ? `@${fromUser.username}` : 'Нет юзернейма';
    const fullName = `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim();

    if (fromUser.id === ADMIN_ID) {
      chatPauses.set(`${ADMIN_ID}_${chatId}`, Date.now() + PAUSE_DURATION);
      
      const ownerReport = `⏳ **Автоответчик на паузе!**\n\n` +
                          `👤 Ты ответил в чате с: **${fullName}** (${username})\n` +
                          `🆔 ID чата: \`${chatId}\`\n` +
                          `🚫 Бот отключен в этом чате на 5 минут.`;
      
      await bot.api.sendMessage(ADMIN_ID, ownerReport, { parse_mode: 'Markdown' }).catch(() => {});
      return;
    }

    const pauseKey = `${ADMIN_ID}_${chatId}`;
    if (chatPauses.has(pauseKey)) {
      const pauseUntil = chatPauses.get(pauseKey);
      if (Date.now() < pauseUntil) return;
      else chatPauses.delete(pauseKey);
    }

    db.saveMessage(chatId, 'user', text);

    // --- ВЫБОР ОТВЕТА (КАСТОМНЫЙ ИЛИ СТАНДАРТНЫЙ) ---
    let replyText = db.getCustomReply(chatId); 

    if (!replyText) {
      // Если кастомного текста нет, берем стандартную логику
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
      
      if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
        replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
      }
    }

    db.saveMessage(chatId, 'assistant', replyText);

    await ctx.api.sendMessage(chatId, replyText, {
      business_connection_id: connectionId
    });
    
    const clientReport = `🔔 **Новое сообщение в бизнесе!**\n\n` +
                         `👤 **Клиент:** ${fullName} (${username})\n` +
                         `🆔 **ID чата:** \`${chatId}\`\n` +
                         `💬 **Написал:** "${text}"\n\n` +
                         `🤖 **Автоответ Кагуи:** "${replyText}"`;

    await bot.api.sendMessage(ADMIN_ID, clientReport, { parse_mode: 'Markdown' }).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
