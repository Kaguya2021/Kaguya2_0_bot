// Пакетное удаление бизнес-сообщений (защита от 429) и учёт "удалено самим ботом"
// (чтобы анти-удаление не слало владельцу ложные алерты на его же .команды).
import { BoundedCache } from './cache.js';

export const DELETE_CHUNK_SIZE = 100;          // лимит deleteBusinessMessages за один вызов
export const DEFAULT_DELETE_DELAY_MS = 250;
export const BOT_DELETED_TTL_MS = 60 * 1000;

// `${connectionId}:${messageId}` -> true. Без фонового таймера: TTL ленивый + лимит размера.
const botDeletedIds = new BoundedCache({ maxSize: 5000, ttlMs: BOT_DELETED_TTL_MS });

const key = (connectionId, messageId) => `${connectionId}:${Number(messageId)}`;

export function markBotDeleted(connectionId, messageIds) {
  for (const id of toIdList(messageIds)) botDeletedIds.set(key(connectionId, id), true);
}

export function isBotDeleted(connectionId, messageId) {
  return botDeletedIds.has(key(connectionId, messageId));
}

function toIdList(messageIds) {
  const list = Array.isArray(messageIds) ? messageIds : [messageIds];
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

function chunk(list, size = DELETE_CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Немедленное удаление чанками по 100. Бросает первую ошибку (после попытки всех чанков).
export async function deleteBusinessNow(api, connectionId, messageIds) {
  const ids = toIdList(messageIds);
  if (!ids.length) return 0;
  markBotDeleted(connectionId, ids);
  let firstError = null;
  let deleted = 0;
  for (const part of chunk(ids)) {
    try {
      await api.deleteBusinessMessages(connectionId, part);
      deleted += part.length;
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError) throw firstError;
  return deleted;
}

// --- Буфер по connectionId ---
// connectionId -> { api, ids:Set, onErrors:Set, timer, done:Promise, resolve }
const queues = new Map();

// Ставит ID в очередь; через delayMs (или сразу при >= 100 ID) — один вызов deleteBusinessMessages.
// onError(err, ids) вызывается при ошибке пачки. Возвращает промис завершения пачки (не reject'ится).
export function queueBusinessDelete(api, connectionId, messageIds, onError, delayMs = DEFAULT_DELETE_DELAY_MS) {
  const ids = toIdList(messageIds);
  if (!ids.length) return Promise.resolve();
  // Помечаем сразу: deleted_business_messages может прийти раньше, чем завершится вызов.
  markBotDeleted(connectionId, ids);

  let q = queues.get(connectionId);
  if (!q) {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    q = { api, ids: new Set(), onErrors: new Set(), timer: null, done, resolve };
    queues.set(connectionId, q);
  }
  for (const id of ids) q.ids.add(id);
  if (typeof onError === 'function') q.onErrors.add(onError);

  if (q.ids.size >= DELETE_CHUNK_SIZE) {
    flushQueue(connectionId);
  } else if (!q.timer) {
    q.timer = setTimeout(() => flushQueue(connectionId), delayMs);
  }
  return q.done;
}

// Немедленно отправляет буфер подключения. Возвращает промис завершения.
export async function flushQueue(connectionId) {
  const q = queues.get(connectionId);
  if (!q) return;
  queues.delete(connectionId);
  if (q.timer) clearTimeout(q.timer);
  q.timer = null;
  try {
    for (const part of chunk([...q.ids])) {
      try {
        await q.api.deleteBusinessMessages(connectionId, part);
      } catch (err) {
        for (const fn of q.onErrors) {
          try { fn(err, part); } catch (e) {}
        }
      }
    }
  } finally {
    q.resolve();
  }
}

// Отменяет все отложенные пачки (остановка процесса/тесты) и очищает пометки.
export function stopDeleteQueue() {
  for (const q of queues.values()) {
    if (q.timer) clearTimeout(q.timer);
    q.resolve();
  }
  queues.clear();
  botDeletedIds.clear();
}

// Для тестов/диагностики.
export function pendingDeleteCount(connectionId) {
  return queues.get(connectionId)?.ids.size ?? 0;
}
