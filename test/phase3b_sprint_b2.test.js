import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Окружение — ДО импорта src/. Гейт подписки активен; Gemini «настроен», fetch замокан (0 сетевых запросов).
process.env.BOT_TOKEN = '123456:TEST-TOKEN';
process.env.ADMIN_IDS = '111';
process.env.DISCUSSION_GROUP_ID = '';
process.env.TARGET_CHANNEL_ID = '@kaguya_test_channel';
process.env.DATABASE_URL = '';
process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY';
process.env.GEMINI_MODEL = '';
delete process.env.REQUIRE_SUBSCRIPTION;

const { config } = await import('../src/config.js');
const games = await import('../src/services/games.js');
const {
  gamesCache, clearGamesCache, generateGameId,
  createSaperGame, stepSaper, restartSaper, renderSaper, saperNeighbors, SAPER_SAFE, SAPER_CELLS, SAPER_MINES,
  createTttGame, stepTtt, restartTtt, renderTtt,
  createRpsGame, stepRps, restartRps, renderRps, rpsOutcome,
  createTodGame, stepTod, renderTod, TOD_TRUTHS, TOD_DARES
} = games;
const { GAME_COMMANDS, GAME_EXPIRED_TEXT } = await import('../src/handlers/gameCommands.js');
const { HELP_TEXT, isKnownDotCommand } = await import('../src/handlers/dotCommands.js');
const { isGateExemptCallback } = await import('../src/handlers/callbacks.js');
const { waitAiTasks } = await import('../src/services/gemini.js');
const { clearAiState } = await import('../src/handlers/aiCommands.js');
const { db, DEFAULT_USER_SETTINGS } = await import('../src/db/index.js');
const { createBot, stopCacheCleanup } = await import('../src/bot/index.js');
const { clearChatRulesCache, connectionMeta, userSettingsCache } = await import('../src/bot/state.js');
const { clearSubscriptionCache } = await import('../src/services/subscription.js');
const { stopDeleteQueue } = await import('../src/services/deleteQueue.js');

const realFetch = globalThis.fetch;
const gem = { calls: 0 };
globalThis.fetch = async () => {
  gem.calls++;
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ответ ИИ' }] } }] }) };
};
after(() => {
  globalThis.fetch = realFetch;
  stopCacheCleanup();
  clearGamesCache();
});

const OWNER = '555';
const PEER = '9201';
const ctxBase = { connectionId: 'conn-b2', chatId: PEER, ownerId: OWNER, ownerName: 'Эрмек', peerId: PEER, peerName: 'Алихан' };
const buttons = (view) => view.reply_markup.inline_keyboard.flat();

// ======================= Общее =======================

describe('Игры: общее', () => {
  test('gameId: 8 символов [a-z0-9], callback_data ≤ 64 байт', () => {
    for (let i = 0; i < 50; i++) assert.match(generateGameId(), /^[a-z0-9]{8}$/);
    const views = [
      renderSaper(createSaperGame(ctxBase)), renderTtt(createTttGame(ctxBase)),
      renderRps(createRpsGame(ctxBase)), renderTod(createTodGame(ctxBase))
    ];
    for (const v of views) {
      for (const b of buttons(v)) {
        assert.match(b.callback_data, /^g:[a-z0-9]{8}:[a-z0-9]+$/);
        assert.ok(Buffer.byteLength(b.callback_data) <= 64);
      }
    }
  });

  test('gamesCache: TTL 30 минут и maxSize 2000', () => {
    assert.equal(gamesCache.maxSize, 2000);
    assert.equal(gamesCache.ttlMs, 30 * 60 * 1000);
  });

  test('команды зарегистрированы, HELP_TEXT содержит раздел «🎮 Игры»', () => {
    for (const c of ['saper', 'ttt', 'rps', 'tod']) {
      assert.ok(GAME_COMMANDS.has(c));
      assert.ok(isKnownDotCommand(c), c);
      assert.ok(HELP_TEXT.includes(`.${c}`), c);
    }
    assert.ok(HELP_TEXT.includes('🎮 <b>Игры</b>'));
    assert.ok(HELP_TEXT.length < 4096);
  });

  test('isGateExemptCallback: g:* и бизнес-колбэки всегда без гейта', () => {
    assert.equal(isGateExemptCallback({ data: 'g:abcd1234:1' }), true);
    assert.equal(isGateExemptCallback({ data: 'x', message: { business_connection_id: 'c' } }), true);
    assert.equal(isGateExemptCallback({ data: 'x', business_connection_id: 'c' }), true);
    assert.equal(isGateExemptCallback({ data: 'check_sub' }), true);
    assert.equal(isGateExemptCallback({ data: 'open_main_menu', message: { chat: { type: 'private' } } }), false);
  });

  test('config: дефолтная модель Gemini — gemini-3.5-flash', () => {
    assert.equal(config.geminiModel, 'gemini-3.5-flash');
  });
});

