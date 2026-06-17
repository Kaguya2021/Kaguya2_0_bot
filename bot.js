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
  await ctx.reply(
    '👋 **Привет! Я бот Кагуя 2.0.**\n\n' +
    '⚙️ Здесь ты можешь настроить, что я буду отвечать людям, когда они пишут тебе в бизнес-чате!\n\n' +
    '✍️ **Чтобы установить свой личный автоответ, напиши:**\n' +
    '`/set Твой текст ответа`'
  );
});

// Команда /set: теперь каждый пользователь (включая твой твинк) настраивает текст для себя
bot.command('set', async (ctx) => {
  try {
    const userId = ctx.from.id; 
    const customText = ctx.match.trim();

    if (!customText) {
      return await ctx.reply('❌ Ошибка. Напиши текст после команды, например:\n`/set Я сейчас занят, напишу позже!`');
    }

    db.setCustomReply(userId, customText);
    await ctx.reply(`✅ **Успешно!** Твой личный автоответ сохранен:\n"${customText}"`);
    
    // Уведомление главному админу (тебе) только о факте настройки, если это сделал другой юзер
    if (userId !== ADMIN_ID) {
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
    const ownerId = conn.user.id;

    // Стоп-таймер (если пишет сам владелец аккаунта)
    if (ctx.from.id === ownerId) {
      chatPauses.set(chatId, Date.now() + PAUSE_DURATION);
      console.log(`⏳ Владелец ответил сам. Тихая пауза в чате ${chatId} на 5 минут.`);
      // МЫ СТЁРЛИ ОТПРАВКУ СООБЩЕНИЯ О ПАУЗЕ АДМИНУ — ТЕПЕРЬ ТУТ ТИШИНА 🤐
      return;
    }

    // Проверяем, активна ли пауза в чате
    if (chatPauses.has(chatId)) {
      if (Date.now() < chatPauses.get(chatId)) return;
      else chatPauses.delete(chatId);
    }

    db.saveMessage(chatId, 'user', text);

    // Берем кастомный текст ответа, который этот пользователь настроил для своего аккаунта
    let replyText = db.getCustomReply(chatId); 
    
    if (!replyText) {
      // Стандартный шаблон
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
      if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
        replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
      }
    }

    db.saveMessage(chatId, 'assistant', replyText);

    // Отправляем автоответ в бизнес-чат
    await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId });
    
    // Отчет о входящем сообщении летит главному админу
    const fromUser = businessMessage.from;
    const username = fromUser.username ? `@${fromUser.username}` : 'Нет юзернейма';
    await bot.api.sendMessage(ADMIN_ID, `🔔 **Новое сообщение в бизнесе!**\nЧат: \`${chatId}\`\nКлиент: ${username}\nТекст: "${text}"\n🤖 Ответил: "${replyText}"`).catch(() => {});

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});
