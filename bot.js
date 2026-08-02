import { Bot, InlineKeyboard } from 'grammy';
import { db } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('Критическая ошибка: BOT_TOKEN не задан!');
}

export const bot = new Bot(process.env.BOT_TOKEN);

// Список администраторов бота
const ADMIN_IDS = ['6511859639', '7470537453'];

const PAUSE_DURATION = 10 * 60 * 1000; // Пауза 10 минут при ответе владельца
const ANTI_SPAM_PAUSE = 3000;          // Анти-спам пауза 3 секунды
const ONCE_MODE_PAUSE = 15 * 60 * 1000; // Пауза 15 минут для режима "1 раз"

const processedMessages = new Set();
const localPauses = new Map();
const replyCache = new Map();
const replyModeCache = new Map();

// Состояния для пошаговых команд (/sred и /post)
const stepState = new Map();

// Вспомогательная функция проверки админа
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

// --- ФУНКЦИЯ СОЗДАНИЯ КРАСИВОГО МЕНЮ ---
async function getMainMenuKeyboard(userId) {
  let currentMode = replyModeCache.get(userId);
  if (!currentMode && db.getReplyMode) {
      currentMode = await db.getReplyMode(userId).catch(() => 'always');
      replyModeCache.set(userId, currentMode);
  }
  
  const modeText = currentMode === 'once' ? '🔄 Режим: 1 раз' : '🔄 Режим: Всегда';
  
  return new InlineKeyboard()
    .text('👤 Мой профиль', 'btn_profile')
    .text('📝 Текст ответа', 'btn_reply').row()
    .text('⏰ График работы', 'btn_time')
    .text(modeText, 'btn_toggle_mode').row()
    .url('📢 Официальный канал', 'https://t.me/kaguya_2_0_bots');
}

// --- ВЫНЕСЕННАЯ ЛОГИКА ПРОФИЛЯ ---
// Теперь её можно безопасно вызывать из любого места (и из кнопок, и из /my)
async function showUserProfile(ctx, userId) {
  const userInfo = (await db.getUserInfo?.(userId)) || {};
  const customReply = (await db.getCustomReply?.(userId)) || 'Дефолтный текст';
  const schedule = (await db.getSchedule?.(userId)) || null;
  let currentMode = replyModeCache.get(userId) || 'always';

  const dateStr = userInfo.created_at ? new Date(userInfo.created_at).toLocaleDateString('ru-RU') : 'Неизвестно';
  const modeStr = currentMode === 'once' ? '1 раз (затем пауза 15 мин)' : 'На каждое сообщение';

  let profileText = `👤 <b>Ваш профиль:</b>\n\n`;
  profileText += `📅 <b>Подключен:</b> ${dateStr}\n`;
  profileText += `⏰ <b>График работы:</b> ${schedule?.start_time ? `${schedule.start_time} - ${schedule.end_time}` : 'Круглосуточно'}\n`;
  profileText += `🔄 <b>Частота ответов:</b> ${modeStr}\n\n`;
  profileText += `💬 <b>Установленный автоответ:</b>\n<code>${customReply}</code>`;

  await ctx.reply(profileText, { parse_mode: 'HTML' });
}

// --- КОМАНДА /start ---
bot.command('start', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (db.registerUser) {
    db.registerUser(userId, ctx.from.username || ctx.from.first_name).catch(() => {});
  }

  const welcomeText = 
    '👋 <b>Привет! Я бот Кагуя 2.0.</b>\n\n' +
    '⚙️ Я работаю как автоответчик для вашего Telegram Business!\n' +
    '👇 <b>Используйте меню ниже для быстрой настройки:</b>';

  const keyboard = await getMainMenuKeyboard(userId);

  await ctx.reply(welcomeText, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
});

