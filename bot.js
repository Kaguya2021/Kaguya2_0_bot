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

bot.command('start', async (ctx) => {
  await ctx.reply('👋 Привет! Я бот Кагуя 2.0. Вы можете подключить меня в настройках "Telegram для бизнеса", чтобы я работал вашим автоответчиком!');
});

bot.command('help', async (ctx) => {
  await ctx.reply('🤖 Бот автоматически подстраивается под ваш аккаунт после подключения в разделе бизнес-автоматизации.');
});

bot.on('message:text', async (ctx) => {
  console.log(`[ТЕСТ ЛС] Получено сообщение: ${ctx.message.text}`);
  await ctx.reply(`✨ Кагуя на связи! В ЛС всё работает. Твой ID: ${ctx.from.id}`);
});

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
      console.log(`⏳ Ты ответил сам в чате ${chatId}. Пауза автоответчика на 5 мин.`);
      
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
      if (Date.now() < pauseUntil) {
        console.log(`ℹ️ Чат ${chatId} на паузе. Владелец сейчас сам ведет переписку.`);
        return;
      } else {
        chatPauses.delete(pauseKey);
      }
    }

    console.log(`📥 Входящее от клиента в чате ${chatId}: ${text}`);

    db.saveMessage(chatId, 'user', text);
    const history = db.getChatHistory(chatId);

    let replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';

    if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
      replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
    } else if (history.length > 2) {
      replyText = 'Я вижу, что мы активно общаемся, но мне лучше дождаться владельца аккаунта, чтобы он ответил вам точнее. Спасибо за терпение! ✨';
    }

    db.saveMessage(chatId, 'assistant', replyText);

    await ctx.api.sendMessage(chatId, replyText, {
      business_connection_id: connectionId
    });
    
    console.log(`📤 Успешно отправлен автоответ в чат ${chatId}`);

    const clientReport = `🔔 **Новое сообщение в бизнесе!**\n\n` +
                         `👤 **Клиент:** ${fullName} (${username})\n` +
                         `🆔 **ID чата:** \`${chatId}\`\n` +
                         `💬 **Написал:** "${text}"\n\n` +
                         `🤖 **Автоответ Кагуи:** "${replyText}"`;

    await bot.api.sendMessage(ADMIN_ID, clientReport, { parse_mode: 'Markdown' }).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка при обработке бизнес-сообщения:', error);
  }
});
