// In-memory состояние бота: ограниченные кэши, global_stop и хелперы настроек пользователя.
import { db, DEFAULT_USER_SETTINGS } from '../db/index.js';
import { createBotCaches, stopCachesCleanup } from '../services/cache.js';

const caches = createBotCaches();

export const {
  processedMessages,
  localPauses,
  stepState,
  connectionOwners,
  userSettingsCache
} = caches;

// Останавливает таймеры очистки всех кэшей (чистое завершение процесса/тестов).
export function stopCacheCleanup() {
  stopCachesCleanup(caches);
}

// --- global_stop (персистентно в bot_state) ---

let globalStop = false;
let botStateReady = null;

export function isGlobalStop() {
  return globalStop;
}

export function setGlobalStop(value) {
  globalStop = value === true;
}

// Дожидается загрузки bot_state (если она запускалась). Никогда не reject'ится.
export async function waitBotStateReady() {
  if (botStateReady) await botStateReady;
}

// Загружает персистентное состояние бота (global_stop) из БД. Вызывается при старте.
// Никогда не reject'ится; business_message дожидается её, чтобы не ответить до загрузки global_stop.
export function loadBotState() {
  botStateReady = (async () => {
    try {
      globalStop = (await db.getBotState('global_stop')) === 'true';
      if (globalStop) console.warn('🛑 global_stop = true (загружено из БД): автоответчик остановлен для всех.');
    } catch (e) {
      console.error('⚠️ Не удалось загрузить bot_state из БД:', e?.message || e);
    }
  })();
  return botStateReady;
}

// --- Настройки пользователя ---

// Настройки пользователя: кэш -> БД (один SELECT). Ошибку БД пробрасывает (в кэш не пишем).
export async function getSettings(userId) {
  if (userSettingsCache.has(userId)) return userSettingsCache.get(userId);
  const settings = await db.getUserSettings(userId);
  userSettingsCache.set(userId, settings);
  return settings;
}

// Для меню: при недоступной БД возвращаем дефолт (как раньше getTimerMode -> false).
export async function getSettingsSafe(userId) {
  try {
    return await getSettings(userId);
  } catch (e) {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

// Обновляет кэш после успешной записи в БД (если записи нет — следующий запрос подтянет из БД).
export function patchSettings(userId, patch) {
  if (userSettingsCache.has(userId)) {
    userSettingsCache.set(userId, { ...userSettingsCache.get(userId), ...patch });
  }
}

// Сохраняет автоответ в БД и только после успеха кладёт в кэш.
// При сбое БД сообщает пользователю и возвращает false (без ложного "Сохранено").
export async function saveReply(ctx, userId, value) {
  try {
    await db.setCustomReply(userId, value);
    patchSettings(userId, { custom_reply: value });
    return true;
  } catch (e) {
    await ctx.reply('⚠️ Не удалось сохранить автоответ (база данных недоступна). Попробуйте ещё раз через минуту.').catch(() => {});
    return false;
  }
}