// ======================= Сапёр =======================

describe('Сапёр', () => {
  const MINES = [12, 13, 14, 24];

  test('первый клик никогда не взрывается (случайные мины и мина под курсором)', () => {
    for (let idx = 0; idx < SAPER_CELLS; idx++) {
      const g = createSaperGame(ctxBase);
      const r = stepSaper(g, idx);
      assert.equal(r.ok, true);
      assert.notEqual(g.status, 'lost', `клетка ${idx}`);
      assert.equal(g.mines.length, SAPER_MINES);
      assert.ok(!g.mines.includes(idx));
    }
    // Мина ровно под первым кликом переносится на первую свободную клетку.
    const g = createSaperGame({ ...ctxBase, mines: [0, 1, 2, 3] });
    stepSaper(g, 0);
    assert.notEqual(g.status, 'lost');
    assert.deepEqual(g.mines, [1, 2, 3, 4]);
    assert.equal(new Set(g.mines).size, SAPER_MINES);
  });

  test('каскадное открытие пустых клеток (BFS)', () => {
    // Стена мин в 3-м ряду + угол: клик в (0,0) раскрывает всё, кроме клетки 19.
    const g = createSaperGame({ ...ctxBase, mines: MINES });
    stepSaper(g, 0);
    assert.equal(g.status, 'playing');
    assert.equal(g.openedCount, SAPER_SAFE - 1);
    assert.equal(g.opened[19], false);
    for (const m of g.mines) assert.equal(g.opened[m], false);
    // Инвариант BFS: у каждой открытой «пустой» клетки открыты все безопасные соседи.
    const view = renderSaper(g);
    const b = buttons(view);
    for (let i = 0; i < SAPER_CELLS; i++) {
      if (g.opened[i] && b[i].text === '▫️') {
        for (const n of saperNeighbors(i)) assert.ok(g.opened[n], `сосед ${n} клетки ${i}`);
      }
    }
    assert.equal(b[0].text, '▫️');
    assert.equal(b[8].text, '3️⃣');
    assert.equal(b[18].text, '4️⃣');
    assert.equal(b[19].text, '⬜');
    assert.ok(saperNeighbors(0).length === 3 && saperNeighbors(12).length === 8);
  });

  test('победа: открыты все 21 безопасная клетка, поле раскрыто, кнопка «Новая игра»', () => {
    const g = createSaperGame({ ...ctxBase, mines: MINES });
    stepSaper(g, 0);
    assert.equal(g.status, 'playing');
    stepSaper(g, 19);
    assert.equal(g.status, 'won');
    assert.equal(g.openedCount, SAPER_SAFE);
    const view = renderSaper(g);
    assert.match(view.text, /Победа/);
    const b = buttons(view);
    for (const m of MINES) assert.equal(b[m].text, '💣');
    assert.equal(b.at(-1).text, '🔄 Новая игра');
    assert.equal(b.at(-1).callback_data, `g:${g.id}:r`);
    assert.equal(stepSaper(g, 0).ok, false, 'после конца ходы не принимаются');
  });

  test('взрыв: 💥 на мине, остальные 💣, рестарт сбрасывает поле', () => {
    const g = createSaperGame({ ...ctxBase, mines: MINES });
    stepSaper(g, 0);
    assert.equal(stepSaper(g, 0).toast, 'Клетка уже открыта');
    stepSaper(g, 24, { actorName: 'Алихан' });
    assert.equal(g.status, 'lost');
    const view = renderSaper(g);
    assert.match(view.text, /Бум!.*Алихан/);
    const b = buttons(view);
    assert.equal(b[24].text, '💥');
    for (const m of [12, 13, 14]) assert.equal(b[m].text, '💣');
    assert.ok(!b.slice(0, 25).some((x) => x.text === '⬜'), 'поле раскрыто');

    assert.equal(restartSaper(g).ok, true);
    assert.equal(g.status, 'playing');
    assert.equal(g.mines, null);
    assert.equal(g.openedCount, 0);
    assert.equal(g.round, 2);
    assert.ok(buttons(renderSaper(g)).every((x) => x.text === '⬜'));
    assert.equal(restartSaper(g).ok, false, 'во время партии рестарт недоступен');
  });
});

