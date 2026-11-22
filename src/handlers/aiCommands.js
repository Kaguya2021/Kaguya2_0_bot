// ИИ-команды владельца (Gemini): .ai, .autoai/.unautoai, .dialog, .kawaii/.unkawaii
// и фоновые раннеры для business.js (.kawaii — переписать сообщение владельца, .autoai — ответ собеседнику).
//
// Защита от циклов: .kawaii не трогает эхо бота (sender_business_bot), .команды, пустые и >500 символов;
// .autoai — кулдаун 5 с на (ownerId, chatId), сообщения ботов отсекаются раньше (from.is_bot).
// Ошибки Gemini в .kawaii/.autoai собеседнику не показываются.
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { BoundedCache } from '../services/cache.js';
import { deleteBusinessNow } from '../services/deleteQueue.js';
import {
  isGeminiConfigured,
  generateGeminiText,
  consumeAiQuota,
  runAiTask,
  buildAiPrompt,
  buildDialogAnalysisPrompt,
  buildAutoAiPrompt,
  buildKawaiiPrompt
} from '../services/gemini.js';
import { setChatRuleInCache } from '../bot/state.js';
import { notifyOwner, deleteTrigger, chatTitle, errText } from './dotShared.js';

export const AI_COMMANDS = Object.freeze(new Set(['ai', 'autoai', 'unautoai', 'dialog', 'kawaii', 'unkawaii']));
export const DIALOG_LIMITS = Object.freeze({ min: 5, max: 50, def: 20 });
export const KAWAII_MAX_LENGTH = 500;
export const AUTO_AI_COOLDOWN_MS = 5000;
export const AUTO_AI_HISTORY = 10;
const AI_LIMIT_ALERT_TTL = 60 * 60 * 1000;
const MAX_DM_LENGTH = 3900;

// `autoai:${ownerId}:${chatId}` -> true (TTL 5 с, без фонового таймера).
const autoAiCooldowns = new BoundedCache({ maxSize: 10000, ttlMs: AUTO_AI_COOLDOWN_MS });
// ownerId -> true: алерт «лимит ИИ исчерпан» не чаще раза в час.
const aiLimitAlertSent = new BoundedCache({ maxSize: 5000, ttlMs: AI_LIMIT_ALERT_TTL });

export function clearAutoAiCooldowns() {
  autoAiCooldowns.clear();
}

export function clearAiState() {
  autoAiCooldowns.clear();
  aiLimitAlertSent.clear();
}

export const NOT_CONFIGURED_TEXT =
  '🤖 ИИ пока не настроен: администратор бота не задал <code>GEMINI_API_KEY</code>. Команда не выполнена.';

export function limitText(quota) {
  return `⏳ Дневной лимит ИИ исчерпан: <b>${quota.used}/${quota.limit}</b>. Сброс в 00:00 UTC.`;
}

// Экранированный HTML, укладывающийся в лимит сообщения Telegram.
function fitHtml(prefix, text) {
  let raw = String(text ?? '');
  let html = prefix + escapeHTML(raw);
  while (html.length > MAX_DM_LENGTH && raw.length > 0) {
    raw = raw.slice(0, Math.max(0, raw.length - 200));
    html = `${prefix}${escapeHTML(raw)}…`;
  }
  return html;
}

