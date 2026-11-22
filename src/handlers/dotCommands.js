// Роутер .команд владельца в Telegram Business (сообщения владельца в бизнес-чате).
//
// Business API не даёт боту редактировать сообщения владельца, поэтому:
// - публичные команды (.sw, .calc, .burn): триггер удаляется (best-effort), результат — новым сообщением в чат;
// - приватные (.mute, .unmute, .wsag, .unwsag, .del, .id, .help): триггер удаляется,
//   подтверждение/отчёт — владельцу в личку бота, чтобы не палить команды перед собеседником.
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { switchLayout, parseDurationMs, safeCalc, formatSenderName } from '../services/dotUtils.js';
import { deleteBusinessNow } from '../services/deleteQueue.js';
import { setChatRuleInCache, burnTimers } from '../bot/state.js';

export const DEL_MAX = 50;
export const BURN_LIMITS = Object.freeze({ minMs: 3000, maxMs: 600_000 });

export const RIGHTS_HINT =
  'Включите право <b>«Удаление всех сообщений»</b>:\n' +
  '<i>Настройки → Telegram Business → Чат-боты → @Kaguya_2_0bot</i>';

export const HELP_TEXT =
  '📖 <b>.команды</b> (пишите в любом бизнес-чате, триггер удаляется)\n\n' +
  '<b>Модерация</b> (отчёт — сюда, в личку):\n' +
  '<code>.mute</code> / <code>.unmute</code> — удалять все сообщения собеседника\n' +
  '<code>.wsag</code> / <code>.unwsag</code> — удалять его стикеры и GIF\n' +
  '<code>.del</code> — удалить отвеченное сообщение (reply) или последнее\n' +
  '<code>.del N</code> — удалить последние N сообщений (1–50)\n' +
  '<code>.id</code> — ID чата, собеседника и сообщений\n\n' +
  '<b>В чат</b>:\n' +
  '<code>.sw текст</code> — сменить раскладку (или reply на сообщение)\n' +
  '<code>.calc 2*(3+4)</code> — калькулятор\n' +
  '<code>.burn 30s текст</code> — сообщение, которое удалится само (3с–10м)\n\n' +
  '<code>.help</code> — эта шпаргалка';

const COMMANDS = new Set(['mute', 'unmute', 'wsag', 'unwsag', 'del', 'burn', 'sw', 'calc', 'id', 'help']);

export function isKnownDotCommand(command) {
  return COMMANDS.has(command);
}

