// RP-команды: управление кастомными (.addrp/.myrp/.delrp) и выполнение RP (кастомные -> встроенные).
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { formatSenderName } from '../services/dotUtils.js';
import {
  BUILTIN_RP,
  MAX_CUSTOM_RP,
  MAX_RP_ACTION,
  CUSTOM_RP_EMOJI,
  getBuiltinRp,
  normalizeRpTrigger,
  formatRpMessage
} from '../services/rp.js';
import { getOwnerCustomRp, invalidateOwnerCustomRp } from '../bot/state.js';
import { notifyOwner, deleteTrigger, errText } from './dotShared.js';

export const RP_MANAGE_COMMANDS = Object.freeze(new Set(['addrp', 'myrp', 'delrp']));

const ADDRP_HINT =
  '⚠️ Формат: <code>.addrp .триггер текст действия</code>\n' +
  'Например: <code>.addrp .обнимашки крепко обнял(а)</code>\n' +
  'Триггер: 2–30 символов (буквы, цифры, _), начинается с буквы.\n' +
  'Чтобы привязать GIF или стикер — отправьте команду ответом на него.';

function mediaFromReply(reply) {
  if (reply?.animation?.file_id) return { mediaFileId: reply.animation.file_id, mediaType: 'animation' };
  if (reply?.sticker?.file_id) return { mediaFileId: reply.sticker.file_id, mediaType: 'sticker' };
  return { mediaFileId: null, mediaType: null };
}

const mediaLabel = (type) => (type === 'animation' ? ' + GIF' : type === 'sticker' ? ' + стикер' : '');

