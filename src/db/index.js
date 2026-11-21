// Фасад db: объединяет репозитории и оборачивает методы в withRetry.
import { withRetry, closeDb, sql } from './client.js';
import { usersRepo, DEFAULT_USER_SETTINGS } from './usersRepo.js';
import { stateRepo } from './stateRepo.js';
import { channelRepo } from './channelRepo.js';

// Не повторяем: лог ошибок (best-effort), INSERT черновика и атомарный захват черновика.
export const NO_RETRY = new Set(['saveErrorLog', 'createPostDraft', 'claimDraftForPublishing']);

const rawDb = { ...usersRepo, ...stateRepo, ...channelRepo };

export const db = Object.fromEntries(
  Object.entries(rawDb).map(([name, fn]) => [
    name,
    NO_RETRY.has(name) ? fn : (...args) => withRetry(fn, args)
  ])
);

export { DEFAULT_USER_SETTINGS, closeDb, sql };