// Сообщение владельцу в личку бота (не бросает).
export async function notifyOwner(api, ownerId, html) {
  try {
    await api.sendMessage(ownerId, html, { parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (e) {
    return false;
  }
}

async function deleteTrigger(api, connectionId, messageId) {
  try {
    await deleteBusinessNow(api, connectionId, [messageId]);
    return true;
  } catch (e) {
    return false;
  }
}

function chatTitle(chat) {
  if (!chat) return 'чат';
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '';
  const user = chat.username ? ` (@${chat.username})` : '';
  return `${name || `ID ${chat.id}`}${user}`;
}

function formatNumber(n) {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

// --- Правила чата ---

async function applyRule(ctx, c, patch, { onText, rightsSensitive }) {
  await deleteTrigger(ctx.api, c.connectionId, c.messageId);
  try {
    const saved = await db.setChatRule(c.ownerId, c.chatId, patch);
    setChatRuleInCache(c.ownerId, c.chatId, saved || patch);
  } catch (e) {
    await notifyOwner(ctx.api, c.ownerId, '⚠️ Не удалось сохранить правило (база данных недоступна). Попробуйте ещё раз через минуту.');
    return;
  }
  const title = `<b>${escapeHTML(chatTitle(c.chat))}</b>`;
  if (rightsSensitive && c.meta?.canDeleteAll === false) {
    await notifyOwner(
      ctx.api,
      c.ownerId,
      `${onText(title)}\n\n⚠️ Но у бота нет права удалять сообщения собеседника — правило не сработает.\n${RIGHTS_HINT}`
    );
    return;
  }
  await notifyOwner(ctx.api, c.ownerId, onText(title));
}

const handlers = {
  mute: (ctx, c) => applyRule(ctx, c, { isMuted: true }, {
    rightsSensitive: true,
    onText: (t) => `🔇 Мут включён для диалога ${t}. Его новые сообщения будут удаляться, автоответ ему не отправляется.\nСнять: <code>.unmute</code>`
  }),

  unmute: (ctx, c) => applyRule(ctx, c, { isMuted: false }, {
    rightsSensitive: false,
    onText: (t) => `🔊 Мут снят для диалога ${t}.`
  }),

  wsag: (ctx, c) => applyRule(ctx, c, { deleteStickersGifs: true }, {
    rightsSensitive: true,
    onText: (t) => `🧹 Автоудаление стикеров и GIF включено для диалога ${t}.\nВыключить: <code>.unwsag</code>`
  }),

  unwsag: (ctx, c) => applyRule(ctx, c, { deleteStickersGifs: false }, {
    rightsSensitive: false,
    onText: (t) => `🖼 Автоудаление стикеров и GIF выключено для диалога ${t}.`
  }),

  async del(ctx, c) {
    const reply = c.businessMessage.reply_to_message;
    let targets = [];

    if (!c.args && reply?.message_id) {
      targets = [reply.message_id];
    } else {
      const n = c.args ? Number(c.args) : 1;
      if (!Number.isInteger(n) || n < 1 || n > DEL_MAX) {
        await deleteTrigger(ctx.api, c.connectionId, c.messageId);
        await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.del N</code>: N — целое число от 1 до ${DEL_MAX}.`);
        return;
      }
      try {
        targets = await db.getRecentCachedMessageIds(c.connectionId, c.chatId, n, {
          beforeMessageId: c.messageId,
          // Без права "удалять все" можно удалить только свои сообщения.
          senderId: c.meta?.canDeleteAll === false ? c.ownerId : null
        });
      } catch (e) {
        await deleteTrigger(ctx.api, c.connectionId, c.messageId);
        await notifyOwner(ctx.api, c.ownerId, '⚠️ <code>.del</code>: база данных недоступна, попробуйте позже.');
        return;
      }
    }

    try {
      await deleteBusinessNow(ctx.api, c.connectionId, [...targets, c.messageId]);
      await notifyOwner(ctx.api, c.ownerId, `🗑 Удалено сообщений: <b>${targets.length}</b> в диалоге <b>${escapeHTML(chatTitle(c.chat))}</b>.`);
    } catch (e) {
      const hint = c.meta?.canDeleteAll === false ? `\n${RIGHTS_HINT}` : '';
      await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.del</code>: не удалось удалить сообщения (${escapeHTML(e?.description || e?.message || 'ошибка')}).${hint}`);
    }
  },

  async burn(ctx, c) {
    const [token, ...rest] = c.args.split(/\s+/);
    const text = c.args.slice((token || '').length).trim();
    const ms = parseDurationMs(token || '', BURN_LIMITS);
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    if (!ms || !text || !rest.length) {
      await notifyOwner(ctx.api, c.ownerId, '⚠️ Формат: <code>.burn 30s текст</code> (время 3с–10м: <code>30s</code>, <code>2m</code>, <code>30с</code>, <code>5м</code>).');
      return;
    }
    let sent;
    try {
      sent = await ctx.api.sendMessage(c.chatId, text, { business_connection_id: c.connectionId });
    } catch (e) {
      await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.burn</code>: не удалось отправить сообщение (${escapeHTML(e?.description || e?.message || 'ошибка')}).`);
      return;
    }
    const timer = setTimeout(() => {
      burnTimers.delete(timer);
      deleteBusinessNow(ctx.api, c.connectionId, [sent.message_id]).catch(() => {});
    }, ms);
    timer.unref?.();
    burnTimers.add(timer);
  },

  async sw(ctx, c) {
    const reply = c.businessMessage.reply_to_message;
    const source = c.args || reply?.text || reply?.caption || '';
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    if (!source.trim()) {
      await notifyOwner(ctx.api, c.ownerId, '⚠️ Формат: <code>.sw текст</code> или ответьте <code>.sw</code> на сообщение.');
      return;
    }
    try {
      await ctx.api.sendMessage(c.chatId, switchLayout(source), { business_connection_id: c.connectionId });
    } catch (e) {
      await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.sw</code>: не удалось отправить (${escapeHTML(e?.description || e?.message || 'ошибка')}).`);
    }
  },

  async calc(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    let result;
    try {
      result = safeCalc(c.args);
    } catch (e) {
      await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.calc</code>: ${escapeHTML(e?.message || 'ошибка')}.`);
      return;
    }
    try {
      await ctx.api.sendMessage(c.chatId, `${c.args} = ${formatNumber(result)}`, { business_connection_id: c.connectionId });
    } catch (e) {
      await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.calc</code>: не удалось отправить (${escapeHTML(e?.description || e?.message || 'ошибка')}).`);
    }
  },

  async id(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    const chat = c.chat || {};
    const reply = c.businessMessage.reply_to_message;
    const lines = [
      '🆔 <b>ID</b>',
      `Диалог: <b>${escapeHTML(chatTitle(chat))}</b>`,
      `chat_id: <code>${escapeHTML(c.chatId)}</code>`,
      `message_id (.id): <code>${c.messageId}</code>`
    ];
    if (reply) {
      lines.push(`reply message_id: <code>${reply.message_id}</code>`);
      if (reply.from) lines.push(`reply user_id: <code>${reply.from.id}</code> (${escapeHTML(formatSenderName(reply.from))})`);
    }
    lines.push(`connection_id: <code>${escapeHTML(c.connectionId)}</code>`);
    await notifyOwner(ctx.api, c.ownerId, lines.join('\n'));
  },

  async help(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    await notifyOwner(ctx.api, c.ownerId, HELP_TEXT);
  }
};

// Возвращает true, если команда распознана и обработана (дальнейшая логика не нужна).
// Неизвестная .команда -> false: сообщение не трогаем, срабатывает обычная пауза автоответа.
export async function handleDotCommand(ctx, { parsed, businessMessage, connectionId, chatId, ownerId, meta }) {
  if (!parsed || !isKnownDotCommand(parsed.command)) return false;
  const c = {
    command: parsed.command,
    args: parsed.args || '',
    businessMessage,
    chat: businessMessage.chat,
    connectionId,
    chatId: String(chatId),
    ownerId: String(ownerId),
    messageId: businessMessage.message_id,
    meta: meta || null
  };
  try {
    await handlers[parsed.command](ctx, c);
  } catch (e) {
    console.error(`❌ .${parsed.command} error:`, e?.description || e?.message || e);
  }
  return true;
}
