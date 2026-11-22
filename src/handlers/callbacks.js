// Callback-кнопки пользовательского главного меню и настроек.
import { isAdmin } from '../config.js';
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { isAutoReplyActive } from '../services/schedule.js';
import { getMainInlineKeyboard, getSettingsInlineKeyboard, getAutoReplyInlineKeyboard } from '../bot/keyboards.js';
import { stepState, getSettings, getSettingsSafe, patchSettings } from '../bot/state.js';
import { timeHelpText } from './commands.js';
import { showAdminPanel } from './admin.js';
import { checkUserSubscription, isSubscriptionGateActive } from '../services/subscription.js';
import {
  showSubscription, showOnboarding, showMainMenu, showDotCommands, showEntryScreen, getConnectionStatusSafe,
  showAutoReplyMenu
} from '../bot/menu.js';

const AUTO_OFF_DURATION = 5 * 60 * 1000;

// Callback'и, которые не проходят через гейт подписки.
const GATE_EXEMPT = new Set(['check_sub']);

// Бизнес-колбэки (кнопки под сообщениями бота в бизнес-чатах) и игры g:* гейт не проверяет никогда.
export function isGateExemptCallback(cq) {
  const data = cq?.data || '';
  return GATE_EXEMPT.has(data) || data.startsWith('g:') ||
    Boolean(cq?.business_connection_id || cq?.message?.business_connection_id);
}

