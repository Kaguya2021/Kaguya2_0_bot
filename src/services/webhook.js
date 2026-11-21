import crypto from 'node:crypto';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

// Сравнение строк за постоянное время (с предварительной проверкой длины буферов).
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Express middleware проверки заголовка X-Telegram-Bot-Api-Secret-Token.
// Если secret не задан — пропускает всё (обратная совместимость до добавления переменной в Render).
export function createWebhookSecretMiddleware(secret) {
  return function webhookSecretMiddleware(req, res, next) {
    if (!secret) return next();
    const header = req.get ? req.get(SECRET_HEADER) : req.headers?.[SECRET_HEADER];
    if (!safeEqual(header, secret)) {
      return res.status(401).send('Unauthorized');
    }
    return next();
  };
}
