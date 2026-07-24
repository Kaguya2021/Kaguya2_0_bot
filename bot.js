import { Bot } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан в переменной environment!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

const chatPauses = new Map();
const PAUSE_DURATION = 5 * 60 * 1000; 

// --- СПИСОК АДМИНОВ ---
// 1. Твой ID | 2. ID твоего сотрудника
const ADMIN_IDS = [6511859639, 8028803176]; 

// Функция для рассылки логов всем админам
async function sendAdminLog(text) {
  for (const adminId of ADMIN_IDS) {
    await bot.api.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
}

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
      await ctx.reply(`✅ <b>Успешно!</b> Твой личный автоответ сохранен:\n\n${customText}`, { parse_mode: 'HTML' });
    }
    
    // Отправляем лог об изменении автоответа всем админам (если менял не админ)
    if (!ADMIN_IDS.includes(ctx.from.id)) {
      const safeText = customText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await sendAdminLog(`⚙️ <b>Пользователь обновил автоответ:</b>\n👤 ID: <code>${userId}</code>\n💬 Настройка:\n${safeText}`);
    }
  } catch (err) {
    await ctx.reply(`❌ Ошибка внутри команды: ${err.message}`);
  }
});

bot.on('message:voice', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (waitingForVoice.has(userId)) {
    const fileId = ctx.message.voice.file_id;
    const customText = `voice:${fileId}`; 
    
    await db.setCustomReply(userId, customText);
    waitingForVoice.delete(userId);
    
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
    const text = businessMessage.text || businessMessage.caption || '[Медиасообщение]';

    const conn = await ctx.getBusinessConnection();
    const ownerId = conn && conn.user ? String(conn.user.id) : null;

    if (!ownerId) {
      console.error('⚠️ Не удалось определить ownerId для бизнес-сообщения!');
      return;
    }

    // Если сам владелец пишет в чат — пауза на 5 минут
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

    // Достаем сохраненный ответ для владельца
    let replyText = await db.getCustomReply(ownerId);
    
    console.log(`🔍 [БИЗНЕС] ID владельца: ${ownerId} | Настройки из БД: "${replyText}"`);

    const fromUser = businessMessage.from;
    const username = fromUser.username ? `@${fromUser.username}` : 'Нет юзернейма';

    // 1. ЕСЛИ УСТАНОВЛЕНО ГОЛОСОВОЕ СООБЩЕНИЕ (ГС)
    if (replyText && replyText.startsWith('voice:')) {
      const voiceFileId = replyText.replace('voice:', '').trim();
      
      // Отправляем ГС по file_id
      await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Голосовое сообщение]`);
      
      await sendAdminLog(`🔔 <b>Новое сообщение в бизнесе!</b>\nБизнес-владелец (ID): <code>${ownerId}</code>\nКлиент: ${username}\nТекст клиента: "${text}"\n🤖 <b>Ответил голосовым сообщением!</b>`);
      return;
    }

    // 2. ЕСЛИ УСТАНОВЛЕН СТИКЕР
    if (replyText && replyText.startsWith('sticker:')) {
      const stickerFileId = replyText.replace('sticker:', '').trim();
      
      await ctx.api.sendSticker(chatId, stickerFileId, { business_connection_id: connectionId });
      db.saveMessage(chatId, 'assistant', `[Стикер: ${stickerFileId}]`);
      
      await sendAdminLog(`🔔 <b>Новое сообщение в бизнесе!</b>\nБизнес-владелец (ID): <code>${ownerId}</code>\nКлиент: ${username}\nТекст клиента: "${text}"\n🤖 <b>Ответил стикером.</b>`);
      return;
    }

    // 3. ЕСЛИ УСТАНОВЛЕН ТЕКСТ (ИЛИ ДЕФОЛТ)
    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
      if (text.toLowerCase().includes('привет') || text.toLowerCase().includes('здравствуй') || text.toLowerCase().includes('салам')) {
        replyText = 'Привет! Я виртуальный ассистент. Мой владелец сейчас немного занят, но я передам ему ваше сообщение! 🙌';
      }
    }

    db.saveMessage(chatId, 'assistant', replyText);
    
    await ctx.api.sendMessage(chatId, replyText, { 
      business_connection_id: connectionId,
      parse_mode: 'HTML' 
    });
    
    const safeReply = replyText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await sendAdminLog(`🔔 <b>Новое сообщение в бизнесе!</b>\nБизнес-владелец (ID): <code>${ownerId}</code>\nКлиент: ${username}\nТекст клиента: "${text}"\n🤖 <b>Ответил текстом:</b>\n${safeReply}`);

  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});

