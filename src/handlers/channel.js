// ===== СБОР КОММЕНТАРИЕВ ИЗ ГРУППЫ ОБСУЖДЕНИЙ (Фаза 2) =====
// Регистрируется ДО команд: сообщения из группы обсуждений дальше не передаются,
// поэтому бот никогда не отвечает в группе (кроме /chatid от админа).
import { config, isAdmin } from '../config.js';
import { db } from '../db/index.js';
import { extractChannelComment } from '../services/comments.js';

export function registerChannelHandlers(bot) {
  const groupId = config.discussionGroupId;

  bot.on('message', async (ctx, next) => {
    if (!groupId || String(ctx.chat?.id) !== groupId) return next();
    if (ctx.hasCommand('chatid') && isAdmin(ctx.from?.id)) return next();

    const comment = extractChannelComment(ctx.message, groupId);
    if (!comment) return;
    try {
      await db.saveChannelComment(comment);
    } catch (e) {
      console.error('❌ saveChannelComment error:', e?.message || e);
    }
  });
}