export function registerCallbackHandlers(bot) {
  // ===== ГЕЙТ ОБЯЗАТЕЛЬНОЙ ПОДПИСКИ (только личка) =====
  // Админские draft_* зарегистрированы раньше (admin.js) и сюда не доходят.
  // Для подписанных — ответ из кэша (0 запросов к Bot API в пределах 10 минут).
  bot.on('callback_query:data', async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !isSubscriptionGateActive() || isGateExemptCallback(ctx.callbackQuery)) {
      return next();
    }
    const sub = await checkUserSubscription(ctx.api, ctx.from.id);
    if (sub.subscribed) return next();
    await ctx.answerCallbackQuery({ text: 'Сначала подпишитесь на канал.' }).catch(() => {});
    await showSubscription(ctx, { edit: true });
  });

  // ===== ВОРОНКА: ПОДПИСКА, ПОДКЛЮЧЕНИЕ, ГЛАВНОЕ МЕНЮ =====

  bot.callbackQuery('check_sub', async (ctx) => {
    const sub = await checkUserSubscription(ctx.api, ctx.from.id, { force: true });
    if (!sub.subscribed) {
      return await ctx.answerCallbackQuery({
        text: 'Подписка на канал не найдена. Подпишитесь и нажмите снова.',
        show_alert: true
      });
    }
    await ctx.answerCallbackQuery({ text: '✅ Подписка подтверждена!' });
    await showEntryScreen(ctx, { edit: true });
  });

  bot.callbackQuery('check_connection', async (ctx) => {
    const userId = String(ctx.from.id);
    const status = await getConnectionStatusSafe(userId);
    if (!status) {
      return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
    }
    if (!status.connected) {
      return await ctx.answerCallbackQuery({
        text: 'Подключение пока не обнаружено. Добавьте бота в Telegram Business → Чат-боты ' +
          '(или напишите любое сообщение в чате, если бот уже подключён).',
        show_alert: true
      });
    }
    await ctx.answerCallbackQuery(status.canDeleteAll
      ? { text: '✅ Бизнес-бот активен!' }
      : {
        text: '✅ Бизнес-бот активен!\n\nДля .mute и .del включите право «Удаление всех сообщений» в Telegram Business → Чат-боты.',
        show_alert: true
      });
    await showMainMenu(ctx, { edit: true, connection: status });
  });

  bot.callbackQuery('open_onboarding', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showOnboarding(ctx, { edit: true });
  });

  bot.callbackQuery('open_main_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx, { edit: true });
  });

  bot.callbackQuery('open_autoreply_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showAutoReplyMenu(ctx, { edit: true });
  });

  bot.callbackQuery('show_dot_commands', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDotCommands(ctx, { edit: true });
  });

  // ===== ОБРАБОТЧИКИ INLINE-КНОПОК ГЛАВНОГО МЕНЮ =====

  bot.callbackQuery('toggle_autoreply', async (ctx) => {
    const userId = String(ctx.from.id);
    let settings;
    try {
      settings = await getSettings(userId);
    } catch (e) {
      return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
    }

    const turnOff = isAutoReplyActive(settings);
    const until = turnOff ? Date.now() + AUTO_OFF_DURATION : null;
    try {
      await db.setAutoOffUntil(userId, until);
    } catch (e) {
      return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
    }
    patchSettings(userId, { auto_off_until: until });

    await ctx.answerCallbackQuery({ text: turnOff ? '🔕 Автоответчик выключен на 5 минут' : '🔔 Автоответчик включен!' });
    // Перерисовываем карточку меню (статус автоответчика в тексте); при сбое — хотя бы кнопки.
    try {
      await showMainMenu(ctx, { edit: true });
    } catch (e) {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: getMainInlineKeyboard(userId, await getSettingsSafe(userId)) });
      } catch (e2) {}
    }
  });

  bot.callbackQuery('toggle_timer_mode', async (ctx) => {
    const userId = String(ctx.from.id);
    const current = (await getSettingsSafe(userId)).timer_mode === true;
    const next = !current;
    try {
      await db.setTimerMode(userId, next);
      patchSettings(userId, { timer_mode: next });
    } catch (e) {
      return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
    }

    await ctx.answerCallbackQuery({
      text: next
        ? '⏱ Включено: 1 автоответ раз в 15 минут на чат.'
        : '⛔ Выключено: автоответ снова на каждое сообщение.'
    });
    // Перерисовываем подменю автоответчика (статус + кнопка таймера); при сбое — хотя бы кнопки.
    try {
      await showAutoReplyMenu(ctx, { edit: true });
    } catch (e) {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: getAutoReplyInlineKeyboard({ ...(await getSettingsSafe(userId)), timer_mode: next }) });
      } catch (e2) {}
    }
  });

  bot.callbackQuery('set_text', async (ctx) => {
    stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT_ONLY' });
    await ctx.answerCallbackQuery();
    await ctx.reply('✍️ <b>Напишите текст автоответа, который вы хотите установить:</b>', { parse_mode: 'HTML' });
  });

  bot.callbackQuery('set_voice', async (ctx) => {
    stepState.set(String(ctx.from.id), { step: 'WAITING_VOICE' });
    await ctx.answerCallbackQuery();
    await ctx.reply('🎤 <b>Отправьте или перешлите мне голосовое сообщение для автоответа:</b>', { parse_mode: 'HTML' });
  });

  bot.callbackQuery('set_combo', async (ctx) => {
    stepState.set(String(ctx.from.id), { step: 'WAITING_TEXT' });
    await ctx.answerCallbackQuery();
    await ctx.reply('✍️ <b>Шаг 1/2:</b> Напишите текст, который должен отправляться со стикером:', { parse_mode: 'HTML' });
  });

  bot.callbackQuery(['my_reply', 'show_my'], async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = String(ctx.from.id);
    let currentReply;
    try { currentReply = (await getSettings(userId)).custom_reply; }
    catch (e) { return await ctx.reply('⚠️ База данных временно недоступна, попробуйте позже.'); }

    if (!currentReply) {
      return await ctx.reply('ℹ️ У вас установлен <b>дефолтный текст</b>:\n<i>Здравствуйте! Извините, я сейчас занят, но скоро обязательно вам отвечу. 🤓</i>', { parse_mode: 'HTML' });
    }

    if (currentReply.startsWith('combo:')) {
      const parts = currentReply.replace('combo:', '').split('|||');
      return await ctx.reply(`🔥 <b>Ваш автоответ (Комбо):</b>\n\n📝 Текст: <code>${escapeHTML(parts[0])}</code>\n🖼️ Sticker ID: <code>${parts[1]}</code>`, { parse_mode: 'HTML' });
    }

    if (currentReply.startsWith('voice:')) {
      const voiceId = currentReply.replace('voice:', '');
      return await ctx.reply(`🎤 <b>Ваш автоответ (Голосовое):</b>\nID файла: <code>${voiceId}</code>`, { parse_mode: 'HTML' });
    }

    await ctx.reply(`✍️ <b>Ваш текущий автоответ:</b>\n\n${escapeHTML(currentReply)}`, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('reset_reply', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = String(ctx.from.id);
    stepState.delete(userId);
    try {
      await db.setCustomReply(userId, null);
      patchSettings(userId, { custom_reply: null });
    } catch (e) {
      return await ctx.reply('⚠️ Не удалось сбросить (база данных недоступна). Попробуйте позже.');
    }

    await ctx.reply('🗑️ <b>Ваш автоответ успешно сброшен!</b> Теперь будет отправляться стандартный текст.', { parse_mode: 'HTML' });
  });

  bot.callbackQuery('set_time', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(timeHelpText(await getSettingsSafe(String(ctx.from.id))), { parse_mode: 'HTML' });
  });

  bot.callbackQuery('admin_panel', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (isAdmin(ctx.from.id)) {
      await showAdminPanel(ctx);
    }
  });

  // ===== НАСТРОЙКИ: ПРИВЯЗКА АВТООТВЕТА К КОНКРЕТНОМУ АККАУНТУ =====

  bot.callbackQuery(['settings_menu', 'open_settings'], async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = String(ctx.from.id);
    let settings;
    try {
      settings = await getSettings(userId);
    } catch (e) {
      return await ctx.reply('⚠️ База данных временно недоступна, попробуйте позже.');
    }

    const allowedUsername = settings.allowed_username;
    const statusLine = allowedUsername
      ? `🔗 Сейчас автоответчик работает только для <code>@${escapeHTML(allowedUsername)}</code>.`
      : '🔓 Сейчас автоответчик работает для всех, без ограничений.';

    await ctx.reply(
      '⚙️ <b>Настройки</b>\n\n' +
      'Здесь можно ограничить автоответчик так, чтобы он отвечал только одному конкретному аккаунту.\n\n' +
      `${statusLine}\n\n` +
      'Чтобы снять ограничение — отправьте команду <code>/no us</code>.\n\n' +
      '👁 <b>Анти-удаление</b> — присылать сюда сообщения, которые собеседник удалил или отредактировал.',
      { parse_mode: 'HTML', reply_markup: getSettingsInlineKeyboard(settings) }
    );
  });

  bot.callbackQuery('toggle_antidelete', async (ctx) => {
    const userId = String(ctx.from.id);
    const current = (await getSettingsSafe(userId)).anti_delete_enabled !== false;
    const next = !current;
    try {
      await db.setAntiDeleteEnabled(userId, next);
      patchSettings(userId, { anti_delete_enabled: next });
    } catch (e) {
      return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
    }

    await ctx.answerCallbackQuery({
      text: next
        ? '👁 Анти-удаление включено: удалённые и изменённые сообщения будут приходить сюда.'
        : '🙈 Анти-удаление выключено.'
    });
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: getSettingsInlineKeyboard({ ...(await getSettingsSafe(userId)), anti_delete_enabled: next })
      });
    } catch (e) {}
  });

  bot.callbackQuery('settings_add_account', async (ctx) => {
    await ctx.answerCallbackQuery();
    stepState.set(String(ctx.from.id), { step: 'WAITING_ACCOUNT' });
    await ctx.reply(
      '➕ <b>Добавление аккаунта</b>\n\n' +
      'Напишите username пользователя, для которого должен работать автоответчик.\n' +
      'Пример: <code>@kaguya2_0</code>\n\n' +
      'После этого автоответчик будет отвечать только этому аккаунту, всем остальным — нет.\n' +
      'Чтобы отключить ограничение — команда <code>/no us</code>.',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('settings_back', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx, { edit: true });
  });
}
