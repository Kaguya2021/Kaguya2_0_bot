import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

const ADMIN_IDS = ['6511859639', '7470537453'];

const PAUSE_DURATION = 10 * 60 * 1000;    
const COOLDOWN_DURATION = 15 * 60 * 1000; // ⏱️ Кулдаун 15 минут (бот отвечает 1 раз и молчит 15 минут)

const processedMessages = new Set();
const localPauses = new Map();
const replyCache = new Map();
const stepState = new Map();
const userStatuses = new Map();       
const userCooldownModes = new Map();  

const connectionOwners = new Map();

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

async function getMainKeyboard(userId) {
  let isActive = userStatuses.get(userId);
  if (isActive === undefined) {
    if (db.getUserActiveStatus) {
      isActive = await db.getUserActiveStatus(userId).catch(() => true);
    } else {
      isActive = true;
    }
    userStatuses.set(userId, isActive);
  }

  let isCooldownMode = userCooldownModes.get(userId) || false;
  const modeButtonText = isCooldownMode ? '⏱️ Режим: Кулдаун 15 мин (Вкл)' : '⚡ Режим: Обычный (Без паузы)';
  const statusButtonText = isActive ? '🔕 Выключить автоответ' : '🔔 Включить автоответ';

  const kb = new Keyboard()
    .text(statusButtonText).row()
    .text(modeButtonText).row() 
    .text('✍️ Установить текст').text('🎤 Голосовой автоответ').row()
    .text('🖼️ Комбо (Текст + Стикер)').text('🔍 Мой автоответ').row()
    .text('ℹ️ Инфо').text('🗑️ Сбросить').row(); // 👈 Вернули кнопку Инфо в меню

  if (isAdmin(userId)) {
    kb.text('🔒 ADMINPPA').row();
  }

  return kb.resized();
}

bot.command('start', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (db.registerUser) {
    db.registerUser(userId, ctx.from.username || ctx.from.first_name).catch(() => {});
  }

  const welcomeText = 
    '👋 <b>Привет! Я бот Кагуя 2.0.</b>\n\n' +
    '⚙️ Персональный автоответчик для Telegram Business.\n' +
    'Используйте меню ниже для настройки режима и управления:\n\n' +
    '📢 <b>Наш канал:</b> <a href="https://t.me/kaguya_2_0_bots">Kaguya 2.0 Channel</a>';

  const inlineKb = new InlineKeyboard()
    .url('📢 Подписаться на канал', 'https://t.me/kaguya_2_0_bots');

  await ctx.reply(welcomeText, { 
    parse_mode: 'HTML', 
    reply_markup: inlineKb, 
    disable_web_page_preview: true 
  });

  await ctx.reply('🚀 <b>Главное меню:</b>', {
    reply_markup: await getMainKeyboard(userId)
  });
});

