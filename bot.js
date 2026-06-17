import { Bot } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан в переменной окружения!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

const chatPauses = new Map();
const PAUSE_DURATION = 5 * 60 * 1000; // 5 минут
const ADMIN_ID = 6511859639; 

// --- ОБРАБОТКА КОМАНД В ЛС БОТА ---
bot.command('start', async (ctx) => {
  await ctx.reply('👋 Привет! Я бот Кагуя 2.0.\n\n⚙️ **Как установить кастомный ответ:**\n`/set [ID чата] [Текст ответа]`');
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

// --- АВТОМАТИЗАЦИЯ ЧАТОВ (TELEGRAM BUSINESS API) ---
bot.on('business_message', async (ctx) => {
  try {
    const businessMessage = ctx.businessMessage;
    const connectionId = businessMessage.business_connection_id; 
    const chatId = businessMessage.chat.id;
    const text = businessMessage.text;
    
    if (!text) return;

    const fromUser = businessMessage.from;

    // ЖЕЛЕЗНАЯ ПРОВЕРКА НА ИСХОДЯЩЕЕ СООБЩЕНИЕ (Пишет сам владелец бизнеса):
    // 1. Если отправителя нет (такое бывает у исходящих в некоторых версиях API)
    // 2. Или ID отправителя равен твоему ADMIN_ID
    // 3. Или ID отправителя НЕ равен ID чата (в личных чатах ID чата — это ID клиента. Если пишет не он, значит пишешь ты!)
    const isOutgoing = !fromUser || fromUser.id === ADMIN_ID || (chatId > 0 && fromUser.id !== chatId);

    if (isOutgoing) {
      chatPauses.set(chatId, Date.now() + PAUSE_DURATION);
      console.log(`⏳ [ПАУЗА] Владелец бизнеса сам ответил в чате ${chatId}. Автоответчик остановлен на 5 минут.`);
      
      const ownerReport = `⏳ **Автоответчик на паузе!**\n\nТы ответил в чате \`${chatId}\`. Бот отключен здесь на 5 минут, чтобы ты мог спокойно переписываться.`;
      await bot.api.sendMessage(ADMIN_ID, ownerReport).catch(() => {});
      return;
    }

    // Проверяем, стоит ли этот чат на паузе прямо сейчас
    if (chatPauses.has(chatId)) {
      const pauseUntil = chatPauses.get(chatId);
      if (Date.now() < pauseUntil) {
        console.log(`ℹ️ Чат ${chatId} на паузе. Бот не вмешивается.`);
        return;
      } else {
        chatPauses.delete(chatId);
      }
    }

    const username = fromUser.username ? `@${fromUser.username}` : 'Нет юзернейма';
    const fullName = `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim();

    console.log(`📥 Входящее от клиента в чате ${chatId}: ${text}`);
    db.saveMessage(chatId, 'user', text);

    let replyText = db.getCustomReply(chatId); 
    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
      if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
        replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
      }
    }

    db.saveMessage(chatId, 'assistant', replyText);

    // Отправляем автоответ в бизнес-чат
    await ctx.api.sendMessage(chatId, replyText, {
      business_connection_id: connectionId
    });
    
    console.log(`📤 Успешно отправлен автоответ в чат ${chatId}`);

    const clientReport = `🔔 **Новое сообщение в бизнесе!**\n\n👤 **Клиент:** ${fullName} (${username})\n🆔 **ID чата:** \`${chatId}\`\n💬 **Написал:** "${text}"\n\n🤖 **Автоответ Кагуи:** "${replyText}"`;
    await bot.api.sendMessage(ADMIN_ID, clientReport).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка при обработке бизнес-сообщения:', error);
  }
});
