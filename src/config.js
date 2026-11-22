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
export function loadConfig(env = {}) {
  const adminIdsFromEnv = parseAdminIds(env.ADMIN_IDS);
  return Object.freeze({
    botToken: env.BOT_TOKEN || '',
    databaseUrl: env.DATABASE_URL || '',
    // null — ADMIN_IDS не задан (CLI-скрипты не используют встроенный список)
    adminIdsFromEnv: adminIdsFromEnv ? Object.freeze(adminIdsFromEnv) : null,
    adminIds: Object.freeze(adminIdsFromEnv || [...FALLBACK_ADMIN_IDS]),
    webhookSecret: env.WEBHOOK_SECRET || '',
    targetChannelId: (env.TARGET_CHANNEL_ID || '').trim(),
    discussionGroupId: (env.DISCUSSION_GROUP_ID || '').trim(),
    renderUrl: env.RENDER_EXTERNAL_URL || DEFAULT_RENDER_URL,
    port: env.PORT || 3000,
    usePolling: env.USE_POLLING === 'true'
  });
}

export const config = loadConfig(process.env);

export function isAdmin(userId, adminIds = config.adminIds) {
  return adminIds.includes(String(userId));
}
