// Навигация по экранам воронки в личке: подписка -> подключение -> главное меню.
// Только приватный чат (/start и callback-кнопки) — из business_* не вызывается.
import { config } from '../config.js';
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { getSettingsSafe, getUsersCountCached } from './state.js';
import {
  buildSubscriptionScreen,
  buildOnboardingScreen,
  buildMainMenuScreen,
  buildDotCommandsScreen,
  buildAutoReplyMenuScreen,
  resolveBotUsername
} from '../services/screens.js';

const NOT_MODIFIED_RE = /message is not modified/i;

// Баннер (screen.banner + MENU_BANNER_URL): невидимая ссылка + крупное превью над текстом.
// Картинку скачивает Telegram — сервер бота не нагружается.
export function buildScreenMessage(screen, cfg = config) {
  const bannerUrl = cfg?.menuBannerUrl || '';
  if (screen.banner && bannerUrl.startsWith('https://')) {
    return {
      text: `<a href="${escapeHTML(bannerUrl)}">&#8205;</a>` + screen.text,
      link_preview_options: { url: bannerUrl, prefer_large_media: true, show_above_text: true, is_disabled: false }
    };
  }
  return { text: screen.text, link_preview_options: { is_disabled: true } };
}

// edit: true — обновить текущее сообщение (callback), при неудаче — новое сообщение.
export async function renderScreen(ctx, screen, { edit = false, cfg = config } = {}) {
  const { text, link_preview_options } = buildScreenMessage(screen, cfg);
  const options = {
    parse_mode: 'HTML',
    reply_markup: screen.reply_markup,
    link_preview_options
  };
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (e) {
      if (NOT_MODIFIED_RE.test(e?.description || e?.message || '')) return;
    }
  }
  await ctx.reply(text, options);
}

// null — статус неизвестен (БД недоступна).
export async function getConnectionStatusSafe(userId) {
  try {
    return await db.getOwnerConnectionStatus(String(userId));
  } catch (e) {
    return null;
  }
}

export async function showSubscription(ctx, opts) {
  const usersCount = await getUsersCountCached();
  await renderScreen(ctx, buildSubscriptionScreen({ usersCount }), opts);
}

export async function showOnboarding(ctx, opts) {
  await renderScreen(ctx, buildOnboardingScreen({ botUsername: resolveBotUsername(ctx) }), opts);
}

export async function showMainMenu(ctx, opts = {}) {
  const userId = String(ctx.from.id);
  const [settings, profile, usersCount, connection] = await Promise.all([
    getSettingsSafe(userId),
    Promise.resolve().then(() => db.getUserProfile(userId)).catch(() => null),
    getUsersCountCached(),
    opts.connection !== undefined ? opts.connection : getConnectionStatusSafe(userId)
  ]);
  await renderScreen(ctx, buildMainMenuScreen({ userId, settings, profile, usersCount, connection }), opts);
}

export async function showAutoReplyMenu(ctx, opts) {
  const settings = await getSettingsSafe(String(ctx.from.id));
  await renderScreen(ctx, buildAutoReplyMenuScreen({ settings }), opts);
}

export async function showDotCommands(ctx, opts) {
  await renderScreen(ctx, buildDotCommandsScreen(), opts);
}

// Экран после пройденной подписки: новичок без подключения и без своего автоответа -> подключение,
// иначе главное меню (старые пользователи, подключившие бота до миграции 004, не застревают).
export async function showEntryScreen(ctx, opts) {
  const userId = String(ctx.from.id);
  const [connection, settings] = await Promise.all([getConnectionStatusSafe(userId), getSettingsSafe(userId)]);
  const isNewcomer = connection !== null && !connection.connected && !settings.custom_reply;
  if (isNewcomer) return showOnboarding(ctx, opts);
  return showMainMenu(ctx, { ...opts, connection });
}
