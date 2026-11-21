// Чистые функции Human-in-the-loop публикации: валидация черновика и сборка клавиатур.
import { InlineKeyboard } from 'grammy';

export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;
export const MEDIA_TYPES = Object.freeze(['photo', 'video']);
export const APPROVE_PREFIX = 'draft_approve:';
export const CANCEL_PREFIX = 'draft_cancel:';

const ALLOWED_URL_RE = /^(https?|tg):\/\/\S+$/i;

export function isAllowedButtonUrl(url) {
  if (typeof url !== 'string' || !ALLOWED_URL_RE.test(url)) return false;
  if (/^tg:/i.test(url)) return true;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

// Длина видимого текста (Telegram считает лимит после разбора HTML-разметки).
export function htmlVisibleLength(html) {
  const text = String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/gi, 'x');
  return [...text].length;
}

// Принимает и camelCase, и snake_case (JSON-файл черновика / строка из БД).
export function normalizeDraft(raw = {}) {
  return {
    htmlText: raw.htmlText ?? raw.html_text ?? raw.text ?? '',
    buttons: raw.buttons ?? raw.buttons_json ?? null,
    mediaType: raw.mediaType ?? raw.media_type ?? null,
    mediaFileId: raw.mediaFileId ?? raw.media_file_id ?? null
  };
}

export function validateButtons(buttons) {
  const errors = [];
  if (buttons === null || buttons === undefined) return errors;
  if (!Array.isArray(buttons)) return ['buttons должен быть массивом рядов: [[{"text","url"}]]'];
  buttons.forEach((row, r) => {
    if (!Array.isArray(row) || !row.length) {
      errors.push(`buttons[${r}] должен быть непустым массивом кнопок`);
      return;
    }
    row.forEach((btn, c) => {
      const where = `buttons[${r}][${c}]`;
      if (!btn || typeof btn !== 'object') return errors.push(`${where}: кнопка должна быть объектом`);
      if (typeof btn.text !== 'string' || !btn.text.trim()) errors.push(`${where}: пустой text`);
      if (!isAllowedButtonUrl(btn.url)) errors.push(`${where}: недопустимый url (разрешены https://, http://, tg://)`);
    });
  });
  return errors;
}

// Возвращает { ok, errors, draft } — draft нормализован (camelCase).
export function validateDraft(raw) {
  const draft = normalizeDraft(raw);
  const errors = [];

  if (typeof draft.htmlText !== 'string' || !draft.htmlText.trim()) {
    errors.push('html_text пустой');
  }

  if (draft.mediaType !== null && draft.mediaType !== undefined && draft.mediaType !== '') {
    if (!MEDIA_TYPES.includes(draft.mediaType)) errors.push(`media_type должен быть одним из: ${MEDIA_TYPES.join(', ')}`);
    if (typeof draft.mediaFileId !== 'string' || !draft.mediaFileId.trim()) errors.push('media_file_id обязателен при media_type');
    else if (/^[a-z]+:/i.test(draft.mediaFileId) && !/^https?:\/\//i.test(draft.mediaFileId)) {
      errors.push('media_file_id: допускается file_id или https URL');
    }
  } else {
    draft.mediaType = null;
    if (draft.mediaFileId) errors.push('media_file_id задан без media_type');
  }

  if (typeof draft.htmlText === 'string' && draft.htmlText.trim()) {
    const limit = draft.mediaType ? MAX_CAPTION_LENGTH : MAX_TEXT_LENGTH;
    const len = htmlVisibleLength(draft.htmlText);
    if (len > limit) errors.push(`текст слишком длинный: ${len} > ${limit}${draft.mediaType ? ' (подпись к медиа)' : ''}`);
  }

  errors.push(...validateButtons(draft.buttons));
  if (Array.isArray(draft.buttons) && !draft.buttons.length) draft.buttons = null;

  return { ok: errors.length === 0, errors, draft };
}

function urlRows(buttons) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map((row) => row.map((b) => InlineKeyboard.url(String(b.text), String(b.url))));
}

// Клавиатура для поста в канале: только URL-кнопки. Нет кнопок — null (пост без reply_markup).
export function buildPostKeyboard(buttons) {
  const rows = urlRows(buttons);
  return rows.length ? new InlineKeyboard(rows) : null;
}

// Клавиатура превью для админа: кнопки поста + последний ряд одобрения/отмены.
export function buildApprovalKeyboard(buttons, draftId) {
  return new InlineKeyboard([
    ...urlRows(buttons),
    [
      InlineKeyboard.text('✅ Опубликовать в канал', `${APPROVE_PREFIX}${draftId}`),
      InlineKeyboard.text('❌ Отмена', `${CANCEL_PREFIX}${draftId}`)
    ]
  ]);
}

// Параметры отправки (общие для превью и канала). Возвращает { method, args }.
export function buildSendPayload(draft, chatId, replyMarkup) {
  const d = normalizeDraft(draft);
  const extra = { parse_mode: 'HTML' };
  if (replyMarkup) extra.reply_markup = replyMarkup;
  if (d.mediaType === 'photo') return { method: 'sendPhoto', args: [chatId, d.mediaFileId, { ...extra, caption: d.htmlText }] };
  if (d.mediaType === 'video') return { method: 'sendVideo', args: [chatId, d.mediaFileId, { ...extra, caption: d.htmlText }] };
  return { method: 'sendMessage', args: [chatId, d.htmlText, extra] };
}