// ======================= Крестики-нолики =======================

describe('Крестики-нолики', () => {
  test('очерёдность ходов, занятая клетка, чужой клик', () => {
    const g = createTttGame(ctxBase);
    assert.match(renderTtt(g).text, /Ходит: ❌ <b>Эрмек<\/b>/);
    assert.deepEqual(stepTtt(g, PEER, 0), { ok: false, toast: 'Сейчас не ваш ход', alert: false });
    assert.equal(stepTtt(g, OWNER, 4).ok, true);
    assert.equal(stepTtt(g, OWNER, 0).toast, 'Сейчас не ваш ход');
    assert.equal(stepTtt(g, PEER, 4).toast, 'Клетка занята');
    assert.deepEqual(stepTtt(g, '42', 0), { ok: false, toast: 'Это не ваша партия!', alert: true });
    assert.equal(stepTtt(g, PEER, 0).ok, true);
    const b = buttons(renderTtt(g));
    assert.equal(b[4].text, '❌');
    assert.equal(b[0].text, '⭕');
    assert.equal(b[0].callback_data, `g:${g.id}:0`);
  });

  test('победа по диагонали + реванш меняет первый ход', () => {
    const g = createTttGame(ctxBase);
    for (const [who, idx] of [[OWNER, 0], [PEER, 1], [OWNER, 4], [PEER, 2], [OWNER, 8]]) {
      assert.equal(stepTtt(g, who, idx).ok, true);
    }
    assert.equal(g.status, 'won');
    assert.equal(g.winner, 'X');
    assert.deepEqual(g.winLine, [0, 4, 8]);
    assert.deepEqual(g.score, { p1: 1, p2: 0, draw: 0 });
    const view = renderTtt(g);
    assert.match(view.text, /Победа: ❌ <b>Эрмек<\/b>/);
    assert.equal(buttons(view).at(-1).callback_data, `g:${g.id}:r`);
    assert.equal(stepTtt(g, PEER, 3).ok, false);

    assert.equal(restartTtt(g, '42').toast, 'Это не ваша партия!');
    assert.equal(restartTtt(g, PEER).ok, true);
    assert.equal(g.turn, 'O', 'реванш: первым ходит другой');
    assert.ok(g.board.every((c) => c === null));
    assert.equal(g.round, 2);
    assert.equal(stepTtt(g, OWNER, 0).toast, 'Сейчас не ваш ход');
    assert.equal(stepTtt(g, PEER, 0).ok, true);
  });

  test('ничья', () => {
    const g = createTttGame(ctxBase);
    // X O X / X O O / O X X
    for (const [who, idx] of [[OWNER, 0], [PEER, 1], [OWNER, 2], [PEER, 4], [OWNER, 3], [PEER, 5], [OWNER, 7], [PEER, 6], [OWNER, 8]]) {
      assert.equal(stepTtt(g, who, idx).ok, true, `ход ${idx}`);
    }
    assert.equal(g.status, 'draw');
    assert.equal(g.score.draw, 1);
    assert.match(renderTtt(g).text, /Ничья/);
  });
});

// ======================= КНБ =======================

