// Фасад db: объединяет репозитории и оборачивает методы в withRetry.
import { withRetry, closeDb, sql } from './client.js';
import { usersRepo, DEFAULT_USER_SETTINGS } from './usersRepo.js';
import { stateRepo } from './stateRepo.js';
import { channelRepo } from './channelRepo.js';
import { businessRepo } from './businessRepo.js';

// Не повторяем: лог ошибок и кэш бизнес-сообщений/очистка (best-effort),
// INSERT черновика и атомарный захват черновика, инкремент квоты ИИ (повтор = двойное списание).
export const NO_RETRY = new Set([
  'saveErrorLog', 'createPostDraft', 'claimDraftForPublishing',
  'saveCachedBusinessMessage', 'pruneOldBusinessMessages', 'incrementAiUsage'
]);

const rawDb = { ...usersRepo, ...stateRepo, ...channelRepo, ...businessRepo };

export const db = Object.fromEntries(
  Object.entries(rawDb).map(([name, fn]) => [
    name,
    NO_RETRY.has(name) ? fn : (...args) => withRetry(fn, args)
  ])
);

export { DEFAULT_USER_SETTINGS, closeDb, sql };
