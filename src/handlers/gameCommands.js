// Мини-игры в бизнес-чатах: запуск .saper / .ttt / .rps / .tod и обработка кнопок `g:<gameId>:<action>`.
// Кнопки нажимают оба участника диалога; гейт подписки их не трогает (регистрируется до callbacks.js).
import { escapeHTML } from '../services/html.js';
import { isIgnorableTelegramError } from '../services/broadcast.js';
import {
  gamesCache, renderGame, applyGameAction,
  createSaperGame, createTttGame, createRpsGame, createTodGame
} from '../services/games.js';
import { notifyOwner, deleteTrigger, errText } from './dotShared.js';

export const GAME_COMMANDS = new Set(['saper', 'ttt', 'rps', 'tod']);
export const GAME_CALLBACK_RE = /^g:([a-z0-9]+):([a-z0-9]+)$/;
export const GAME_EXPIRED_TEXT = 'Игра устарела. Запустите новую командой.';

const userName = (u) => u?.first_name || (u?.username ? `@${u.username}` : '') || null;
const peerNameOf = (chat) => chat?.first_name || (chat?.username ? `@${chat.username}` : '') || chat?.title || 'Собеседник';

function gameContext(c) {
  return {
    connectionId: c.connectionId,
    chatId: c.chatId,
    ownerId: c.ownerId,
    ownerName: userName(c.businessMessage.from) || 'Владелец',
    // Личный бизнес-диалог: chat.id = собеседник.
    peerId: String(c.chat?.id ?? c.chatId),
    peerName: peerNameOf(c.chat)
  };
}

const factories = {
  saper: (g) => createSaperGame(g),
  ttt: (g) => createTttGame(g),
  rps: (g) => createRpsGame(g),
  tod: (g, c) => createTodGame({ ...g, mode: c.args })
};

async function startGame(ctx, c) {
  await deleteTrigger(ctx.api, c.connectionId, c.messageId);
  const game = factories[c.command](gameContext(c), c);
  const view = renderGame(game);
  gamesCache.set(game.id, game);
  try {
    const sent = await ctx.api.sendMessage(c.chatId, view.text, {
      business_connection_id: c.connectionId,
      parse_mode: 'HTML',
      reply_markup: view.reply_markup
    });
    game.messageId = sent?.message_id ?? null;
  } catch (e) {
    gamesCache.delete(game.id);
    await notifyOwner(ctx.api, c.ownerId, `⚠️ <code>.${c.command}</code>: не удалось запустить игру (${escapeHTML(errText(e))}).`);
  }
}

export const gameHandlers = Object.fromEntries([...GAME_COMMANDS].map((cmd) => [cmd, startGame]));

// Редактирования одной партии — строго по очереди; текст рендерится в момент отправки (всегда свежее состояние).
const editChains = new WeakMap();

function scheduleEdit(api, game, fallbackMessageId) {
  const run = async () => {
    const messageId = game.messageId ?? fallbackMessageId;
    if (!messageId) return;
    const view = renderGame(game);
    try {
      await api.editMessageText(game.chatId, messageId, view.text, {
        business_connection_id: game.connectionId,
        parse_mode: 'HTML',
        reply_markup: view.reply_markup
      });
    } catch (e) {
      const d = errText(e);
      if (d.includes('message is not modified') || isIgnorableTelegramError(e)) return;
      console.error(`❌ game ${game.type} edit error:`, d);
    }
  };
  const next = (editChains.get(game) || Promise.resolve()).then(run);
  editChains.set(game, next);
  return next;
}

export function registerGameCallbacks(bot) {
  bot.callbackQuery(/^g:/, async (ctx) => {
    const match = GAME_CALLBACK_RE.exec(ctx.callbackQuery.data || '');
    const game = match ? gamesCache.get(match[1]) : undefined;
    if (!game) {
      await ctx.answerCallbackQuery({ text: GAME_EXPIRED_TEXT, show_alert: true }).catch(() => {});
      return;
    }
    const actor = { id: String(ctx.from.id), name: userName(ctx.from) };
    const res = applyGameAction(game, match[2], actor);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: res.toast, show_alert: res.alert === true }).catch(() => {});
      return;
    }
    gamesCache.set(game.id, game); // продлевает TTL активной партии
    await ctx.answerCallbackQuery(res.toast ? { text: res.toast } : undefined).catch(() => {});
    await scheduleEdit(ctx.api, game, ctx.callbackQuery.message?.message_id);
  });
}