describe('Камень-ножницы-бумага', () => {
  test('выбор первого игрока скрыт до хода второго', () => {
    const g = createRpsGame(ctxBase);
    const r = stepRps(g, OWNER, 'r');
    assert.equal(r.ok, true);
    assert.match(r.toast, /Камень/);
    const view = renderRps(g);
    assert.match(view.text, /✅ Эрмек сделал\(а\) выбор/);
    assert.match(view.text, /⏳ Алихан думает/);
    assert.ok(!/🪨|✂️|📄/.test(view.text), 'выбор не виден в тексте');
    assert.deepEqual(buttons(view).map((b) => b.callback_data), [`g:${g.id}:r`, `g:${g.id}:s`, `g:${g.id}:p`]);
    assert.equal(stepRps(g, OWNER, 'p').toast, 'Вы уже сделали выбор 🤫');
    assert.deepEqual(stepRps(g, '42', 'p'), { ok: false, toast: 'Это не ваша партия!', alert: true });
    assert.equal(stepRps(g, PEER, 'x').ok, false);
  });

  test('все комбинации победы и ничья, вскрытие и реванш', () => {
    assert.equal(rpsOutcome('r', 's'), 'p1');
    assert.equal(rpsOutcome('s', 'p'), 'p1');
    assert.equal(rpsOutcome('p', 'r'), 'p1');
    assert.equal(rpsOutcome('s', 'r'), 'p2');
    assert.equal(rpsOutcome('p', 's'), 'p2');
    assert.equal(rpsOutcome('r', 'p'), 'p2');
    for (const c of ['r', 's', 'p']) assert.equal(rpsOutcome(c, c), 'draw');

    const g = createRpsGame(ctxBase);
    stepRps(g, PEER, 'p');
    const r = stepRps(g, OWNER, 'r');
    assert.equal(r.result, 'p2');
    assert.equal(g.status, 'done');
    const view = renderRps(g);
    assert.match(view.text, /Эрмек: 🪨 Камень/);
    assert.match(view.text, /Алихан: 📄 Бумага/);
    assert.match(view.text, /Победа: <b>Алихан<\/b>/);
    assert.deepEqual(buttons(view).map((b) => b.callback_data), [`g:${g.id}:n`]);
    assert.equal(stepRps(g, OWNER, 's').ok, false);

    assert.equal(restartRps(g, OWNER).ok, true);
    assert.equal(g.round, 2);
    stepRps(g, OWNER, 's');
    stepRps(g, PEER, 's');
    assert.equal(g.result, 'draw');
    assert.match(renderRps(g).text, /Ничья/);
    assert.deepEqual(g.score, { p1: 0, p2: 1, draw: 1 });
  });
});

// ======================= Правда или действие =======================

describe('Правда или действие', () => {
  test('банк ≥ 25 + 25 уникальных карточек', () => {
    assert.ok(TOD_TRUTHS.length >= 25);
    assert.ok(TOD_DARES.length >= 25);
    assert.equal(new Set(TOD_TRUTHS).size, TOD_TRUTHS.length);
    assert.equal(new Set(TOD_DARES).size, TOD_DARES.length);
  });

  test('стартовый экран и запуск с режимом', () => {
    const start = createTodGame(ctxBase);
    const v = renderTod(start);
    assert.match(v.text, /Выбирайте/);
    assert.deepEqual(buttons(v).map((b) => b.callback_data), [`g:${start.id}:t`, `g:${start.id}:d`]);
    const t = createTodGame({ ...ctxBase, mode: 'правда' });
    assert.equal(t.kind, 'truth');
    assert.ok(TOD_TRUTHS.includes(t.card));
    const d = createTodGame({ ...ctxBase, mode: 'Действие' });
    assert.equal(d.kind, 'dare');
    assert.ok(TOD_DARES.includes(d.card));
    assert.match(renderTod(d).text, /🔥 <b>Действие<\/b>/);
  });

  test('переключение карточек без повтора подряд (даже при «залипшем» rng)', () => {
    const g = createTodGame(ctxBase);
    const stuck = () => 0;
    stepTod(g, 't', { rng: stuck });
    let prev = g.card;
    for (let i = 0; i < 10; i++) {
      stepTod(g, 't', { rng: stuck });
      assert.notEqual(g.card, prev);
      prev = g.card;
    }
    for (let i = 0; i < 200; i++) {
      const before = { kind: g.kind, card: g.card };
      const action = i % 3 === 0 ? 'd' : 't';
      assert.equal(stepTod(g, action).ok, true);
      if (before.kind === g.kind) assert.notEqual(g.card, before.card);
    }
    assert.equal(stepTod(g, 'x').ok, false);
  });
});