// --- ОБРАБОТКА НАЖАТИЙ НА КНОПКИ ---
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = String(ctx.from.id);

  if (data === 'btn_profile') {
    await ctx.answerCallbackQuery();
    await showUserProfile(ctx, userId);
  }

  if (data === 'btn_reply') {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '📝 <b>Как изменить автоответ:</b>\n\n' +
      '• <b>Обычный текст:</b> Отправьте <code>/set Ваш текст</code>\n' +
      '• <b>Голосовое сообщение:</b> Отправьте <code>/set gs</code>\n' +
      '• <b>Комбо (Текст + Стикер):</b> Отправьте <code>/sred</code>\n' +
      '• <b>Сбросить на стандартный:</b> Отправьте <code>/reset</code>', 
      { parse_mode: 'HTML' }
    );
  }

  if (data === 'btn_time') {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '⏰ <b>Как настроить график работы:</b>\n\n' +
      'Отправьте команду <code>/time</code> и укажите время от и до.\n' +
      '<b>Пример:</b> <code>/time 05:00 20:00</code>\n\n' +
      'Для отключения графика (работа 24/7): <code>/time off</code>', 
      { parse_mode: 'HTML' }
    );
  }

  if (data === 'btn_toggle_mode') {
    let currentMode = replyModeCache.get(userId) || 'always';
    const newMode = currentMode === 'always' ? 'once' : 'always';
    
    replyModeCache.set(userId, newMode);
    if (db.setReplyMode) db.setReplyMode(userId, newMode).catch(() => {});

    // Обновляем клавиатуру, чтобы поменялся текст на кнопке
    const keyboard = await getMainMenuKeyboard(userId);
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    
    const alertText = newMode === 'once' 
      ? '✅ Режим изменен: Отвечаю 1 раз, затем пауза 15 минут.' 
      : '✅ Режим изменен: Отвечаю на каждое сообщение.';
      
    await ctx.answerCallbackQuery({ text: alertText, show_alert: true });
  }
});

// --- КОМАНДА /admins ---
bot.command('admins', async (ctx) => {
  await ctx.reply(
    '🔒 <b>Раздел для администраторов</b>\n\n' +
    'Эта система предназначена только для администраторов, которых добавил лично создатель проекта.',
    { parse_mode: 'HTML' }
  );
});

// --- ИСПРАВЛЕННАЯ КОМАНДА /my ---
bot.command('my', async (ctx) => {
  const userId = String(ctx.from.id);
  await showUserProfile(ctx, userId);
});

bot.command(['reset', 'clear'], async (ctx) => {
  const userId = String(ctx.from.id);
  replyCache.delete(userId);
  await db.setCustomReply(userId, null).catch(console.error);
  stepState.delete(userId);
  await ctx.reply('🗑️ <b>Автоответ успешно сброшен!</b>', { parse_mode: 'HTML' });
});

bot.command('setreply', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.replace(/^\/setreply\s*/i, '').trim().split(/\s+/);
  const targetId = args[0];
  const newReply = args.slice(1).join(' ');

  if (!targetId || !newReply) {
    return await ctx.reply('👑 Формат: <code>/setreply ID Текст</code>', { parse_mode: 'HTML' });
  }

  try {
    if (newReply.toLowerCase() === 'clear') {
      replyCache.delete(targetId);
      await db.setCustomReply(targetId, null);
      return await ctx.reply(`✅ Автоответ для <code>${targetId}</code> сброшен!`, { parse_mode: 'HTML' });
    }
    replyCache.set(targetId, newReply);
    await db.setCustomReply(targetId, newReply);
    await ctx.reply(`👑 Отредактировано для <code>${targetId}</code>`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
});

bot.command('stop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const target = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase();
  if (target === 'all') {
    globalThis.globalStop = true;
    return await ctx.reply('🛑 Глобальный автоответчик ОСТАНОВЛЕН!');
  }
  if (target) {
    localPauses.set(target, Date.now() + 24 * 60 * 60 * 1000);
    if (db.setPause) db.setPause(target, 24 * 60 * 60 * 1000).catch(() => {});
    return await ctx.reply(`🛑 Остановлен для ID: <code>${target}</code>`, { parse_mode: 'HTML' });
  }
});

