// RP-команды: встроенные русскоязычные глаголы, нормализация триггеров и форматирование (чистые функции).
import { escapeHTML } from './html.js';

export const MAX_CUSTOM_RP = 3;
export const MAX_RP_ACTION = 200;
export const MAX_RP_COMMENT = 300;
export const CUSTOM_RP_EMOJI = '✨';

export const BUILTIN_RP = Object.freeze({
  обнять: { emoji: '🫂', verb: 'обнял(а)' },
  поцеловать: { emoji: '💋', verb: 'поцеловал(а)' },
  ударить: { emoji: '👊', verb: 'ударил(а)' },
  укусить: { emoji: '😬', verb: 'укусил(а)' },
  кусь: { emoji: '🦷', verb: 'сделал(а) кусь' },
  погладить: { emoji: '🤚', verb: 'погладил(а)' },
  лизнуть: { emoji: '👅', verb: 'лизнул(а)' },
  пнуть: { emoji: '🦶', verb: 'пнул(а)' },
  шлепнуть: { emoji: '🖐', verb: 'шлёпнул(а)' },
  пожать: { emoji: '🤝', verb: 'пожал(а) руку' },
  покормить: { emoji: '🍰', verb: 'покормил(а)' },
  напоить: { emoji: '🍵', verb: 'напоил(а) чаем' },
  укрыть: { emoji: '🛌', verb: 'укрыл(а) пледом' },
  поздравить: { emoji: '🎉', verb: 'поздравил(а)' },
  успокоить: { emoji: '🫶', verb: 'успокоил(а)' },
  испугать: { emoji: '👻', verb: 'испугал(а)' }
});

// Встроенная RP по триггеру (ё == е: «.шлёпнуть» == «.шлепнуть»). null — не найдена.
export function getBuiltinRp(trigger) {
  if (typeof trigger !== 'string') return null;
  const t = trigger.toLowerCase();
  return BUILTIN_RP[t] || BUILTIN_RP[t.replace(/ё/g, 'е')] || null;
}

// Триггер начинается с буквы (иначе parseDotCommand его не распознает): 2–30 символов [a-zа-яё0-9_].
const TRIGGER_RE = /^[a-zа-яё][a-zа-яё0-9_]{1,29}$/;

// ".Обнять" -> "обнять"; невалидный -> null.
export function normalizeRpTrigger(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^\./, '').toLowerCase();
  return TRIGGER_RE.test(t) ? t : null;
}

const clip = (s, max) => {
  const t = String(s ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// -> HTML: «🫂 <b>Эрмек</b> обнял(а) <b>Алихан</b>» (+ «\n💬 <i>«комментарий»</i>»).
export function formatRpMessage({ emoji, actorName, targetName, actionText, comment } = {}) {
  const head = [
    emoji || CUSTOM_RP_EMOJI,
    `<b>${escapeHTML(actorName || 'Кто-то')}</b>`,
    escapeHTML(clip(actionText, MAX_RP_ACTION)),
    `<b>${escapeHTML(targetName || 'собеседника')}</b>`
  ].join(' ');
  const c = clip(comment, MAX_RP_COMMENT);
  return c ? `${head}\n💬 <i>«${escapeHTML(c)}»</i>` : head;
}