// ======================= Интеграция через createBot =======================

const CONN = 'conn-b2';
const store = { connections: new Map(), rules: new Map(), settings: new Map(), usage: new Map() };

Object.assign(db, {
  saveErrorLog: async () => {},
  upsertBusinessConnection: async (info) => { store.connections.set(info.connectionId, { ...info }); },
  getBusinessConnection: async (id) => store.connections.get(id) || null,
  setChatRule: async (ownerId, chatId, patch) => {
    const k = `${ownerId}:${chatId}`;
    const next = { isMuted: false, deleteStickersGifs: false, autoAiPrompt: null, kawaiiEnabled: false, ...(store.rules.get(k) || {}), ...patch };
    store.rules.set(k, next);
    return next;
  },
  getAllActiveChatRules: async () => [],
  saveCachedBusinessMessage: async () => {},
  getCachedBusinessMessages: async () => [],
  getRecentCachedMessageIds: async () => [],
  getRecentCachedMessages: async () => [],
  pruneOldBusinessMessages: async () => 0,
  getBotState: async () => null,
  getUserSettings: async (id) => ({ ...DEFAULT_USER_SETTINGS, ...(store.settings.get(String(id)) || {}) }),
  getAiUsageToday: async (id) => store.usage.get(id) || 0,
  incrementAiUsage: async (id) => { store.usage.set(id, (store.usage.get(id) || 0) + 1); return store.usage.get(id); },
  listCustomRp: async () => []
});

const botInfo = {
  id: 123456, is_bot: true, first_name: 'Kaguya Test', username: 'kaguya_test_bot',
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false
};

function makeBot() {
  const bot = createBot('123456:TEST-TOKEN', { botInfo });
  const calls = [];
  let nextId = 70_000;
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getChatMember') {
      // Никто не подписан на канал.
      return { ok: false, error_code: 400, description: 'Bad Request: USER_NOT_PARTICIPANT' };
    }
    if (method === 'getBusinessConnection') {
      return { ok: false, error_code: 400, description: 'Bad Request: BUSINESS_CONNECTION_INVALID' };
    }
    const result = method.startsWith('send') ? { message_id: nextId++, date: 0, chat: { id: payload.chat_id } } : true;
    return { ok: true, result };
  });
  return { bot, calls };
}

let updateId = 1;
let messageId = 8000;
const ownerUser = { id: Number(OWNER), is_bot: false, first_name: 'Эрмек' };
const peerUser = (id) => ({ id: Number(id), is_bot: false, first_name: 'Алихан', username: `peer${id}` });
const privateChat = (peerId) => ({ id: Number(peerId), type: 'private', first_name: 'Алихан', username: `peer${peerId}` });

const businessUpdate = (peerId, from, extra = {}) => ({
  update_id: updateId++,
  business_message: {
    message_id: ++messageId, business_connection_id: CONN, date: Math.floor(Date.now() / 1000),
    chat: privateChat(peerId), from, ...extra
  }
});

const connectionUpdate = () => ({
  update_id: updateId++,
  business_connection: {
    id: CONN, user: ownerUser, user_chat_id: ownerUser.id, date: 0, is_enabled: true,
    rights: { can_reply: true, can_delete_sent_messages: true, can_delete_all_messages: true }
  }
});

// Колбэк от кнопки под бизнес-сообщением бота (message.business_connection_id задан, чат — личный с собеседником).
const callbackUpdate = (from, data, peerId, msgId) => ({
  update_id: updateId++,
  callback_query: {
    id: `cq${updateId}`, from, chat_instance: 'ci', data,
    message: {
      message_id: msgId, date: 0, chat: privateChat(peerId), business_connection_id: CONN,
      from: { id: botInfo.id, is_bot: true, first_name: botInfo.first_name }, text: 'game'
    }
  }
});

