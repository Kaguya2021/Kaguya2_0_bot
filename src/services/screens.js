// Чистые билдеры экранов входной воронки (текст HTML + inline-клавиатура). Без БД и сети — тестируются напрямую.
import { InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { escapeHTML } from './html.js';
import { getChannelUrl } from './subscription.js';
import { isAutoReplyActive } from './schedule.js';
import { getMainInlineKeyboard } from '../bot/keyboards.js';
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
  const countLine = Number(usersCount) > 0
    ? `\n\n⚡ Уже с нами: <b>${formatCount(usersCount)}</b> ${pluralUsers(usersCount)}`
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
  return { text, reply_markup: kb };
}

// --- Экран 2: подключение бизнес-бота ---
export function buildOnboardingScreen({ botUsername = DEFAULT_BOT_USERNAME, cfg = config } = {}) {
  const raw = String(botUsername || DEFAULT_BOT_USERNAME).replace(/^@/, '');
  const at = `@${escapeHTML(raw)}`;
  const text =
    '🔌 <b>Подключение бизнес-бота</b>\n\n' +
    '<blockquote>' +
    `1️⃣ Нажмите «Скопировать ${at}» ниже\n` +
    '2️⃣ Откройте <b>Настройки → Telegram Business → Чат-боты</b>\n' +
    `3️⃣ Укажите <code>${at}</code> и включите нужные права (для <code>.mute</code> и <code>.del</code> — «Удаление всех сообщений»)\n` +
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
  return { text, reply_markup: kb };
}

// --- Экран 3: главное меню с карточкой профиля ---
// connection: { connected, canDeleteAll } | null (null — статус неизвестен, БД недоступна)
export function buildMainMenuScreen({ userId, settings = {}, profile = null, usersCount = null, connection = null, now = Date.now() } = {}) {
  const lines = ['👤 <b>Профиль</b>'];

  if (profile?.created_at) {
    const date = formatDate(profile.created_at, settings.timezone_offset_min);
    const days = daysSince(profile.created_at, now);
    if (date) lines.push(`📅 Первое появление: <b>${date}</b>${days !== null ? ` (с нами ${days} дн.)` : ''}`);
  }
  if (Number(usersCount) > 0) lines.push(`👥 Пользователей в боте: <b>${formatCount(usersCount)}</b>`);

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
    `💬 Автоответчик: <b>${isAutoReplyActive(settings) ? 'ВКЛ' : 'ВЫКЛ'}</b> · ` +
    `👁 Анти-удаление: <b>${antiDeleteOn ? 'ВКЛ' : 'ВЫКЛ'}</b>`
  );

  let text = '🚀 <b>Главное меню</b>\n\n<blockquote>' + lines.join('\n') + '</blockquote>';
  if (antiDeleteOn) {
    text += '\n\n<i>Все входящие удалённые и отредактированные сообщения сохраняются в реальном времени.</i>';
  }
  return { text, reply_markup: getMainInlineKeyboard(userId, settings) };
}

// --- Справка по .командам ---
export function buildDotCommandsScreen() {
  return {
    text: HELP_TEXT,
    reply_markup: new InlineKeyboard().text('⬅️ Назад в меню', 'open_main_menu')
  };
}