bot.command('unstop', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const target = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase();
  if (target === 'all') {
    globalThis.globalStop = false;
    return await ctx.reply('✅ Глобальный автоответчик ВКЛЮЧЕН!');
  }
  if (target) {
    localPauses.delete(target);
    if (db.removePause) db.removePause(target).catch(() => {});
    return await ctx.reply(`✅ Возобновлен для ID: <code>${target}</code>`, { parse_mode: 'HTML' });
  }
});

bot.command('m', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const text = ctx.message.text.replace(/^\/m\s*/i, '').trim();
  if (!text) return await ctx.reply('❌ Напишите текст: <code>/m Текст</code>', { parse_mode: 'HTML' });
  
  const users = (await db.getAllUsers?.()) || [];
  await ctx.reply(`📢 Рассылка на ${users.length} чел...`);
  (async () => {
    let successCount = 0;
    for (const u of users) {
      try { await ctx.api.sendMessage(u.user_id, text, { parse_mode: 'HTML' }); successCount++; } catch (e) {}
      await new Promise((res) => setTimeout(res, 50)); 
    }
    await ctx.reply(`🎉 Доставлено: ${successCount}`);
  })();
});

bot.command('post', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  stepState.set(String(ctx.from.id), { step: 'WAITING_POST' });
  await ctx.reply('📢 Отправьте пост для рассылки:');
});

