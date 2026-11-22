// In-memory состояние бота: ограниченные кэши, global_stop и хелперы настроек пользователя.
import { db, DEFAULT_USER_SETTINGS } from '../db/index.js';
import { createBotCaches, stopCachesCleanup } from '../services/cache.js';
import { stopDeleteQueue } from '../services/deleteQueue.js';

const caches = createBotCaches();

export const {
  processedMessages,
  localPauses,
  stepState,
  connectionOwners,
  connectionMeta,
  userSettingsCache
} = caches;

// Таймеры .burn (самоудаление сообщений) — чистятся при остановке.
export const burnTimers = new Set();

// Фоновые таймеры состояния (очистка кэша сообщений, повтор загрузки правил).
const PRUNE_INTERVAL = 6 * 60 * 60 * 1000;
const PRUNE_FIRST_DELAY = 60 * 1000;
const RULES_RETRY_DELAY = 30 * 1000;
const BUSINESS_CACHE_DAYS = 7;
const stateTimers = new Set();

function trackTimer(timer) {
  timer?.unref?.();
  stateTimers.add(timer);
  return timer;
}

// Останавливает таймеры очистки всех кэшей (чистое завершение процесса/тестов).
export function stopCacheCleanup() {
  stopCachesCleanup(caches);
  for (const t of stateTimers) { clearTimeout(t); clearInterval(t); }
  stateTimers.clear();
  pruningStarted = false;
  for (const t of burnTimers) clearTimeout(t);
  burnTimers.clear();
  stopDeleteQueue();
}

// --- Правила чатов (мут / автоудаление стикеров и GIF) ---
// Полная in-memory копия активных chat_rules: проверка на горячем пути — 0 SQL-запросов.
// Map без TTL: активных правил немного, а потеря записи = молча выключенный мут.
const chatRules = new Map(); // `${ownerId}:${chatId}` -> { isMuted, deleteStickersGifs }
const touchedBeforeLoad = new Set(); // ключи, изменённые до завершения загрузки из БД
let chatRulesLoaded = false;

const ruleKey = (ownerId, chatId) => `${ownerId}:${chatId}`;

export function getChatRule(ownerId, chatId) {
  return chatRules.get(ruleKey(ownerId, chatId)) || null;
}

// Синхронно обновляет кэш после успешной записи в БД. Неактивное правило удаляется.
export function setChatRuleInCache(ownerId, chatId, rule) {
  const key = ruleKey(ownerId, chatId);
  if (!chatRulesLoaded) touchedBeforeLoad.add(key);
  const merged = { isMuted: false, deleteStickersGifs: false, ...(chatRules.get(key) || {}), ...(rule || {}) };
  const next = { isMuted: merged.isMuted === true, deleteStickersGifs: merged.deleteStickersGifs === true };
  if (next.isMuted || next.deleteStickersGifs) chatRules.set(key, next);
  else chatRules.delete(key);
  return next;
}

export function clearChatRulesCache() {
  chatRules.clear();
  touchedBeforeLoad.clear();
  chatRulesLoaded = false;
}

async function loadChatRules() {
  try {
    const rules = await db.getAllActiveChatRules();
    for (const r of rules) {
      const key = ruleKey(r.ownerId, r.chatId);
      if (touchedBeforeLoad.has(key)) continue; // локальная запись свежее
      chatRules.set(key, { isMuted: r.isMuted === true, deleteStickersGifs: r.deleteStickersGifs === true });
    }
    chatRulesLoaded = true;
    touchedBeforeLoad.clear();
  } catch (e) {
    console.error('⚠️ Не удалось загрузить chat_rules из БД (повтор через 30 сек):', e?.message || e);
    const t = trackTimer(setTimeout(() => {
      stateTimers.delete(t);
      loadChatRules();
    }, RULES_RETRY_DELAY));
  }
}

// Очистка business_messages_cache старше 7 дней (best-effort, не блокирует старт).
async function pruneBusinessCache() {
  try {
    const removed = await db.pruneOldBusinessMessages(BUSINESS_CACHE_DAYS);
    if (removed) console.log(`🧹 business_messages_cache: удалено ${removed} записей старше ${BUSINESS_CACHE_DAYS} дн.`);
  } catch (e) {
    console.error('⚠️ Очистка business_messages_cache не удалась:', e?.message || e);
  }
}

let pruningStarted = false;

function startBusinessCachePruning() {
  if (pruningStarted) return;
  pruningStarted = true;
  const first = trackTimer(setTimeout(() => {
    stateTimers.delete(first);
    pruneBusinessCache();
  }, PRUNE_FIRST_DELAY));
  trackTimer(setInterval(pruneBusinessCache, PRUNE_INTERVAL));
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

// Загружает персистентное состояние бота (global_stop, активные chat_rules) из БД. Вызывается при старте.
// Никогда не reject'ится; business_message дожидается её, чтобы не ответить до загрузки global_stop.
// Также запускает фоновую очистку business_messages_cache (раз в 6 часов, unref).
export function loadBotState({ pruning = true } = {}) {
  if (pruning) startBusinessCachePruning();
  botStateReady = (async () => {
    const stopTask = (async () => {
      try {
        globalStop = (await db.getBotState('global_stop')) === 'true';
        if (globalStop) console.warn('🛑 global_stop = true (загружено из БД): автоответчик остановлен для всех.');
      } catch (e) {
        console.error('⚠️ Не удалось загрузить bot_state из БД:', e?.message || e);
      }
    })();
    await Promise.all([stopTask, loadChatRules()]);
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

// --- Счётчик пользователей (меню / экран подписки) ---
// Кэш в памяти на 5 минут: COUNT(*) не дёргается на каждый /start. Ошибка БД не роняет рендер.
export const USERS_COUNT_TTL = 5 * 60 * 1000;
let usersCount = null;
let usersCountAt = 0;
let usersCountPromise = null;

export async function getUsersCountCached({ force = false } = {}) {
  if (!force && usersCount !== null && Date.now() - usersCountAt < USERS_COUNT_TTL) return usersCount;
  if (!usersCountPromise) {
    usersCountPromise = (async () => {
      try {
        const n = Number(await db.getUsersCount());
        if (Number.isFinite(n)) {
          usersCount = n;
          usersCountAt = Date.now();
        }
      } catch (e) {
        // последнее известное значение (или null)
      }
      return usersCount;
    })().finally(() => { usersCountPromise = null; });
  }
  return usersCountPromise;
}

export function clearUsersCountCache() {
  usersCount = null;
  usersCountAt = 0;
  usersCountPromise = null;
}
