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
    const username = fromUser.username ? `@${fromUser.username}` : 'Нет юзернейма';
    const fullName = `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim();

    // ЖЕЛЕЗНАЯ ПРОВЕРКА: Если сообщение исходит от твоего бизнес-аккаунта (ты пишешь клиенту)
    // В Business API исходящие от тебя сообщения помечаются либо твоим ADMIN_ID, либо специальным флагом.
    // Для надежности проверяем оба варианта:
    if (fromUser.id === ADMIN_ID || businessMessage.is_from_offline === false) {
      chatPauses.set(chatId, Date.now() + PAUSE_DURATION);
      console.log(`⏳ Владелец ответил сам в чате ${chatId}. Пауза 5 минут.`);
      
      const ownerReport = `⏳ **Автоответчик на паузе!**\n\nТы зашел в переписку в чате \`${chatId}\`. Кагуя отключена здесь на 5 минут.`;
      await bot.api.sendMessage(ADMIN_ID, ownerReport).catch(() => {});
      return;
    }

    // Проверяем, стоит ли этот чат на паузе
    if (chatPauses.has(chatId)) {
      const pauseUntil = chatPauses.get(chatId);
      if (Date.now() < pauseUntil) {
        console.log(`ℹ️ Чат ${chatId} еще на паузе. Бот молчит.`);
        return;
      } else {
        chatPauses.delete(chatId);
      }
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

    await ctx.api.sendMessage(chatId, replyText, {
      business_connection_id: connectionId
    });
    
    const clientReport = `🔔 **Новое сообщение!**\nЧат: \`${chatId}\`\nКлиент: ${fullName}\nТекст: "${text}"\n🤖 Ответил: "${replyText}"`;
    await bot.api.sendMessage(ADMIN_ID, clientReport).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
