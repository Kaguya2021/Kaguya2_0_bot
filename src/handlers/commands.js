// Пользовательские команды: /start, /my, /reset, /clear, /info, /time, /tz, /sred, /set, /no.
import { isAdmin } from '../config.js';
import { db, DEFAULT_USER_SETTINGS } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import {
  validateTimeArgs,
  parseTzOffset,
  formatTzOffset,
  formatLocalTime,
  isAutoReplyActive,
  isBlocked,
  getAutoOffMinutesLeft
} from '../services/schedule.js';
import { getMainInlineKeyboard, getWelcomeInlineKeyboard } from '../bot/keyboards.js';
import { stepState, getSettings, getSettingsSafe, patchSettings, saveReply } from '../bot/state.js';

export function tzInfoText(settings) {
  const offset = settings?.timezone_offset_min || 0;
  return `🌍 Ваш часовой пояс: <b>${formatTzOffset(offset)}</b>, сейчас по нему <b>${formatLocalTime(new Date(), offset)}</b>.\n` +
    'Изменить: <code>/tz +3</code> (формат: <code>+6</code>, <code>-3</code>, <code>0</code>, <code>+3:30</code>)';
}

export function timeHelpText(settings) {
  return '⏰ <b>Настройка рабочего времени:</b>\n\n' +
    'Отправьте команду с желаемым временем (формат ЧЧ:ММ).\n' +
    '• Пример: <code>/time 05:00 20:00</code>\n' +
    '• Ночной интервал: <code>/time 22:00 06:00</code>\n' +
    '• Отключить лимит: <code>/time off</code>\n\n' +
    tzInfoText(settings);
}

