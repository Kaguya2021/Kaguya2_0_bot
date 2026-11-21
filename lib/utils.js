// Чистые функции без побочных эффектов (импортируются в тестах без запуска сервера/бота).

export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MIN_TZ_OFFSET_MIN = -12 * 60;
export const MAX_TZ_OFFSET_MIN = 14 * 60;

// --- ADMIN_IDS ---

// "1, 2,3" -> ['1','2','3']; пусто/не задано -> null
export function parseAdminIds(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  return ids.length ? ids : null;
}

// --- /time ---

export function isValidTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

// args: массив аргументов после /time. Возвращает { ok, start, end } или { ok:false, error }.
export function validateTimeArgs(args) {
  if (!Array.isArray(args) || args.length !== 2) {
    return { ok: false, error: 'args' };
  }
  const [start, end] = args;
  if (!isValidTime(start) || !isValidTime(end)) {
    return { ok: false, error: 'format' };
  }
  return { ok: true, start, end };
}

// --- /tz ---

// Принимает "+6", "-3", "0", "+3:30", "-9:30", "UTC+3". Возвращает смещение в минутах или null.
export function parseTzOffset(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/^(utc|gmt)/i, '');
  const m = /^([+-])?(\d{1,2})(?::([0-5]\d))?$/.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  const total = sign * (hours * 60 + minutes);
  if (total < MIN_TZ_OFFSET_MIN || total > MAX_TZ_OFFSET_MIN) return null;
  return total === 0 ? 0 : total; // без -0
}

export function formatTzOffset(offsetMin) {
  const off = Number(offsetMin) || 0;
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

// Минуты от начала суток в часовом поясе пользователя.
export function localMinutesOfDay(now, offsetMin) {
  const date = now instanceof Date ? now : new Date(now);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const off = Number(offsetMin) || 0;
  return (((utcMinutes + off) % 1440) + 1440) % 1440;
}

export function formatLocalTime(now, offsetMin) {
  const mins = localMinutesOfDay(now, offsetMin);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// --- Рабочее время ---

// schedule: { start_time, end_time } ("HH:MM"). Нет расписания -> true (круглосуточно).
// Границы включительно (как в прежней реализации). Интервал через полночь (22:00-06:00) поддерживается.
export function isWithinWorkingHours(ownerId, schedule, timezoneOffsetMin = 0, now = new Date()) {
  if (!ownerId) return true;
  if (!schedule || !schedule.start_time || !schedule.end_time) return true;

  const currentMinutes = localMinutesOfDay(now, timezoneOffsetMin);
  const [startH, startM] = String(schedule.start_time).split(':').map(Number);
  const [endH, endM] = String(schedule.end_time).split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

// --- Паузы ---

export function pauseKey(ownerId, chatId) {
  return `${ownerId}:${chatId}`;
}

export function isPauseActive(pauses, ownerId, chatId, now = Date.now()) {
  const until = pauses.get(pauseKey(ownerId, chatId));
  return Boolean(until && until > now);
}

// --- Автоответ вкл/выкл ---

export function isAutoReplyActive(settings, now = Date.now()) {
  const until = Number(settings?.auto_off_until) || 0;
  return !until || now >= until;
}

export function isBlocked(settings, now = Date.now()) {
  const until = Number(settings?.blocked_until) || 0;
  return until > now;
}

// --- Ошибки Telegram ---

export function isIgnorableTelegramError(err) {
  const code = err?.error_code ?? err?.code;
  const description = String(err?.description || err?.message || err || '');
  return (
    code === 403 ||
    description.includes('blocked by the user') ||
    description.includes('user is deactivated') ||
    description.includes('chat not found') ||
    description.includes('bot was kicked')
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
