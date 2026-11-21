// Админские команды и Human-in-the-loop публикация черновиков в канал.
import { config, isAdmin } from '../config.js';
import { db } from '../db/index.js';
import { escapeHTML } from '../services/html.js';
import { broadcast } from '../services/broadcast.js';
import { buildPostKeyboard, buildSendPayload } from '../services/publishing.js';
import { stepState, patchSettings, setGlobalStop } from '../bot/state.js';

const BLOCK_DURATION = 24 * 60 * 60 * 1000;

function isValidTargetId(id) {
  return typeof id === 'string' && /^-?\d+$/.test(id);
}

export async function showAdminPanel(ctx) {
  if (!isAdmin(ctx.from.id)) {
    return await ctx.reply(
      '🔒 <b>Раздел для администраторов</b>\n\n' +
      'Эта система предназначена только для администраторов.',
      { parse_mode: 'HTML' }
    );
  }

  const adminText =
    '👑 <b>ПАНЕЛЬ АДМИНИСТРАТОРА (ADMINPPA)</b>\n\n' +
    '🛠️ <b>Все доступные команды и их назначение:</b>\n\n' +
    '📢 <b>Массовые рассылки:</b>\n' +
    '• <code>/post</code> — Создать пост (с фото/видео/кнопками) и разослать всем пользователям бота.\n' +
    '• <code>/m Текст</code> — Быстрая рассылка простого текста всем юзерам.\n\n' +
    '📩 <b>Личные сообщения:</b>\n' +
    '• <code>/mm ID Сообщение</code> — Отправить личное сообщение от имени бота конкретному пользователю по его Telegram ID.\n\n' +
    '🛑 <b>Управление автоответчиком:</b>\n' +
    '• <code>/stop all</code> — Глобально остановить автоответчик для ВСЕХ пользователей.\n' +
    '• <code>/unstop all</code> — Включить глобальный автоответчик обратно.\n' +
    '• <code>/stop ID</code> — Заблокировать автоответ для конкретного ID.\n' +
    '• <code>/unstop ID</code> — Разблокировать автоответ для конкретного ID.\n\n' +
    '📊 <b>Редактирование и Инфо:</b>\n' +
    '• <code>/info ID</code> — Посмотреть всю информацию о пользователе (его ID, автоответ, график работы).\n' +
    '• <code>/setreply ID Текст</code> — Принудительно изменить автоответ для указанного пользователя.';

  await ctx.reply(adminText, { parse_mode: 'HTML' });
}

// Убирает с превью ряд одобрения, оставляя URL-кнопки самого поста.
async function removeApprovalButtons(ctx, draft) {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: buildPostKeyboard(draft?.buttons_json) || { inline_keyboard: [] } });
  } catch (e) {}
}