export const rpHandlers = {
  async addrp(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    const [rawTrigger = ''] = c.args.split(/\s+/);
    const actionText = c.args.slice(rawTrigger.length).trim();
    const trigger = rawTrigger.startsWith('.') ? normalizeRpTrigger(rawTrigger) : null;
    if (!trigger || !actionText) {
      await notifyOwner(ctx.api, c.ownerId, ADDRP_HINT);
      return;
    }
    if (actionText.length > MAX_RP_ACTION) {
      await notifyOwner(ctx.api, c.ownerId, `⚠️ Текст действия — от 1 до ${MAX_RP_ACTION} символов.`);
      return;
    }
    if (c.isReserved?.(trigger)) {
      await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.${escapeHTML(trigger)}</code> — системная команда, её нельзя переопределить.`);
      return;
    }
    const { mediaFileId, mediaType } = mediaFromReply(c.businessMessage.reply_to_message);
    try {
      const list = await db.listCustomRp(c.ownerId);
      const exists = list.some((r) => r.trigger === trigger);
      if (!exists && list.length >= MAX_CUSTOM_RP) {
        await notifyOwner(
          ctx.api,
          c.ownerId,
          `⚠️ Занято ${list.length}/${MAX_CUSTOM_RP} слотов кастомных RP. Удалите лишнюю: <code>.delrp .триггер</code> (список — <code>.myrp</code>).`
        );
        return;
      }
      await db.upsertCustomRp(c.ownerId, { trigger, actionText, mediaFileId, mediaType });
      invalidateOwnerCustomRp(c.ownerId);
      const used = exists ? list.length : list.length + 1;
      await notifyOwner(
        ctx.api,
        c.ownerId,
        `${exists ? '✏️ RP обновлена' : '✅ RP добавлена'}: <code>.${escapeHTML(trigger)}</code> — ${escapeHTML(actionText)}${mediaLabel(mediaType)}\nСлоты: ${used}/${MAX_CUSTOM_RP}`
      );
    } catch (e) {
      await notifyOwner(ctx.api, c.ownerId, '⚠️ <code>.addrp</code>: база данных недоступна, попробуйте позже.');
    }
  },

  async myrp(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    let list;
    try {
      list = await db.listCustomRp(c.ownerId);
    } catch (e) {
      await notifyOwner(ctx.api, c.ownerId, '⚠️ <code>.myrp</code>: база данных недоступна, попробуйте позже.');
      return;
    }
    const lines = [`🎭 <b>Ваши RP-команды</b> (${list.length}/${MAX_CUSTOM_RP})`];
    if (!list.length) lines.push('Пока пусто. Добавить: <code>.addrp .триггер текст действия</code>');
    for (const r of list) {
      lines.push(`<code>.${escapeHTML(r.trigger)}</code> — ${escapeHTML(r.action_text)}${mediaLabel(r.media_type)}`);
    }
    lines.push('', `Встроенные: ${Object.keys(BUILTIN_RP).map((t) => `.${t}`).join(' ')}`);
    await notifyOwner(ctx.api, c.ownerId, lines.join('\n'));
  },

  async delrp(ctx, c) {
    await deleteTrigger(ctx.api, c.connectionId, c.messageId);
    const trigger = normalizeRpTrigger(c.args.split(/\s+/)[0] || '');
    if (!trigger) {
      await notifyOwner(ctx.api, c.ownerId, '⚠️ Формат: <code>.delrp .триггер</code>');
      return;
    }
    let removed;
    try {
      removed = await db.deleteCustomRp(c.ownerId, trigger);
    } catch (e) {
      await notifyOwner(ctx.api, c.ownerId, '⚠️ <code>.delrp</code>: база данных недоступна, попробуйте позже.');
      return;
    }
    invalidateOwnerCustomRp(c.ownerId);
    await notifyOwner(
      ctx.api,
      c.ownerId,
      removed ? `🗑 RP <code>.${escapeHTML(trigger)}</code> удалена.` : `⚠️ RP <code>.${escapeHTML(trigger)}</code> не найдена (список — <code>.myrp</code>).`
    );
  }
};

// Ищет RP по триггеру: кастомные владельца -> встроенные. null — не RP.
export async function findRp(ownerId, trigger) {
  let custom = null;
  try {
    custom = (await getOwnerCustomRp(ownerId)).get(trigger) || null;
  } catch (e) {} // БД недоступна — работают встроенные
  if (custom) {
    return {
      emoji: CUSTOM_RP_EMOJI,
      actionText: custom.action_text,
      mediaFileId: custom.media_file_id || null,
      mediaType: custom.media_type || null
    };
  }
  const builtin = getBuiltinRp(trigger);
  return builtin ? { emoji: builtin.emoji, actionText: builtin.verb, mediaFileId: null, mediaType: null } : null;
}

// Выполняет RP. true — команда распознана как RP и обработана.
export async function executeRp(ctx, c) {
  const rp = await findRp(c.ownerId, c.command);
  if (!rp) return false;
  await deleteTrigger(ctx.api, c.connectionId, c.messageId);

  const reply = c.businessMessage.reply_to_message;
  const html = formatRpMessage({
    emoji: rp.emoji,
    actorName: formatSenderName(c.businessMessage.from),
    targetName: formatSenderName(reply?.from || c.chat),
    actionText: rp.actionText,
    comment: c.args
  });
  const opts = { business_connection_id: c.connectionId };
  try {
    if (rp.mediaType === 'animation' && rp.mediaFileId) {
      await ctx.api.sendAnimation(c.chatId, rp.mediaFileId, { ...opts, caption: html, parse_mode: 'HTML' });
    } else if (rp.mediaType === 'sticker' && rp.mediaFileId) {
      await ctx.api.sendSticker(c.chatId, rp.mediaFileId, opts);
      await ctx.api.sendMessage(c.chatId, html, { ...opts, parse_mode: 'HTML' });
    } else {
      await ctx.api.sendMessage(c.chatId, html, { ...opts, parse_mode: 'HTML' });
    }
  } catch (e) {
    await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.${escapeHTML(c.command)}</code>: не удалось отправить RP (${escapeHTML(errText(e))}).`);
  }
  return true;
}
