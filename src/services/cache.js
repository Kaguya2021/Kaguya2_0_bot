// Ограниченный по размеру кэш с TTL (защита от утечки памяти на Render Free, 512 МБ).
// - Хранит значения любого типа, включая null (проверяйте наличие через has()).
// - При превышении maxSize вытесняет самые старые записи (порядок вставки/обновления Map).
// - Протухшие записи удаляются лениво при чтении и периодически через cleanup().

export class BoundedCache {
  constructor({ maxSize = 5000, ttlMs = 0, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxSize) || maxSize < 1) throw new Error('maxSize must be a positive integer');
    this.maxSize = maxSize;
    this.ttlMs = ttlMs; // 0 = без TTL
    this.now = now;
    this.map = new Map();
    this.timer = null;
  }

  _isExpired(entry) {
    return entry.expiresAt !== 0 && entry.expiresAt <= this.now();
  }

  has(key) {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (this._isExpired(entry)) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  get(key) {
    return this.has(key) ? this.map.get(key).value : undefined;
  }

  // ttlMs: индивидуальный TTL записи (по умолчанию — TTL кэша).
  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key); // обновлённая запись становится "свежей"
    const expiresAt = ttlMs > 0 ? this.now() + ttlMs : 0;
    this.map.set(key, { value, expiresAt });
    while (this.map.size > this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
    return this;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  // Удаляет все протухшие записи. Возвращает число удалённых.
  cleanup() {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (this._isExpired(entry)) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // Периодическая очистка; unref(), чтобы таймер не держал процесс (тесты, завершение).
  startCleanup(intervalMs = 5 * 60 * 1000) {
    this.stopCleanup();
    this.timer = setInterval(() => this.cleanup(), intervalMs);
    this.timer.unref?.();
    return this;
  }

  stopCleanup() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// --- Инстансы кэшей бота ---
// Очистка протухших записей каждые 5 минут.
export const CLEANUP_INTERVAL = 5 * 60 * 1000;

// Создаёт набор ограниченных кэшей бота с запущенной периодической очисткой.
export function createBotCaches(intervalMs = CLEANUP_INTERVAL) {
  return {
    // `${connectionId}:${chatId}:${messageId}` -> true (защита от повторной обработки апдейта)
    processedMessages: new BoundedCache({ maxSize: 10000, ttlMs: 30 * 1000 }).startCleanup(intervalMs),
    // ключ `${ownerId}:${chatId}` -> pauseUntil (TTL записи = длительность паузы)
    localPauses: new BoundedCache({ maxSize: 20000 }).startCleanup(intervalMs),
    // userId -> { step, ... } (пошаговая настройка в личке)
    stepState: new BoundedCache({ maxSize: 5000, ttlMs: 60 * 60 * 1000 }).startCleanup(intervalMs),
    // business_connection_id -> ownerId
    connectionOwners: new BoundedCache({ maxSize: 5000, ttlMs: 24 * 60 * 60 * 1000 }).startCleanup(intervalMs),
    // userId -> полный объект настроек (в т.ч. дефолтный, если строки в БД нет)
    userSettingsCache: new BoundedCache({ maxSize: 5000, ttlMs: 30 * 60 * 1000 }).startCleanup(intervalMs)
  };
}

// Останавливает таймеры очистки всех кэшей набора.
export function stopCachesCleanup(caches) {
  for (const cache of Object.values(caches)) cache.stopCleanup();
}