bot.command('time', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const args = ctx.message.text.replace(/^\/time\s*/i, '').trim().split(/\s+/);
    if (args[0] && args[0].toLowerCase() === 'off') {
      await db.setSchedule(userId, null, null);
      return await ctx.reply('✅ График отключен. Бот работает круглосуточно!');
    }
    if (args.length < 2) return await ctx.reply('❌ Формат: <code>/time 05:00 20:00</code>', { parse_mode: 'HTML' });
    await db.setSchedule(userId, args[0], args[1]);
    await ctx.reply(`✅ График работы сохранен: с ${args[0]} до ${args[1]}.`);
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('sred', async (ctx) => {
  stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT' });
  await ctx.reply('✍️ <b>Шаг 1/2:</b> Напишите текст для комбо:');
});

bot.command('set', async (ctx) => {
  const userId = String(ctx.from.id);
  const customText = ctx.message.text.replace(/^\/set\s*/i, '').trim();
  if (customText.toLowerCase() === 'gs') {
    stepState.set(userId, { step: 'WAITING_VOICE' });
    return await ctx.reply('🎤 <b>Отправьте голосовое сообщение:</b>', { parse_mode: 'HTML' });
  }
  if (!customText) return await ctx.reply('❌ Напишите текст после `/set`.', { parse_mode: 'HTML' });
  stepState.delete(userId);
  replyCache.set(userId, customText);
  db.setCustomReply(userId, customText).catch(console.error);
  await ctx.reply(`✅ <b>Сохранено:</b>\n${customText}`, { parse_mode: 'HTML' });
});

bot.on('message', async (ctx, next) => {
  if (ctx.businessMessage) return next();
  const userId = String(ctx.from.id);
  const state = stepState.get(userId);

  if (state && state.step === 'WAITING_POST' && isAdmin(userId)) {
    stepState.delete(userId);
    await ctx.reply('🚀 Начинаю рассылку поста...');
    const users = (await db.getAllUsers?.()) || [];
    (async () => {
      let successCount = 0;
      for (const u of users) {
        try { await ctx.api.copyMessage(u.user_id, ctx.chat.id, ctx.message.message_id); successCount++; } catch (e) {}
        await new Promise((res) => setTimeout(res, 50)); 
      }
      await ctx.reply(`🎉 Пост отправлен! Получили: ${successCount}`);
    })();
    return;
  }
  if (state && state.step === 'WAITING_TEXT' && ctx.message.text) {
    stepState.set(userId, { step: 'WAITING_STICKER', text: ctx.message.text });
    return await ctx.reply('🖼️ <b>Шаг 2/2:</b> Отправьте стикер:');
  }
  if (state && state.step === 'WAITING_STICKER' && ctx.message.sticker) {
    const comboValue = `combo:${state.text}|||${ctx.message.sticker.file_id}`;
    replyCache.set(userId, comboValue);
    db.setCustomReply(userId, comboValue).catch(console.error);
    stepState.delete(userId);
    return await ctx.reply('🔥 Комбо (Текст + Стикер) установлено!');
  }
  if (state && state.step === 'WAITING_VOICE' && ctx.message.voice) {
    const value = `voice:${ctx.message.voice.file_id}`;
    replyCache.set(userId, value);
    db.setCustomReply(userId, value).catch(console.error);
    stepState.delete(userId);
    return await ctx.reply('✅ Голосовое сообщение сохранено!');
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
    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
  } catch (e) {
    return true;
  }
}

// --- АВТОМАТИЗАЦИЯ БИЗНЕС-ЧАТОВ ---
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

    let ownerId = null;
    try {
      const conn = await ctx.getBusinessConnection();
      if (conn && conn.user) ownerId = String(conn.user.id);
    } catch (e) {}

    if (ownerId && senderId === ownerId) {
      localPauses.set(chatId, Date.now() + PAUSE_DURATION);
      return;
    }

    const localPauseUntil = localPauses.get(chatId);
    if (localPauseUntil && localPauseUntil > Date.now()) return;

    const isDbPaused = await db.isPaused?.(chatId).catch(() => false);
    if (isDbPaused) return;

    const active = await isWithinWorkingHours(ownerId);
    if (!active) return;

    let currentMode = 'always';
    if (ownerId) {
       currentMode = replyModeCache.get(ownerId);
       if (!currentMode && db.getReplyMode) {
           currentMode = await db.getReplyMode(ownerId).catch(() => 'always');
           replyModeCache.set(ownerId, currentMode);
       } else if (!currentMode) currentMode = 'always';
    }

    if (currentMode === 'once') {
       localPauses.set(chatId, Date.now() + ONCE_MODE_PAUSE); 
    } else {
       localPauses.set(chatId, Date.now() + ANTI_SPAM_PAUSE); 
    }

    let replyText = null;
    if (ownerId) {
      replyText = replyCache.get(ownerId) || await db.getCustomReply(ownerId).catch(() => null);
    }
    if (!replyText) {
      replyText = 'Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓';
    } else if (ownerId) replyCache.set(ownerId, replyText);

    try {
      if (replyText.startsWith('combo:')) {
        const parts = replyText.replace('combo:', '').split('|||');
        if (parts[0]) await ctx.api.sendMessage(chatId, parts[0], { business_connection_id: connectionId, parse_mode: 'HTML' });
        if (parts[1]) await ctx.api.sendSticker(chatId, parts[1], { business_connection_id: connectionId });
        return;
      }
      if (replyText.startsWith('voice:')) {
        const voiceFileId = replyText.replace('voice:', '').trim();
        await ctx.api.sendVoice(chatId, voiceFileId, { business_connection_id: connectionId });
        return;
      }
      await ctx.api.sendMessage(chatId, replyText, { business_connection_id: connectionId, parse_mode: 'HTML' });
    } catch (sendError) {
      if (db.saveErrorLog) await db.saveErrorLog(chatId, 'SEND_ERROR', sendError.message || 'Ошибка');
    }
  } catch (error) {
    console.error('❌ Ошибка в бизнес-сообщении:', error);
  }
});

// --- ГЛОБАЛЬНЫЙ ПЕРЕХВАТЧИК ОШИБОК ---
// Не даст боту упасть (и отключиться в Render) при непредвиденных ошибках
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[Global Error] Ошибка при обработке апдейта ${ctx.update.update_id}:`);
  console.error(err.error);
});