async function send(bot, update) {
  await bot.handleUpdate(update);
  await waitAiTasks();
}

const byMethod = (calls, m) => calls.filter((c) => c.method === m);

describe('Интеграция: игры в бизнес-чате', () => {
  beforeEach(() => {
    stopDeleteQueue();
    clearChatRulesCache();
    clearAiState();
    clearGamesCache();
    clearSubscriptionCache();
    connectionMeta.clear();
    userSettingsCache.clear();
    store.rules.clear();
    store.settings.clear();
    store.usage.clear();
    gem.calls = 0;
  });

  test('.ttt: старт + ходы обоих игроков через editMessageText, гейт подписки не мешает', async () => {
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    const trigger = businessUpdate(PEER, ownerUser, { text: '.ttt' });
    await send(bot, trigger);

    assert.ok(byMethod(calls, 'deleteBusinessMessages').some((c) => c.payload.message_ids.includes(trigger.business_message.message_id)));
    const start = byMethod(calls, 'sendMessage').find((c) => String(c.payload.chat_id) === PEER);
    assert.ok(start, 'стартовое сообщение в чат');
    assert.equal(start.payload.business_connection_id, CONN);
    assert.equal(start.payload.parse_mode, 'HTML');
    const kb = start.payload.reply_markup.inline_keyboard.flat();
    assert.equal(kb.length, 9);
    const [, gameId] = kb[4].callback_data.split(':');
    const game = gamesCache.get(gameId);
    assert.equal(game.type, 'ttt');
    assert.equal(game.ownerId, OWNER);
    assert.equal(game.peerId, PEER);
    const gameMsgId = game.messageId;
    assert.ok(gameMsgId);

    // Ход владельца.
    await send(bot, callbackUpdate(ownerUser, `g:${gameId}:4`, PEER, gameMsgId));
    // Ход собеседника — он не подписан на канал, но гейт его не трогает.
    await send(bot, callbackUpdate(peerUser(PEER), `g:${gameId}:0`, PEER, gameMsgId));

    assert.equal(byMethod(calls, 'getChatMember').length, 0, 'гейт подписки не вызывался');
    const edits = byMethod(calls, 'editMessageText');
    assert.equal(edits.length, 2);
    for (const e of edits) {
      assert.equal(String(e.payload.chat_id), PEER);
      assert.equal(e.payload.message_id, gameMsgId);
      assert.equal(e.payload.business_connection_id, CONN);
      assert.equal(e.payload.parse_mode, 'HTML');
    }
    const last = edits.at(-1).payload.reply_markup.inline_keyboard.flat();
    assert.equal(last[4].text, '❌');
    assert.equal(last[0].text, '⭕');
    assert.match(edits.at(-1).payload.text, /Ходит: ❌/);
    assert.equal(byMethod(calls, 'answerCallbackQuery').length, 2);
    assert.ok(!byMethod(calls, 'editMessageText').some((e) => /подпишитесь/i.test(e.payload.text)));

    // Чужой — алерт, без редактирования.
    await send(bot, callbackUpdate(peerUser(4242), `g:${gameId}:1`, PEER, gameMsgId));
    const alert = byMethod(calls, 'answerCallbackQuery').at(-1).payload;
    assert.equal(alert.text, 'Это не ваша партия!');
    assert.equal(alert.show_alert, true);
    // Занятая клетка — toast.
    await send(bot, callbackUpdate(ownerUser, `g:${gameId}:0`, PEER, gameMsgId));
    assert.equal(byMethod(calls, 'answerCallbackQuery').at(-1).payload.text, 'Клетка занята');
    assert.equal(byMethod(calls, 'editMessageText').length, 2);
  });

  test('устаревшая игра и мусорный g:* — алерт без гейта', async () => {
    const { bot, calls } = makeBot();
    await send(bot, callbackUpdate(peerUser(PEER), 'g:deadbeef:1', PEER, 1));
    await send(bot, callbackUpdate(peerUser(PEER), 'g:BAD!', PEER, 1));
    const answers = byMethod(calls, 'answerCallbackQuery');
    assert.equal(answers.length, 2);
    for (const a of answers) {
      assert.equal(a.payload.text, GAME_EXPIRED_TEXT);
      assert.equal(a.payload.show_alert, true);
    }
    assert.equal(byMethod(calls, 'getChatMember').length, 0);
    assert.equal(byMethod(calls, 'editMessageText').length, 0);
  });

  test('.rps: скрытый выбор до хода второго, затем вскрытие', async () => {
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    await send(bot, businessUpdate(PEER, ownerUser, { text: '.rps' }));
    const start = byMethod(calls, 'sendMessage').find((c) => String(c.payload.chat_id) === PEER);
    const [, gameId] = start.payload.reply_markup.inline_keyboard[0][0].callback_data.split(':');
    const msgId = gamesCache.get(gameId).messageId;

    await send(bot, callbackUpdate(ownerUser, `g:${gameId}:s`, PEER, msgId));
    const hidden = byMethod(calls, 'editMessageText').at(-1).payload.text;
    assert.ok(!/✂️/.test(hidden));
    assert.match(hidden, /✅ Эрмек сделал\(а\) выбор/);

    await send(bot, callbackUpdate(peerUser(PEER), `g:${gameId}:p`, PEER, msgId));
    const reveal = byMethod(calls, 'editMessageText').at(-1).payload;
    assert.match(reveal.text, /Победа: <b>Эрмек<\/b>/);
    assert.equal(reveal.reply_markup.inline_keyboard.flat()[0].callback_data, `g:${gameId}:n`);
    assert.equal(byMethod(calls, 'getChatMember').length, 0);
  });

  test('.saper и .tod правда запускаются в чате', async () => {
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    await send(bot, businessUpdate(PEER, ownerUser, { text: '.saper' }));
    await send(bot, businessUpdate(PEER, ownerUser, { text: '.tod правда' }));
    const sent = byMethod(calls, 'sendMessage').filter((c) => String(c.payload.chat_id) === PEER);
    assert.equal(sent.length, 2);
    assert.match(sent[0].payload.text, /Сапёр/);
    assert.equal(sent[0].payload.reply_markup.inline_keyboard.flat().length, 25);
    assert.match(sent[1].payload.text, /🤔 <b>Правда<\/b>/);

    // Сапёр: собеседник тоже может играть.
    const [, sid] = sent[0].payload.reply_markup.inline_keyboard[0][0].callback_data.split(':');
    await send(bot, callbackUpdate(peerUser(PEER), `g:${sid}:12`, PEER, gamesCache.get(sid).messageId));
    assert.equal(byMethod(calls, 'editMessageText').length, 1);
    assert.notEqual(gamesCache.get(sid).status, 'lost');
  });

  test('.autoai: заблокированный (blocked_until) владелец не вызывает Gemini', async () => {
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    await send(bot, businessUpdate(PEER, ownerUser, { text: '.autoai отвечай вежливо' }));
    assert.equal(store.rules.get(`${OWNER}:${PEER}`).autoAiPrompt, 'отвечай вежливо');

    store.settings.set(OWNER, { blocked_until: Date.now() + 60 * 60 * 1000 });
    userSettingsCache.clear();
    const before = byMethod(calls, 'sendMessage').filter((c) => String(c.payload.chat_id) === PEER).length;
    await send(bot, businessUpdate(PEER, peerUser(PEER), { text: 'привет' }));
    assert.equal(gem.calls, 0, 'Gemini не вызывался');
    assert.equal(store.usage.get(OWNER) || 0, 0, 'квота не списана');
    assert.equal(byMethod(calls, 'sendMessage').filter((c) => String(c.payload.chat_id) === PEER).length, before);

    // Разблокирован — ИИ снова отвечает.
    store.settings.clear();
    userSettingsCache.clear();
    await send(bot, businessUpdate(PEER, peerUser(PEER), { text: 'ау' }));
    assert.equal(gem.calls, 1);
  });
});