export function registerAdminHandlers(bot) {
  // Утилита для админов: показывает chat.id и chat.type (например, чтобы узнать DISCUSSION_GROUP_ID).
  bot.command('chatid', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    await ctx.reply(`chat.id: <code>${ctx.chat.id}</code>\nchat.type: <code>${ctx.chat.type}</code>`, { parse_mode: 'HTML' });
  });

  bot.command('admins', showAdminPanel);
  bot.command('adminppa', showAdminPanel);

  bot.command('setreply', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const fullText = ctx.message.text.replace(/^\/setreply\s*/i, '').trim();
    const args = fullText.split(/\s+/);
    const targetId = args[0];
    const newReply = args.slice(1).join(' ');

    if (!targetId || !newReply) {
      return await ctx.reply('👑 Использование: <code>/setreply ID Новый текст</code>', { parse_mode: 'HTML' });
    }

    try {
      await db.setCustomReply(targetId, newReply);
      patchSettings(targetId, { custom_reply: newReply });
    } catch (e) {
      return await ctx.reply('⚠️ Ошибка БД, не сохранено.');
    }
    await ctx.reply(`👑 <b>Успешно отредактировано для ID ${targetId}!</b>`, { parse_mode: 'HTML' });
  });

  bot.command('stop', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.trim().split(/\s+/);
    const target = args[1]?.toLowerCase();

    if (target === 'all') {
      try {
        await db.setBotState('global_stop', 'true');
      } catch (e) {
        return await ctx.reply('⚠️ Ошибка БД, состояние не сохранено.');
      }
      setGlobalStop(true);
      return await ctx.reply('🛑 <b>Глобальный автоответчик ОСТАНОВЛЕН!</b>', { parse_mode: 'HTML' });
    }
    if (target) {
      if (!isValidTargetId(target)) {
        return await ctx.reply('❌ ID должен быть числом: <code>/stop 123456789</code>', { parse_mode: 'HTML' });
      }
      const until = Date.now() + BLOCK_DURATION;
      try {
        await db.setBlockedUntil(target, until);
      } catch (e) {
        return await ctx.reply('⚠️ Ошибка БД, блокировка не сохранена.');
      }
      patchSettings(target, { blocked_until: until });
      return await ctx.reply(`🛑 Автоответчик остановлен на 24 ч для ID: <code>${target}</code>`, { parse_mode: 'HTML' });
    }
    await ctx.reply('❌ Использование: <code>/stop all</code> или <code>/stop &lt;USER_ID&gt;</code>', { parse_mode: 'HTML' });
  });

  bot.command('unstop', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.trim().split(/\s+/);
    const target = args[1]?.toLowerCase();

    if (target === 'all') {
      try {
        await db.setBotState('global_stop', 'false');
      } catch (e) {
        return await ctx.reply('⚠️ Ошибка БД, состояние не сохранено.');
      }
      setGlobalStop(false);
      return await ctx.reply('✅ <b>Глобальный автоответчик ВКЛЮЧЕН!</b>', { parse_mode: 'HTML' });
    }
    if (target) {
      if (!isValidTargetId(target)) {
        return await ctx.reply('❌ ID должен быть числом: <code>/unstop 123456789</code>', { parse_mode: 'HTML' });
      }
      try {
        await db.setBlockedUntil(target, null);
      } catch (e) {
        return await ctx.reply('⚠️ Ошибка БД, разблокировка не сохранена.');
      }
      patchSettings(target, { blocked_until: null });
      return await ctx.reply(`✅ Автоответчик возобновлен для ID: <code>${target}</code>`, { parse_mode: 'HTML' });
    }
    await ctx.reply('❌ Использование: <code>/unstop all</code> или <code>/unstop &lt;USER_ID&gt;</code>', { parse_mode: 'HTML' });
  });

  bot.command('m', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const text = ctx.message.text.replace(/^\/m\s*/i, '').trim();
    if (!text) return await ctx.reply('❌ Напишите текст после команды.', { parse_mode: 'HTML' });

    const users = (await db.getAllUsers?.()) || [];
    await ctx.reply(`📢 <b>Начинаю рассылку...</b> Всего получателей: ${users.length}`, { parse_mode: 'HTML' });

    (async () => {
      const ids = users.map((u) => u.user_id || u.telegram_id || u);
      const { delivered, failed } = await broadcast(ids, (id) => ctx.api.sendMessage(id, text, { parse_mode: 'HTML' }));
      await ctx.reply(`🎉 <b>Рассылка завершена!</b> Доставлено: ${delivered} / Ошибок: ${failed}`, { parse_mode: 'HTML' });
    })().catch((e) => console.error('Broadcast /m error:', e?.message || e));
  });

  bot.command('mm', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.replace(/^\/mm\s*/i, '').trim().split(/\s+/);
    const targetId = args[0];
    const messageText = args.slice(1).join(' ');

    if (!targetId || !messageText) return await ctx.reply('❌ Использование: <code>/mm &lt;ID&gt; &lt;Сообщение&gt;</code>', { parse_mode: 'HTML' });

    try {
      await ctx.api.sendMessage(targetId, messageText, { parse_mode: 'HTML' });
      await ctx.reply(`✅ Сообщение отправлено пользователю <code>${targetId}</code>`, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply(`❌ Ошибка: ${e.message}`);
    }
  });

  bot.command('post', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    stepState.set(String(ctx.from.id), { step: 'WAITING_POST' });
    await ctx.reply('📢 <b>Режим создания поста:</b> Отправьте следующий пост для рассылки!', { parse_mode: 'HTML' });
  });

  // ===== HUMAN-IN-THE-LOOP ПУБЛИКАЦИЯ В КАНАЛ (Фаза 2) =====
  // Пост попадает в канал ТОЛЬКО здесь — после клика админа по кнопке превью.

  bot.callbackQuery(/^draft_approve:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      return await ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
    }
    const targetChannelId = config.targetChannelId;
    if (!targetChannelId) {
      return await ctx.answerCallbackQuery({ text: '⚠️ TARGET_CHANNEL_ID не задан — публикация в канал запрещена.', show_alert: true });
    }

    const draftId = Number(ctx.match[1]);
    let draft;
    try {
      draft = await db.claimDraftForPublishing(draftId);
    } catch (e) {
      return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
    }
    if (!draft) {
      return await ctx.answerCallbackQuery({ text: 'Черновик уже опубликован или отменён', show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: '⏳ Публикую…' }).catch(() => {});

    let sent;
    try {
      const { method, args } = buildSendPayload(draft, targetChannelId, buildPostKeyboard(draft.buttons_json));
      sent = await ctx.api[method](...args);
    } catch (e) {
      const details = e?.description || e?.message || String(e);
      console.error(`❌ Публикация черновика #${draftId} не удалась:`, details);
      db.saveErrorLog(String(targetChannelId), 'draft_publish', `[draft ${draftId}] ${details}`).catch(() => {});
      let rollbackNote = 'Статус возвращён в pending_approval — можно исправить причину и нажать «Опубликовать» ещё раз.';
      try {
        await db.markDraftStatus(draftId, 'pending_approval', null, 'publishing');
      } catch (dbErr) {
        rollbackNote = `⚠️ Не удалось откатить статус (остался publishing): ${escapeHTML(dbErr?.message || dbErr)}`;
      }
      return await ctx.reply(
        `❌ Черновик #${draftId} не опубликован.\nОшибка Telegram: <code>${escapeHTML(details)}</code>\n\n${rollbackNote}`,
        { parse_mode: 'HTML' }
      );
    }

    // Пост уже в канале: при сбое БД статус НЕ откатываем (остаётся publishing — повторная публикация невозможна).
    try {
      await db.markDraftPublished(draftId, { approvedBy: String(ctx.from.id), publishedMessageId: sent.message_id });
    } catch (e) {
      console.error(`⚠️ Черновик #${draftId} опубликован, но статус не сохранён:`, e?.message || e);
    }
    await removeApprovalButtons(ctx, draft);
    await ctx.reply(`✅ Черновик #${draftId} опубликован в канал (message_id: ${sent.message_id})`);
  });

  bot.callbackQuery(/^draft_cancel:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      return await ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
    }
    const draftId = Number(ctx.match[1]);
    let draft;
    try {
      draft = await db.markDraftStatus(draftId, 'cancelled', String(ctx.from.id), 'pending_approval');
    } catch (e) {
      return await ctx.answerCallbackQuery({ text: '⚠️ База данных недоступна, попробуйте ещё раз.', show_alert: true });
    }
    if (!draft) {
      return await ctx.answerCallbackQuery({ text: 'Черновик уже опубликован или отменён', show_alert: true });
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await removeApprovalButtons(ctx, draft);
    await ctx.reply(`❌ Черновик #${draftId} отменён`);
  });
}
