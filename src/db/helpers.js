// Общие хелперы репозиториев (валидация статусов и нормализация значений).

export const COMMENT_STATUSES = new Set(['new', 'processed', 'ignored']);
export const DRAFT_STATUSES = new Set(['pending_approval', 'publishing', 'published', 'cancelled', 'failed']);

export function assertStatus(allowed, status) {
  if (!allowed.has(status)) throw new Error(`Недопустимый статус: ${status}`);
}

// null — "все"; массив — только валидные положительные целые.
export function normalizeIds(ids) {
  if (!Array.isArray(ids)) return null;
  return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export const cut = (v, max) => (v === null || v === undefined ? null : String(v).slice(0, max));
export const strOrNull = (v) => (v === null || v === undefined ? null : String(v));
export const toNumOrNull = (v) => (v === null || v === undefined ? null : Number(v));