export function registerCommandHandlers(bot) {
  bot.command('start', async (ctx) => {
    const userId = String(ctx.from.id);

    if (db.registerUser) {
      db.registerUser(userId, ctx.from.username || ctx.from.first_name).catch(() => {});
    }

    // Убираем старую обычную клавиатуру снизу экрана (осталась с прошлой версии бота).
    // Отправляем служебное сообщение с remove_keyboard и сразу его удаляем — визуально незаметно.
    try {
      const cleanup = await ctx.reply('🧹', { reply_markup: { remove_keyboard: true } });
      await ctx.api.deleteMessage(ctx.chat.id, cleanup.message_id);
    } catch (e) {}

    const welcomeText =
      '👋 <b>Привет! Я бот Кагуя 2.0.</b>\n\n' +
      '⚙️ Я работающий автоответчик для вашего Telegram Business!\n\n' +
      '📢 <b>Наш официальный канал:</b> <a href="https://t.me/kaguya_2_0_bots">Kaguya 2.0 Channel</a>\n' +
      '<i>Подпишитесь, чтобы быть в курсе всех обновлений и новостей!</i>\n\n' +
      '👇 <b>Используйте удобное меню ниже для настройки:</b>';

    await ctx.reply(welcomeText, {
      parse_mode: 'HTML',
      reply_markup: getWelcomeInlineKeyboard(),
      disable_web_page_preview: true
    });

    await ctx.reply('🚀 <b>Главное меню автоответчика:</b>', {
      parse_mode: 'HTML',
      reply_markup: getMainInlineKeyboard(userId, await getSettingsSafe(userId))
    });
  });

  bot.command('my', async (ctx) => {
    const userId = String(ctx.from.id);
    let currentReply;
    try { currentReply = (await getSettings(userId)).custom_reply; }
    catch (e) { return await ctx.reply('⚠️ База данных временно недоступна, попробуйте позже.'); }
    if (!currentReply) {
      return await ctx.reply('ℹ️ У вас установлен <b>дефолтный текст</b>.', { parse_mode: 'HTML' });
    }
    await ctx.reply(`✍️ <b>Ваш текущий автоответ:</b>\n\n${escapeHTML(currentReply)}`, { parse_mode: 'HTML' });
  });

  bot.command(['reset', 'clear'], async (ctx) => {
    const userId = String(ctx.from.id);
    stepState.delete(userId);
    try {
      await db.setCustomReply(userId, null);
      patchSettings(userId, { custom_reply: null });
    } catch (e) {
      return await ctx.reply('⚠️ Не удалось сбросить (база данных недоступна). Попробуйте позже.');
    }
    await ctx.reply('🗑️ <b>Ваш автоответ успешно сброшен!</b>', { parse_mode: 'HTML' });
  });

  bot.command('info', async (ctx) => {
    const userId = String(ctx.from.id);
    const args = ctx.message.text.trim().split(/\s+/);
    const targetId = args[1];

    if (isAdmin(userId) && targetId) {
      try {
        let userInfo = {};
        if (db.getUserInfo) {
          userInfo = await db.getUserInfo(targetId) || {};
        }

        const targetSettings = await db.getUserSettings(targetId).catch(() => ({ ...DEFAULT_USER_SETTINGS }));
        const customReply = targetSettings.custom_reply || 'Стандартный дефолтный текст';
        const schedule = targetSettings;
        const autoReplyStatus = isBlocked(targetSettings)
          ? '⛔ Заблокирован админом'
          : isAutoReplyActive(targetSettings)
            ? '✅ Включен'
            : `🔕 Выключен (осталось ${getAutoOffMinutesLeft(targetSettings)} мин)`;

        let infoText = `📊 <b>Информация о пользователе ID:</b> <code>${targetId}</code>\n\n`;
        infoText += `📅 <b>Подключен:</b> ${userInfo.created_at || userInfo.date || 'Неизвестно'}\n`;
        infoText += `👤 <b>Username/Имя:</b> ${userInfo.username || userInfo.name || 'Нет данных'}\n`;
        infoText += `🔔 <b>Статус автоответа:</b> ${autoReplyStatus}\n`;
        infoText += `💬 <b>Текущий автоответ:</b>\n<code>${escapeHTML(customReply)}</code>\n\n`;
        infoText += `⏰ <b>График работы:</b> ${schedule?.start_time ? `${schedule.start_time} - ${schedule.end_time}` : 'Круглосуточно'} (${formatTzOffset(targetSettings.timezone_offset_min)})`;

        return await ctx.reply(infoText, { parse_mode: 'HTML' });
      } catch (e) {
        return await ctx.reply(`❌ Ошибка получения информации: ${e.message}`);
      }
    }

    const infoText =
      'ℹ️ <b>Информация о боте Кагуя 2.0</b>\n\n' +
      '🤖 Персональный автоответчик для Telegram Business.\n' +
      '• <b>Кнопка «Выключить автоответ»:</b> Останавливает автоответчик на 5 минут, после чего он включается сам. Можно включить раньше вручную.\n\n' +
      (isAdmin(userId) ? '👑 <i>Админ-совет:</i> Введите <code>/info ID_пользователя</code>, чтобы посмотреть его настройки.\n\n' : '') +
      '📢 <b>Канал проекта:</b> @kaguya_2_0_bots';

    await ctx.reply(infoText, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  bot.command('time', async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const rawArgs = (ctx.match || '').trim();
      const args = rawArgs ? rawArgs.split(/\s+/) : [];

      if (args[0] && args[0].toLowerCase() === 'off') {
        await db.setSchedule(userId, null, null);
        patchSettings(userId, { start_time: null, end_time: null });
        return await ctx.reply('✅ <b>Ограничение по времени отключено.</b>', { parse_mode: 'HTML' });
      }

      const parsed = validateTimeArgs(args);
      if (!parsed.ok) {
        return await ctx.reply(
          '❌ Неверный формат. Укажите время как ЧЧ:ММ (00:00–23:59): <code>/time 05:00 20:00</code> или <code>/time off</code>\n\n' +
          tzInfoText(await getSettingsSafe(userId)),
          { parse_mode: 'HTML' }
        );
      }

      await db.setSchedule(userId, parsed.start, parsed.end);
      patchSettings(userId, { start_time: parsed.start, end_time: parsed.end });
      const settings = await getSettingsSafe(userId);
      await ctx.reply(
        `✅ <b>График сохранен!</b> с ${parsed.start} до ${parsed.end} (${formatTzOffset(settings.timezone_offset_min)}).\n\n` +
        tzInfoText(settings),
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  });

  bot.command('tz', async (ctx) => {
    const userId = String(ctx.from.id);
    const arg = (ctx.match || '').trim();

    if (!arg) {
      return await ctx.reply(tzInfoText(await getSettingsSafe(userId)) + '\nДиапазон: от -12 до +14 часов.', { parse_mode: 'HTML' });
    }

    const offset = parseTzOffset(arg);
    if (offset === null) {
      return await ctx.reply(
        '❌ Неверный часовой пояс. Примеры: <code>/tz +6</code>, <code>/tz -3</code>, <code>/tz 0</code>, <code>/tz +3:30</code> (от -12 до +14).',
        { parse_mode: 'HTML' }
      );
    }

    try {
      await db.setTimezoneOffset(userId, offset);
    } catch (e) {
      return await ctx.reply('⚠️ Не удалось сохранить часовой пояс (база данных недоступна). Попробуйте позже.');
    }
    patchSettings(userId, { timezone_offset_min: offset });
    await ctx.reply(
      `✅ <b>Часовой пояс сохранён:</b> ${formatTzOffset(offset)}\nСейчас по нему: <b>${formatLocalTime(new Date(), offset)}</b>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('sred', async (ctx) => {
    stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT' });
    await ctx.reply('✍️ <b>Шаг 1/2:</b> Напишите текст автоответа:', { parse_mode: 'HTML' });
  });

  bot.command('set', async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const customText = (ctx.message.text || '').replace(/^\/set\s*/i, '').trim();

      if (customText.toLowerCase() === 'gs') {
        stepState.set(userId, { step: 'WAITING_VOICE' });
        return await ctx.reply('🎤 <b>Отправьте голосовое сообщение:</b>', { parse_mode: 'HTML' });
      }

      if (!customText) return await ctx.reply('❌ Ошибка. Напишите текст после <code>/set</code>.', { parse_mode: 'HTML' });

      stepState.delete(userId);
      if (!(await saveReply(ctx, userId, customText))) return;

      await ctx.reply(`✅ <b>Успешно сохранено!</b>\n\n${escapeHTML(customText)}`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  });

  bot.command('no', async (ctx) => {
    const arg = (ctx.match || '').trim().toLowerCase();
    if (arg !== 'us') {
      return await ctx.reply('❌ Использование: <code>/no us</code> — снять ограничение по аккаунту.', { parse_mode: 'HTML' });
    }
    const userId = String(ctx.from.id);
    try {
      await db.setAllowedUsername(userId, null);
      patchSettings(userId, { allowed_username: null });
    } catch (e) {
      return await ctx.reply('⚠️ Не удалось снять ограничение (база данных недоступна). Попробуйте позже.');
    }
    stepState.delete(userId);
    await ctx.reply('✅ <b>Ограничение по аккаунту снято.</b> Автоответчик снова работает для всех.', { parse_mode: 'HTML' });
  });
}
