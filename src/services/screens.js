// Чистые билдеры экранов входной воронки (текст HTML + inline-клавиатура). Без БД и сети — тестируются напрямую.
import { InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { escapeHTML } from './html.js';
import { getChannelUrl } from './subscription.js';
import { isAutoReplyActive } from './schedule.js';
import { getMainInlineKeyboard, getAutoReplyInlineKeyboard } from '../bot/keyboards.js';
import { HELP_TEXT } from '../handlers/dotCommands.js';

export const DEFAULT_BOT_USERNAME = 'Kaguya_2_0bot';
const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveBotUsername(ctx) {
  return ctx?.me?.username || DEFAULT_BOT_USERNAME;
}

// 1 пользователь, 2 пользователя, 5 пользователей
export function pluralUsers(n) {
  const abs = Math.abs(Number(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'пользователей';
  if (last === 1) return 'пользователь';
  if (last >= 2 && last <= 4) return 'пользователя';
  return 'пользователей';
}

function formatCount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Отображаемый счётчик: реальное число + USERS_COUNT_OFFSET. null — неизвестно.
export function displayUsersCount(usersCount, cfg = config) {
  if (usersCount === null || usersCount === undefined) return null;
  const n = Number(usersCount);
  if (!Number.isFinite(n)) return null;
  return n + (Number(cfg?.usersCountOffset) || 0);
}

// DD.MM.YYYY с учётом смещения часового пояса пользователя (минуты).
export function formatDate(value, offsetMin = 0) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const local = new Date(d.getTime() + (Number(offsetMin) || 0) * 60 * 1000);
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${local.getUTCFullYear()}`;
}

export function daysSince(value, now = Date.now()) {
  const t = (value instanceof Date ? value : new Date(value)).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

// --- Экран 1: обязательная подписка ---
export function buildSubscriptionScreen({ usersCount = null, cfg = config } = {}) {
  const url = getChannelUrl(cfg);
  const shown = displayUsersCount(usersCount, cfg);
  const countLine = shown > 0
    ? `\n\n⚡ Уже с нами: <b>${formatCount(shown)}</b> ${pluralUsers(shown)}`
    : '';
  const text =
    '<blockquote>📢 <b>Обязательная подписка</b>\n\n' +
    'Чтобы пользоваться ботом, подпишитесь на наш канал — там обновления и новые функции.\n' +
    'После подписки нажмите «Проверить подписку», и доступ откроется автоматически.' +
    countLine +
    '</blockquote>';

  const kb = new InlineKeyboard();
  if (url) kb.url('📢 Подписаться на канал', url);
  kb.text('✅ Проверить подписку', 'check_sub');
  return { text, reply_markup: kb, banner: true };
}

// --- Экран 2: подключение бизнес-бота ---
export function buildOnboardingScreen({ botUsername = DEFAULT_BOT_USERNAME, cfg = config } = {}) {
  const raw = String(botUsername || DEFAULT_BOT_USERNAME).replace(/^@/, '');
  const at = `@${escapeHTML(raw)}`;
  const text =
    '🔌 <b>Подключение бизнес-бота</b>\n' +
    '🆓 <i>Бесплатно и без Telegram Premium</i>\n\n' +
    '<blockquote>' +
    `1️⃣ Нажмите «Скопировать ${at}» ниже\n` +
    '2️⃣ Откройте <b>Настройки → Аккаунт → Автоматизация чатов</b> <i>(на старых версиях: Telegram Business → Чат-боты)</i>\n' +
    `3️⃣ Выберите <code>${at}</code>, укажите «Чаты, доступные боту» и в блоке <b>«Разрешения для бота»</b> включите удаление всех сообщений и удаление отправленных сообщений (нужно для <code>.mute</code>, <code>.del</code>, <code>.kawaii</code> и скрытия триггеров)\n` +
    '4️⃣ Нажмите «Добавить» и вернитесь сюда' +
    '</blockquote>\n\n' +
    '<blockquote expandable>✨ <b>Что появится после привязки</b>\n' +
    '• Автоответчик: текст, голосовое, комбо со стикером, расписание и таймер\n' +
    '• Анти-удаление и анти-редактирование входящих сообщений\n' +
    '• <code>.mute</code> — удалять все сообщения собеседника\n' +
    '• <code>.wsag</code> — удалять его стикеры и GIF\n' +
    '• <code>.del</code> — удалять сообщения из чата\n' +
    '• <code>.burn</code> — самоудаляющиеся сообщения\n' +
    '• <code>.sw</code> — смена раскладки\n' +
    '• <code>.calc</code> — калькулятор прямо в чате' +
    '</blockquote>';

  const kb = new InlineKeyboard()
    .copyText(`📋 Скопировать @${raw}`, `@${raw}`).row()
    .text('🔄 Проверить подключение', 'check_connection');
  if (cfg.guideUrl) kb.url('📖 Инструкция', cfg.guideUrl);
  kb.row().text('🏠 Главное меню', 'open_main_menu');
  return { text, reply_markup: kb, banner: true };
}

// --- Экран 3: главное меню с карточкой профиля ---
// connection: { connected, canDeleteAll } | null (null — статус неизвестен, БД недоступна)
export function buildMainMenuScreen({
  userId, settings = {}, profile = null, usersCount = null, connection = null, now = Date.now(), cfg = config
} = {}) {
  const lines = ['👤 <b>Профиль</b>'];

  if (profile?.created_at) {
    const date = formatDate(profile.created_at, settings.timezone_offset_min);
    const days = daysSince(profile.created_at, now);
    if (date) {
      const since = days === null ? '' : days === 0 ? ' (сегодня)' : ` (${days} дн.)`;
      lines.push(`📅 В боте с <b>${date}</b>${since}`);
    }
  }
  const shown = displayUsersCount(usersCount, cfg);
  if (shown > 0) lines.push(`👥 Пользователей: <b>${formatCount(shown)}</b>`);

  let botLine = '🤖 Бизнес-бот: ';
  if (connection?.connected) {
    botLine += '🟢 Активен';
    if (!connection.canDeleteAll) botLine += ' · ⚠️ без прав .mute';
  } else if (connection) {
    botLine += '⚪ Не подключён';
  } else {
    botLine += '❔ Нет данных';
  }
  lines.push(botLine);

  const antiDeleteOn = settings.anti_delete_enabled !== false;
  lines.push(
    `💬 Автоответ: <b>${isAutoReplyActive(settings) ? 'ВКЛ' : 'ВЫКЛ'}</b> · ` +
    `👁 Анти-удаление: <b>${antiDeleteOn ? 'ВКЛ' : 'ВЫКЛ'}</b>`
  );

  let text = '✨ <b>Kaguya 2.0</b>\n\n<blockquote>' + lines.join('\n') + '</blockquote>';
  if (antiDeleteOn) {
    text += '\n\n<i>Удалённые и изменённые сообщения сохраняются в реальном времени.</i>';
  }
  return { text, reply_markup: getMainInlineKeyboard(userId, settings, cfg), banner: true };
}

function describeCustomReply(reply) {
  if (!reply) return 'стандартный';
  if (reply.startsWith('combo:')) return 'свой · комбо';
  if (reply.startsWith('voice:')) return 'свой · голосовое';
  return 'свой · текст';
}

// --- Подменю «Автоответчик» ---
export function buildAutoReplyMenuScreen({ settings = {} } = {}) {
  const active = isAutoReplyActive(settings);
  const timerOn = settings.timer_mode === true;
  const text =
    '💬 <b>Автоответчик</b>\n\n<blockquote>' +
    `Статус: <b>${active ? '🟢 Включён' : '🔕 Выключен'}</b>\n` +
    `⏱ Таймер 15 мин: <b>${timerOn ? 'ВКЛ' : 'ОТКЛ'}</b>\n` +
    `📝 Ответ: <b>${describeCustomReply(settings.custom_reply)}</b>` +
    '</blockquote>';
  return { text, reply_markup: getAutoReplyInlineKeyboard(settings) };
}

// --- Справка по .командам ---
export function buildDotCommandsScreen() {
  return {
    text: HELP_TEXT,
    reply_markup: new InlineKeyboard().text('⬅️ Назад в меню', 'open_main_menu')
  };
}