bot.command('info', async (ctx) => {
  const infoText = 
    'ℹ️ <b>Информация о боте Кагуя 2.0</b>\n\n' +
    '🤖 Этот бот помогает управлять автоответами для Telegram Business.\n' +
    '• <b>Режим кулдауна (15 мин):</b> Бот отвечает клиенту только 1 раз, после чего уходит в тишину на 15 минут, не мешая вашей живой переписке.\n' +
    '• <b>Кнопка вкл/выкл:</b> Позволяет полностью останавливать или запускать автоответчик в один клик.\n\n' +
    '📢 <b>Канал проекта:</b> @kaguya_2_0_bots';
  
  await ctx.reply(infoText, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.hears('ℹ️ Инфо', async (ctx) => {
  const infoText = 
    'ℹ️ <b>Информация о боте Кагуя 2.0</b>\n\n' +
    '🤖 Этот бот помогает управлять автоответами для Telegram Business.\n' +
    '• <b>Режим кулдауна (15 мин):</b> Бот отвечает клиенту только 1 раз, после чего уходит в тишину на 15 минут, не мешая вашей живой переписке.\n' +
    '• <b>Кнопка вкл/выкл:</b> Позволяет полностью останавливать или запускать автоответчик в один клик.\n\n' +
    '📢 <b>Канал проекта:</b> @kaguya_2_0_bots';
  
  await ctx.reply(infoText, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.hears('🔕 Выключить автоответ', async (ctx) => {
  const userId = String(ctx.from.id);
  userStatuses.set(userId, false);
  if (db.setUserActiveStatus) {
    await db.setUserActiveStatus(userId, false).catch(() => {});
  }

  await ctx.reply('🔕 <b>Автоответчик выключен.</b> Бот больше не отвечает на сообщения.', {
    parse_mode: 'HTML',
    reply_markup: await getMainKeyboard(userId)
  });
});

bot.hears('🔔 Включить автоответ', async (ctx) => {
  const userId = String(ctx.from.id);
  userStatuses.set(userId, true);
  if (db.setUserActiveStatus) {
    await db.setUserActiveStatus(userId, true).catch(() => {});
  }

  await ctx.reply('🔔 <b>Автоответчик включен!</b> Бот снова готов к работе.', {
    parse_mode: 'HTML',
    reply_markup: await getMainKeyboard(userId)
  });
});

bot.hears(['⏱️ Режим: Кулдаун 15 мин (Вкл)', '⚡ Режим: Обычный (Без паузы)'], async (ctx) => {
  const userId = String(ctx.from.id);
  
  let currentMode = userCooldownModes.get(userId) || false;
  let newMode = !currentMode;
  userCooldownModes.set(userId, newMode);

  const modeDesc = newMode 
    ? '⏱️ <b>Кулдаун 15 минут</b> (Бот отвечает клиенту 1 раз, затем молчит 15 минут, не мешая переписке)' 
    : '⚡ <b>Обычный режим</b> (Стандартное поведение)';

  await ctx.reply(`✅ <b>Режим успешно изменен лично для вас!</b>\n\nТекущий режим: ${modeDesc}`, {
    parse_mode: 'HTML',
    reply_markup: await getMainKeyboard(userId)
  });
});

bot.hears('✍️ Установить текст', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT_ONLY' });
  await ctx.reply('✍️ <b>Напишите текст автоответа:</b>', { parse_mode: 'HTML' });
});

bot.hears('🎤 Голосовой автоответ', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_VOICE' });
  await ctx.reply('🎤 <b>Отправьте голосовое сообщение для автоответа:</b>', { parse_mode: 'HTML' });
});

bot.hears('🖼️ Комбо (Текст + Стикер)', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT' });
  await ctx.reply('✍️ <b>Шаг 1/2:</b> Напишите текст со стикером:', { parse_mode: 'HTML' });
});

bot.hears('🔍 Мой автоответ', async (ctx) => {
  const userId = String(ctx.from.id);
  const currentReply = replyCache.get(userId) || await db.getCustomReply(userId).catch(() => null);

  if (!currentReply) {
    return await ctx.reply('ℹ️ У вас установлен <b>дефолтный текст</b>:\n<i>Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓</i>', { parse_mode: 'HTML' });
  }

  await ctx.reply(`✍️ <b>Ваш текущий автоответ:</b>\n\n${currentReply}`, { parse_mode: 'HTML' });
});

bot.hears('🗑️ Сбросить', async (ctx) => {
  const userId = String(ctx.from.id);
  replyCache.delete(userId);
  await db.setCustomReply(userId, null).catch(console.error);
  stepState.delete(userId);
  await ctx.reply('🗑️ <b>Сброшено!</b>', { parse_mode: 'HTML' });
});

bot.hears('⏰ Настроить время', async (ctx) => {
  await ctx.reply('⏰ Пример: <code>/time 05:00 20:00</code> или <code>/time off</code>', { parse_mode: 'HTML' });
});

async function showAdminPanel(ctx) {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply('👑 <b>Админ-панель доступна</b>', { parse_mode: 'HTML' });
}

bot.command('admins', showAdminPanel);
bot.command('adminppa', showAdminPanel);
bot.hears('🔒 ADMINPPA', async (ctx) => { if (isAdmin(ctx.from.id)) await showAdminPanel(ctx); });

bot.command('set', async (ctx) => {
  const userId = String(ctx.from.id);
  const customText = (ctx.message.text || '').replace(/^\/set\s*/i, '').trim();
  if (!customText) return await ctx.reply('❌ Напишите текст.');
  replyCache.set(userId, customText);
  db.setCustomReply(userId, customText).catch(console.error);
  await ctx.reply(`✅ <b>Сохранено!</b>`, { parse_mode: 'HTML' });
});

bot.on('message', async (ctx, next) => {
  if (ctx.businessMessage) return next();
  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

  if (state && state.step === 'WAITING_TEXT_ONLY' && ctx.message.text) {
    const text = ctx.message.text;
    replyCache.set(userId, text);
    db.setCustomReply(userId, text).catch(console.error);
    stepState.delete(userId);
    return await ctx.reply(`✅ <b>Сохранено!</b>\n\n${text}`, { parse_mode: 'HTML' });
  }
  return next();
});

async function isWithinWorkingHours(ownerId) {
  try {
    if (!ownerId || isAdmin(ownerId)) return true;
    const schedule = await db.getSchedule(ownerId);
    if (!schedule || !schedule.start_time || !schedule.end_time) return true;
    const now = new Date();
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [startH, startM] = schedule.start_time.split(':').map(Number);
    const [endH, endM] = schedule.end_time.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    return startMinutes <= endMinutes 
      ? (currentMinutes >= startMinutes && currentMinutes <= endMinutes)
      : (currentMinutes >= startMinutes || currentMinutes <= endMinutes);
  } catch (e) {
    return true;
  }
}

bot.on('business_message', async (ctx) => {
  try {
    if (globalThis.globalStop) return;
    const businessMessage = ctx.businessMessage;
    if (!businessMessage || businessMessage.from.is_bot) return;

    const connectionId = businessMessage.business_connection_id; 
    const chatId = String(businessMessage.chat.id);
    const messageId = businessMessage.message_id;
    const senderId = String(businessMessage.from.id);

    const uniqueKey = `${chatId}:${messageId}`;
    if (processedMessages.has(uniqueKey)) return;
    processedMessages.add(uniqueKey);
    setTimeout(() => processedMessages.delete(uniqueKey), 30 * 1000);

    let ownerId = connectionOwners.get(connectionId);
    if (!ownerId) {
      try {
        const conn = await ctx.getBusinessConnection();
        if (conn?.user) {
          ownerId = String(conn.user.id);
          connectionOwners.set(connectionId, ownerId);
        }
      } catch (e) {}
    }

    if (!ownerId) return;

    let isActive = userStatuses.get(ownerId);
    if (isActive === undefined) {
      if (db.getUserActiveStatus) {
        isActive = await db.getUserActiveStatus(ownerId).catch(() => true);
      } else {
        isActive = true;
      }
      userStatuses.set(ownerId, isActive);
    }
    if (isActive === false) return; 

    // Если владелец сам написал в чат — откладываем ответ на 10 минут
    if (senderId === ownerId) {
      localPauses.set(chatId, Date.now() + PAUSE_DURATION);
      return;
    }

    // Проверяем кулдаун (если включен режим кулдауна, бот не отвечает повторно в течение 15 минут)
    const isOwnerInCooldownMode = userCooldownModes.get(ownerId) || false;
    if (isOwnerInCooldownMode) {
      const cooldownUntil = localPauses.get(chatId);
      if (cooldownUntil && cooldownUntil > Date.now()) {
        return; // Бот молчит и не мешает переписке
      }
    }

    if (await db.isPaused?.(chatId).catch(() => false)) return;
    if (!(await isWithinWorkingHours(ownerId))) return;

    let replyText = replyCache.get(ownerId);
    if (!replyText) {
      replyText = await db.getCustomReply(ownerId).catch(() => null);
      if (replyText) {
        replyCache.set(ownerId, replyText);
      }
    }

    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
    }

    try {
      if (replyText.startsWith('combo:')) {
        const parts = replyText.replace('combo:', '').split('|||');
        if (parts[0]) await ctx.api.sendMessage(chatId, parts[0], { business_connection_id: connectionId, parse_mode: 'HTML' });
        if (parts[1]) await ctx.api.sendSticker(chatId, parts[1], { business_connection_id: connectionId });
      } else if (replyText.startsWith('voice:')) {
        const voiceFileId = replyText.replace('voice:', '').trim();
        await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
      } else {
        await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId, parse_mode: 'HTML' });
      }

      // Сразу после отправки включаем 15-минутный таймер для этого чата
      localPauses.set(chatId, Date.now() + COOLDOWN_DURATION);

    } catch (sendError) {
      if (db.saveErrorLog) await db.saveErrorLog(chatId, 'SEND_ERROR', sendError.message);
    }
  } catch (error) {
    console.error('Ошибка бизнес-чата:', error);
  }
});
