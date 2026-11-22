// Рассылки с обработкой 429 и классификация "безопасных" ошибок Telegram.

// --- Ошибки Telegram ---

export function isIgnorableTelegramError(err) {
  const code = err?.error_code ?? err?.code;
  const description = String(err?.description || err?.message || err || '');
  return (
    code === 403 ||
    description.includes('blocked by the user') ||
    description.includes('user is deactivated') ||
    description.includes('chat not found') ||
    description.includes('bot was kicked') ||
    // Business: собеседник/подключение недоступны (чат удалён, бот отключён) — шум, не ошибка.
    description.includes('BUSINESS_PEER_INVALID') ||
    description.includes('BUSINESS_CONNECTION_INVALID')
  );
}

// --- Рассылки с обработкой 429 ---

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Выполняет fn; при 429 Too Many Requests ждёт retry_after секунд и повторяет один раз.
export async function callWith429Retry(fn, sleep = defaultSleep) {
  try {
    return await fn();
  } catch (e) {
    const code = e?.error_code ?? e?.code;
    if (code !== 429) throw e;
    const retryAfter = Number(e?.parameters?.retry_after) || 1;
    await sleep(retryAfter * 1000);
    return await fn();
  }
}

// Последовательная рассылка. sendFn(userId) -> Promise. Возвращает { delivered, failed }.
export async function broadcast(userIds, sendFn, { delayMs = 50, sleep = defaultSleep } = {}) {
  let delivered = 0;
  let failed = 0;
  for (const id of userIds) {
    try {
      await callWith429Retry(() => sendFn(id), sleep);
      delivered++;
    } catch (e) {
      failed++;
    }
    if (delayMs) await sleep(delayMs);
  }
  return { delivered, failed };
}
