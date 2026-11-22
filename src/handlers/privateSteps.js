// Пошаговая настройка через меню (stepState): текст, стикер, голос, аккаунт, пост админа.
// Только личный чат с ботом — сообщения из групп/каналов и business_message сразу уходят в next().
// Регистрируется ПОСЛЕ команд, чтобы /start, /reset и т.п. не проваливались в stepState.
import { isAdmin } from '../config.js';
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { broadcast } from '../services/broadcast.js';
import { stepState, patchSettings, saveReply } from '../bot/state.js';

export function registerPrivateStepHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    if (ctx.businessMessage || ctx.chat?.type !== 'private') return next();

    const userId = String(ctx.from.id);
    const state = stepState.get(userId);

    if (state && state.step === 'WAITING_ACCOUNT' && ctx.message.text) {
      const raw = ctx.message.text.trim().replace(/^@/, '');
      if (!raw) {
        return await ctx.reply('❌ Отправьте корректный username, например: <code>@kaguya2_0</code>', { parse_mode: 'HTML' });
      }
      const username = raw.toLowerCase();
      try {
        await db.setAllowedUsername(userId, username);
        patchSettings(userId, { allowed_username: username });
      } catch (e) {
        return await ctx.reply('⚠️ Не удалось сохранить (база данных недоступна). Отправьте username ещё раз.');
      }
      stepState.delete(userId);
      return await ctx.reply(
        `✅ <b>Готово!</b> Автоответчик теперь работает только в переписке с <code>@${escapeHTML(username)}</code>.\n\n` +
        'Чтобы снять ограничение, отправьте команду <code>/no us</code>.',
        { parse_mode: 'HTML' }
      );
    }

    if (state && state.step === 'WAITING_TEXT_ONLY' && ctx.message.text) {
      const text = ctx.message.text;
      if (!(await saveReply(ctx, userId, text))) return;
      stepState.delete(userId);
      return await ctx.reply(`✅ <b>Новый текстовый автоответ сохранён!</b>\n\n${escapeHTML(text)}`, { parse_mode: 'HTML' });
    }

    if (state && state.step === 'WAITING_POST' && isAdmin(userId)) {
      stepState.delete(userId);
      await ctx.reply('🚀 <b>Начинаю рассылку поста...</b>', { parse_mode: 'HTML' });

      const users = (await db.getAllUsers?.()) || [];
      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;

      (async () => {
        const ids = users.map((u) => u.user_id || u.telegram_id || u);
        const { delivered, failed } = await broadcast(ids, (id) => ctx.api.copyMessage(id, chatId, messageId));
        await ctx.api.sendMessage(chatId, `🎉 <b>Пост отправлен!</b> Доставлено: ${delivered} / Ошибок: ${failed}`, { parse_mode: 'HTML' });
      })().catch((e) => console.error('Broadcast /post error:', e?.message || e));

      return;
    }

    if (state && state.step === 'WAITING_TEXT' && ctx.message.text) {
      stepState.set(userId, { step: 'WAITING_STICKER', text: ctx.message.text });
      return await ctx.reply('🖼️ <b>Шаг 2/2:</b> Теперь отправьте стикер:', { parse_mode: 'HTML' });
    }

    if (state && state.step === 'WAITING_STICKER' && ctx.message.sticker) {
      const stickerId = ctx.message.sticker.file_id;
      const comboValue = `combo:${state.text}|||${stickerId}`;
      if (!(await saveReply(ctx, userId, comboValue))) return;
      stepState.delete(userId);
      return await ctx.reply('🔥 <b>Комбо автоответ (Текст + Стикер) сохранён!</b>', { parse_mode: 'HTML' });
    }

    if (state && state.step === 'WAITING_VOICE' && (ctx.message.voice || ctx.message.audio)) {
      const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
      const value = `voice:${fileId}`;
      if (!(await saveReply(ctx, userId, value))) return;
      stepState.delete(userId);
      return await ctx.reply('✅ <b>Голосовой/аудио автоответ сохранён!</b>', { parse_mode: 'HTML' });
    }

    return next();
  });
}
