// Единая точка чтения и валидации переменных окружения.
// Остальные модули НЕ читают process.env напрямую — только через этот модуль.
import dotenv from 'dotenv';

dotenv.config();

// Временный встроенный список админов, если ADMIN_IDS не задан в env (поведение до Фазы 3).
export const FALLBACK_ADMIN_IDS = Object.freeze(['6511859639', '7470537453']);

// Адрес сервиса на Render, если RENDER_EXTERNAL_URL почему-то не пришёл.
export const DEFAULT_RENDER_URL = 'https://kaguya2-0-bot-clhl.onrender.com';

// "1, 2,3" -> ['1','2','3']; пусто/не задано -> null
export function parseAdminIds(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  return ids.length ? ids : null;
}

// Чистая функция: env -> объект конфига (тестируется без побочных эффектов).
// Ссылка на гайд по подключению, если GUIDE_URL не задан.
export const DEFAULT_GUIDE_URL = 'https://kaguya-gospoja.onrender.com';

// Положительное целое из env, иначе дефолт.
export function parsePositiveInt(raw, fallback) {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_AI_DAILY_LIMIT = 25;

export function loadConfig(env = {}) {
  const adminIdsFromEnv = parseAdminIds(env.ADMIN_IDS);
  const targetChannelId = (env.TARGET_CHANNEL_ID || '').trim();
  return Object.freeze({
    botToken: env.BOT_TOKEN || '',
    databaseUrl: env.DATABASE_URL || '',
    // null — ADMIN_IDS не задан (CLI-скрипты не используют встроенный список)
    adminIdsFromEnv: adminIdsFromEnv ? Object.freeze(adminIdsFromEnv) : null,
    adminIds: Object.freeze(adminIdsFromEnv || [...FALLBACK_ADMIN_IDS]),
    webhookSecret: env.WEBHOOK_SECRET || '',
    targetChannelId,
    // Обязательная подписка на канал: включена, если задан TARGET_CHANNEL_ID (выключается REQUIRE_SUBSCRIPTION=false).
    requireSubscription: Boolean(targetChannelId) && env.REQUIRE_SUBSCRIPTION !== 'false',
    guideUrl: (env.GUIDE_URL || '').trim() || DEFAULT_GUIDE_URL,
    // Fallback-ссылка на канал, если TARGET_CHANNEL_ID — числовой ID, а не @username.
    channelInviteUrl: (env.CHANNEL_INVITE_URL || '').trim(),
    discussionGroupId: (env.DISCUSSION_GROUP_ID || '').trim(),
    renderUrl: env.RENDER_EXTERNAL_URL || DEFAULT_RENDER_URL,
    port: env.PORT || 3000,
    usePolling: env.USE_POLLING === 'true',
    // Gemini AI (.ai/.autoai/.dialog/.kawaii). Пустой ключ — ИИ-команды отключены.
    geminiApiKey: (env.GEMINI_API_KEY || '').trim(),
    geminiModel: (env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL,
    aiDailyLimit: parsePositiveInt(env.AI_DAILY_LIMIT, DEFAULT_AI_DAILY_LIMIT)
  });
}

export const config = loadConfig(process.env);

export function isAdmin(userId, adminIds = config.adminIds) {
  return adminIds.includes(String(userId));
}