// Квота с обработкой ошибок для команд владельца. true — можно звать Gemini.
async function ensureAiAllowed(ctx, c, label) {
  if (!isGeminiConfigured()) {
    await notifyOwner(ctx.api, c.ownerId, NOT_CONFIGURED_TEXT);
    return false;
  }
  let quota;
  try {
    quota = await consumeAiQuota(c.ownerId);
  } catch (e) {
    await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.${label}</code>: база данных недоступна, попробуйте позже.`);
    return false;
  }
  if (!quota.allowed) {
    await notifyOwner(ctx.api, c.ownerId, limitText(quota));
    return false;
  }
  return true;
}

// Тихая проверка для фоновых .kawaii/.autoai: при лимите — алерт владельцу раз в час.
async function silentAiAllowed(api, ownerId) {
  if (!isGeminiConfigured()) return false;
  let quota;
  try {
    quota = await consumeAiQuota(ownerId);
  } catch (e) {
    return false;
  }
  if (quota.allowed) return true;
  if (!aiLimitAlertSent.has(ownerId)) {
    aiLimitAlertSent.set(ownerId, true);
    await notifyOwner(api, ownerId, `${limitText(quota)}\n<code>.autoai</code> и <code>.kawaii</code> приостановлены до сброса.`);
  }
  return false;
}

async function saveRule(ctx, c, patch) {
  try {
    const saved = await db.setChatRule(c.ownerId, c.chatId, patch);
    setChatRuleInCache(c.ownerId, c.chatId, { ...patch, ...(saved || {}) });
    return true;
  } catch (e) {
    await notifyOwner(ctx.api, c.ownerId, '⚠️ Не удалось сохранить правило (база данных недоступна). Попробуйте ещё раз через минуту.');
    return false;
  }
}

const dialogTitle = (c) => `<b>${escapeHTML(chatTitle(c.chat))}</b>`;
const notConfiguredNote = () => (isGeminiConfigured() ? '' : `\n\n${NOT_CONFIGURED_TEXT}`);

export const aiHandlers = {
  async ai(ctx, c) {
    const reply = c.businessMessage.reply_to_message;
    const replyText = reply?.text || reply?.caption || '';
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    if (!c.args && !replyText.trim()) {
      await notifyOwner(ctx.api, c.ownerId, '⚠️ Формат: <code>.ai вопрос</code> или ответьте <code>.ai</code> на сообщение.');
      return;
    }
    if (!(await ensureAiAllowed(ctx, c, 'ai'))) return;
    runAiTask(async () => {
      let answer;
      try {
        answer = await generateGeminiText(buildAiPrompt(c.args, replyText));
      } catch (e) {
        await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.ai</code>: ${escapeHTML(errText(e))}. Попробуйте позже.`);
        return;
      }
      try {
        // Plain text: ответ модели может содержать символы, ломающие HTML/Markdown.
        await ctx.api.sendMessage(c.chatId, answer, { business_connection_id: c.connectionId });
      } catch (e) {
        await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.ai</code>: не удалось отправить ответ (${escapeHTML(errText(e))}).`);
      }
    });
  },

  async autoai(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    const instruction = c.args.trim();
    if (!instruction) {
      await notifyOwner(
        ctx.api,
        c.ownerId,
        '⚠️ Формат: <code>.autoai инструкция</code>\nНапример: <code>.autoai отвечай вежливо, что я на встрече и перезвоню вечером</code>\nВыключить: <code>.unautoai</code>'
      );
      return;
    }
    if (!(await saveRule(ctx, c, { autoAiPrompt: instruction }))) return;
    await notifyOwner(
      ctx.api,
      c.ownerId,
      `🤖 ИИ-автоответ включён для диалога ${dialogTitle(c)}.\nИнструкция: <i>${escapeHTML(instruction.slice(0, 500))}</i>\nВыключить: <code>.unautoai</code>${notConfiguredNote()}`
    );
  },

  async unautoai(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    if (!(await saveRule(ctx, c, { autoAiPrompt: null }))) return;
    await notifyOwner(ctx.api, c.ownerId, `🤖 ИИ-автоответ выключен для диалога ${dialogTitle(c)}.`);
  },

  async dialog(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    const n = c.args ? Number(c.args) : DIALOG_LIMITS.def;
    if (!Number.isInteger(n) || n < DIALOG_LIMITS.min || n > DIALOG_LIMITS.max) {
      await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.dialog N</code>: N — целое число от ${DIALOG_LIMITS.min} до ${DIALOG_LIMITS.max} (по умолчанию ${DIALOG_LIMITS.def}).`);
      return;
    }
    let messages;
    try {
      messages = await db.getRecentCachedMessages(c.connectionId, c.chatId, n);
    } catch (e) {
      await notifyOwner(ctx.api, c.ownerId, '⚠️ <code>.dialog</code>: база данных недоступна, попробуйте позже.');
      return;
    }
    if (!messages || messages.length < 2) {
      await notifyOwner(ctx.api, c.ownerId, '💬 <code>.dialog</code>: в этом диалоге слишком мало сохранённых сообщений для разбора (нужно минимум 2).');
      return;
    }
    if (!(await ensureAiAllowed(ctx, c, 'dialog'))) return;
    runAiTask(async () => {
      let analysis;
      try {
        analysis = await generateGeminiText(buildDialogAnalysisPrompt(messages, c.ownerId));
      } catch (e) {
        await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.dialog</code>: ${escapeHTML(errText(e))}. Попробуйте позже.`);
        return;
      }
      const prefix = `🧠 <b>Разбор диалога</b> ${dialogTitle(c)} (сообщений: ${messages.length})\n\n`;
      await notifyOwner(ctx.api, c.ownerId, fitHtml(prefix, analysis));
    });
  },

  async kawaii(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    if (!(await saveRule(ctx, c, { kawaiiEnabled: true }))) return;
    let text = `🌸 Kawaii-режим включён для диалога ${dialogTitle(c)}: ваши сообщения будут переписываться в аниме-стиле (◕‿◕✿)\nВыключить: <code>.unkawaii</code>`;
    if (c.meta && !c.meta.canDeleteSent && !c.meta.canDeleteAll) {
      text += '\n\n⚠️ У бота нет права <b>«Удаление отправленных сообщений»</b> — исходник не будет удаляться, и в чате окажутся оба варианта.\n<i>Настройки → Telegram Business → Чат-боты → @Kaguya_2_0bot</i>';
    }
    await notifyOwner(ctx.api, c.ownerId, text + notConfiguredNote());
  },

  async unkawaii(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    if (!(await saveRule(ctx, c, { kawaiiEnabled: false }))) return;
    await notifyOwner(ctx.api, c.ownerId, `🌸 Kawaii-режим выключен для диалога ${dialogTitle(c)}.`);
  }
};

// --- Фоновые раннеры для business.js ---

// Подходит ли сообщение владельца под .kawaii (без побочных эффектов).
export function isKawaiiCandidate(businessMessage) {
  if (!businessMessage || businessMessage.sender_business_bot) return false;
  const text = businessMessage.text;
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || text.length > KAWAII_MAX_LENGTH) return false;
  return !trimmed.startsWith('.');
}

// .kawaii: переписать сообщение владельца. Любая ошибка — исходник остаётся как есть.
export function runKawaii(api, { businessMessage, connectionId, chatId, ownerId }) {
  if (!isKawaiiCandidate(businessMessage)) return null;
  return runAiTask(async () => {
    if (!(await silentAiAllowed(api, ownerId))) return;
    let text;
    try {
      text = await generateGeminiText(buildKawaiiPrompt(businessMessage.text));
    } catch (e) {
      return;
    }
    if (!text?.trim()) return;
    try {
      await deleteBusinessNow(api, connectionId, [businessMessage.message_id]);
    } catch (e) {} // нет прав — отправим переписанный вариант всё равно (владелец предупреждён при .kawaii)
    await api.sendMessage(chatId, text, { business_connection_id: connectionId }).catch(() => {});
  });
}

// .autoai: ответ собеседнику по инструкции владельца. Возвращает true, если правило активно
// (обычный автоответчик в этом чате не срабатывает), даже если ответ пропущен (кулдаун/лимит/ошибка).
export function runAutoAi(api, { businessMessage, connectionId, chatId, ownerId, instruction }) {
  if (!instruction) return false;
  const incoming = businessMessage.text || businessMessage.caption || '';
  if (!incoming.trim()) return true;
  const key = `autoai:${ownerId}:${chatId}`;
  if (autoAiCooldowns.has(key)) return true; // защита от пинг-понга с другим ботом
  autoAiCooldowns.set(key, true);
  runAiTask(async () => {
    if (!(await silentAiAllowed(api, ownerId))) return;
    let history = [];
    try {
      history = (await db.getRecentCachedMessages(connectionId, chatId, AUTO_AI_HISTORY))
        .filter((m) => Number(m.message_id) !== Number(businessMessage.message_id));
    } catch (e) {}
    let answer;
    try {
      answer = await generateGeminiText(buildAutoAiPrompt(instruction, history, incoming, ownerId));
    } catch (e) {
      return;
    }
    if (!answer?.trim()) return;
    await api.sendMessage(chatId, answer, { business_connection_id: connectionId }).catch(() => {});
  });
  return true;
}
