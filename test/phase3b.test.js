import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Окружение — ДО импорта src/ (см. phase3.test.js). DATABASE_URL пустой — БД мокается ниже.
process.env.BOT_TOKEN = '123456:TEST-TOKEN';
process.env.ADMIN_IDS = '111';
process.env.DISCUSSION_GROUP_ID = '-1009990001';
process.env.TARGET_CHANNEL_ID = '';
process.env.DATABASE_URL = '';

const {
  parseDotCommand, switchLayout, parseDurationMs, safeCalc, extractMessageSummary, formatSenderName
} = await import('../src/services/dotUtils.js');
const { isIgnorableTelegramError } = await import('../src/services/broadcast.js');
const {
  queueBusinessDelete, deleteBusinessNow, markBotDeleted, isBotDeleted, flushQueue, stopDeleteQueue
} = await import('../src/services/deleteQueue.js');
const { db, DEFAULT_USER_SETTINGS, NO_RETRY } = await import('../src/db/index.js');
const { createBot, stopCacheCleanup } = await import('../src/bot/index.js');
const {
  getChatRule, setChatRuleInCache, clearChatRulesCache, connectionMeta, userSettingsCache, loadBotState
} = await import('../src/bot/state.js');

after(() => stopCacheCleanup());

// ======================= Чистые функции =======================

describe('parseDotCommand', () => {
  test('команды и аргументы', () => {
    assert.deepEqual(parseDotCommand('.mute'), { command: 'mute', args: '', raw: '.mute' });
    assert.deepEqual(parseDotCommand('  .DEL 5 '), { command: 'del', args: '5', raw: '.DEL 5' });
    assert.deepEqual(parseDotCommand('.burn 30s секрет и ещё'), { command: 'burn', args: '30s секрет и ещё', raw: '.burn 30s секрет и ещё' });
    assert.equal(parseDotCommand('.чтото').command, 'чтото');
  });

  test('не команды: многоточие, обычный текст, точка с пробелом', () => {
    for (const t of ['..', '...', '...ну да', '..mute', 'привет', '. mute', '.', '.5', '', null, undefined, 42]) {
      assert.equal(parseDotCommand(t), null, String(t));
    }
  });
});

describe('switchLayout', () => {
  test('EN -> RU и RU -> EN по преобладающему алфавиту', () => {
    assert.equal(switchLayout('ghbdtn'), 'привет');
    assert.equal(switchLayout('Ghbdtn? rfr ltkf'), 'Привет, как дела');
    assert.equal(switchLayout('руддщ'), 'hello');
    assert.equal(switchLayout('Руддщ цщкдв'), 'Hello world');
  });

  test('без букв и пустая строка — без изменений', () => {
    assert.equal(switchLayout('123 !'), '123 !');
    assert.equal(switchLayout(''), '');
    assert.equal(switchLayout(null), '');
  });
});

describe('parseDurationMs', () => {
  test('единицы EN/RU и секунды по умолчанию', () => {
    assert.equal(parseDurationMs('30s'), 30_000);
    assert.equal(parseDurationMs('2m'), 120_000);
    assert.equal(parseDurationMs('30с'), 30_000);
    assert.equal(parseDurationMs('5м'), 300_000);
    assert.equal(parseDurationMs('45'), 45_000);
    assert.equal(parseDurationMs('1,5m'), 90_000);
  });

  test('зажим в [minMs, maxMs]', () => {
    assert.equal(parseDurationMs('1s'), 3000);
    assert.equal(parseDurationMs('1h'), 600_000);
    assert.equal(parseDurationMs('1h', { maxMs: 7_200_000 }), 3_600_000);
  });

  test('мусор -> null', () => {
    for (const t of ['', 'abc', '10x', '0s', '-5s', 's', null]) assert.equal(parseDurationMs(t), null, String(t));
  });
});

describe('safeCalc', () => {
  test('приоритеты, скобки, степень, остаток, унарный минус', () => {
    assert.equal(safeCalc('2+2*2'), 6);
    assert.equal(safeCalc('(2+2)*2'), 8);
    assert.equal(safeCalc('2^3^2'), 512);
    assert.equal(safeCalc('-2^2'), -4);
    assert.equal(safeCalc('10 % 3'), 1);
    assert.equal(safeCalc('-(3 - 5) * 1,5'), 3);
    assert.equal(safeCalc('0.1 + 0.2'), 0.3);
    assert.equal(safeCalc('7 / 2'), 3.5);
  });

  test('ошибки: деление на 0, переполнение, мусор, инъекции', () => {
    assert.throws(() => safeCalc('1/0'), /Деление на ноль/);
    assert.throws(() => safeCalc('5 % 0'), /Деление на ноль/);
    assert.throws(() => safeCalc('10^1000'), /Переполнение/);
    assert.throws(() => safeCalc('2+'), /конец/);
    assert.throws(() => safeCalc('(1+2'), /скобка/);
    assert.throws(() => safeCalc('1 2'), /Неожиданный/);
    assert.throws(() => safeCalc('process.exit()'), /Недопустимый символ/);
    assert.throws(() => safeCalc(''), /Пустое/);
    assert.throws(() => safeCalc('('.repeat(150) + '1' + ')'.repeat(49)), /./);
    assert.throws(() => safeCalc('1+'.repeat(150) + '1'), /длинное/);
  });
});

describe('extractMessageSummary / formatSenderName', () => {
  test('типы сообщений', () => {
    assert.deepEqual(extractMessageSummary({ text: 'привет' }), { msgType: 'text', content: 'привет' });
    assert.deepEqual(extractMessageSummary({ photo: [{}], caption: 'море' }), { msgType: 'photo', content: '[Фото] море' });
    assert.deepEqual(extractMessageSummary({ voice: { duration: 7 } }), { msgType: 'voice', content: '[Голосовое 0:07]' });
    assert.deepEqual(extractMessageSummary({ video_note: { duration: 75 } }), { msgType: 'video_note', content: '[Кружок 1:15]' });
    assert.deepEqual(extractMessageSummary({ sticker: { emoji: '😀' } }), { msgType: 'sticker', content: '[Стикер 😀]' });
    assert.deepEqual(extractMessageSummary({ animation: {}, document: {} }), { msgType: 'animation', content: '[GIF]' });
    assert.deepEqual(extractMessageSummary({ document: { file_name: 'a.pdf' }, caption: 'док' }), { msgType: 'document', content: '[Документ: a.pdf] док' });
    assert.equal(extractMessageSummary({ new_chat_title: 'x' }).msgType, 'other');
    assert.equal(extractMessageSummary({ text: 'я'.repeat(5000) }).content.length, 4000);
  });

  test('имя отправителя', () => {
    assert.equal(formatSenderName({ id: 1, first_name: 'Анна', last_name: 'К' }), 'Анна К');
    assert.equal(formatSenderName({ id: 1, username: 'anna' }), '@anna');
    assert.equal(formatSenderName({ id: 1 }), 'ID 1');
    assert.equal(formatSenderName(null), 'Неизвестный');
  });
});

describe('isIgnorableTelegramError', () => {
  test('BUSINESS_PEER_INVALID / BUSINESS_CONNECTION_INVALID — шум', () => {
    assert.equal(isIgnorableTelegramError({ error_code: 400, description: 'Bad Request: BUSINESS_PEER_INVALID' }), true);
    assert.equal(isIgnorableTelegramError({ error_code: 400, description: 'Bad Request: BUSINESS_CONNECTION_INVALID' }), true);
    assert.equal(isIgnorableTelegramError({ error_code: 403 }), true);
    assert.equal(isIgnorableTelegramError({ error_code: 400, description: 'Bad Request: message text is empty' }), false);
  });
});

describe('db фасад', () => {
  test('best-effort операции не ретраятся, anti_delete_enabled по умолчанию true', () => {
    assert.ok(NO_RETRY.has('saveCachedBusinessMessage'));
    assert.ok(NO_RETRY.has('pruneOldBusinessMessages'));
    assert.equal(DEFAULT_USER_SETTINGS.anti_delete_enabled, true);
    for (const m of ['upsertBusinessConnection', 'getBusinessConnection', 'setChatRule', 'getAllActiveChatRules',
      'saveCachedBusinessMessage', 'getCachedBusinessMessages', 'getRecentCachedMessageIds', 'pruneOldBusinessMessages',
      'setAntiDeleteEnabled']) {
      assert.equal(typeof db[m], 'function', m);
    }
  });
});

// ======================= deleteQueue =======================

function fakeApi() {
  const calls = [];
  return {
    calls,
    deleteBusinessMessages: async (connectionId, ids) => {
      calls.push({ connectionId, ids: [...ids] });
      return true;
    }
  };
}

describe('deleteQueue', () => {
  beforeEach(() => stopDeleteQueue());

  test('3 вызова за окно склеиваются в один deleteBusinessMessages; ID помечены как удалённые ботом', async () => {
    const api = fakeApi();
    queueBusinessDelete(api, 'c1', [1], null, 30);
    queueBusinessDelete(api, 'c1', [2, 2], null, 30);
    const done = queueBusinessDelete(api, 'c1', [3], null, 30);
    assert.equal(api.calls.length, 0, 'до истечения окна вызовов нет');
    assert.ok(isBotDeleted('c1', 2));
    await done;
    assert.deepEqual(api.calls, [{ connectionId: 'c1', ids: [1, 2, 3] }]);
    assert.ok(isBotDeleted('c1', 1) && isBotDeleted('c1', 3));
    assert.equal(isBotDeleted('c1', 4), false);
    assert.equal(isBotDeleted('c2', 1), false, 'пометки изолированы по connectionId');
  });

  test('100 ID — немедленный сброс пачки; разные подключения — разные пачки', async () => {
    const api = fakeApi();
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    await queueBusinessDelete(api, 'c1', ids, null, 10_000);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].ids.length, 100);
    queueBusinessDelete(api, 'a', [1], null, 10_000);
    queueBusinessDelete(api, 'b', [1], null, 10_000);
    await Promise.all([flushQueue('a'), flushQueue('b')]);
    assert.deepEqual(api.calls.slice(1).map((c) => c.connectionId).sort(), ['a', 'b']);
  });

  test('deleteBusinessNow: чанки по 100 и пометка', async () => {
    const api = fakeApi();
    const n = await deleteBusinessNow(api, 'c9', Array.from({ length: 250 }, (_, i) => i + 1));
    assert.equal(n, 250);
    assert.deepEqual(api.calls.map((c) => c.ids.length), [100, 100, 50]);
    assert.ok(isBotDeleted('c9', 250));
  });

  test('ошибка пачки -> onError, промис не reject-ится', async () => {
    const errors = [];
    const api = { deleteBusinessMessages: async () => { throw Object.assign(new Error('x'), { description: 'MESSAGE_DELETE_FORBIDDEN' }); } };
    await queueBusinessDelete(api, 'c1', [5], (err, ids) => errors.push([err.description, ids]), 5);
    assert.deepEqual(errors, [['MESSAGE_DELETE_FORBIDDEN', [5]]]);
  });

  test('markBotDeleted вручную', () => {
    markBotDeleted('c1', [77]);
    assert.ok(isBotDeleted('c1', 77));
    stopDeleteQueue();
    assert.equal(isBotDeleted('c1', 77), false);
  });
});

// ======================= Интеграция: бот + мок БД + мок Bot API =======================

const OWNER = '555';
const CONN = 'conn-555';

// In-memory мок репозиториев (подменяем методы фасада db).
const store = { connections: new Map(), rules: new Map(), messages: new Map(), settings: new Map(), sqlOnHotPath: 0 };
const msgKey = (c, chat, id) => `${c}:${chat}:${Number(id)}`;
Object.assign(db, {
  saveErrorLog: async () => {},
  upsertBusinessConnection: async (info) => { store.connections.set(info.connectionId, { ...info }); },
  getBusinessConnection: async (id) => store.connections.get(id) || null,
  setChatRule: async (ownerId, chatId, patch) => {
    const k = `${ownerId}:${chatId}`;
    const cur = store.rules.get(k) || { isMuted: false, deleteStickersGifs: false };
    const next = {
      isMuted: typeof patch.isMuted === 'boolean' ? patch.isMuted : cur.isMuted,
      deleteStickersGifs: typeof patch.deleteStickersGifs === 'boolean' ? patch.deleteStickersGifs : cur.deleteStickersGifs
    };
    store.rules.set(k, next);
    return next;
  },
  getAllActiveChatRules: async () => {
    store.sqlOnHotPath++;
    return [...store.rules].filter(([, r]) => r.isMuted || r.deleteStickersGifs)
      .map(([k, r]) => ({ ownerId: k.split(':')[0], chatId: k.split(':')[1], ...r }));
  },
  saveCachedBusinessMessage: async (m) => {
    store.messages.set(msgKey(m.connectionId, m.chatId, m.messageId), {
      message_id: Number(m.messageId), owner_id: m.ownerId, sender_id: m.senderId, sender_name: m.senderName,
      sender_username: m.senderUsername, msg_type: m.msgType, content: m.content
    });
  },
  getCachedBusinessMessages: async (c, chat, ids) => ids.map((id) => store.messages.get(msgKey(c, chat, id))).filter(Boolean),
  getRecentCachedMessageIds: async (c, chat, limit, { beforeMessageId, senderId } = {}) =>
    [...store.messages].filter(([k, m]) => k.startsWith(`${c}:${chat}:`) &&
      (!beforeMessageId || m.message_id < beforeMessageId) && (!senderId || m.sender_id === senderId))
      .map(([, m]) => m.message_id).sort((a, b) => b - a).slice(0, limit),
  pruneOldBusinessMessages: async () => 0,
  getBotState: async () => null,
  getUserSettings: async (userId) => ({ ...DEFAULT_USER_SETTINGS, ...(store.settings.get(userId) || {}) }),
  setAntiDeleteEnabled: async (userId, enabled) => {
    store.settings.set(userId, { ...(store.settings.get(userId) || {}), anti_delete_enabled: enabled });
  }
});

const botInfo = {
  id: 123456, is_bot: true, first_name: 'Kaguya Test', username: 'kaguya_test_bot',
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false
};

function makeBot() {
  const bot = createBot('123456:TEST-TOKEN', { botInfo });
  const calls = [];
  let nextId = 10_000;
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getBusinessConnection') {
      return { ok: false, error_code: 400, description: 'Bad Request: BUSINESS_CONNECTION_INVALID' };
    }
    const result = method.startsWith('send') ? { message_id: nextId++, date: 0, chat: { id: payload.chat_id } } : true;
    return { ok: true, result };
  });
  return { bot, calls };
}

let updateId = 1;
let messageId = 1000;
const peerUser = (id) => ({ id: Number(id), is_bot: false, first_name: 'Пётр', username: `peer${id}` });
const ownerUser = { id: Number(OWNER), is_bot: false, first_name: 'Owner' };
const privateChat = (peerId) => ({ id: Number(peerId), type: 'private', first_name: 'Пётр', username: `peer${peerId}` });

function businessMsg(peerId, from, extra = {}) {
  const id = ++messageId;
  return {
    id,
    update: {
      update_id: updateId++,
      business_message: {
        message_id: id, business_connection_id: CONN, date: Math.floor(Date.now() / 1000),
        chat: privateChat(peerId), from, ...extra
      }
    }
  };
}

function connectionUpdate({ canDeleteAll = true } = {}) {
  return {
    update_id: updateId++,
    business_connection: {
      id: CONN, user: ownerUser, user_chat_id: Number(OWNER), date: 0, is_enabled: true,
      rights: { can_reply: true, can_delete_sent_messages: true, can_delete_all_messages: canDeleteAll }
    }
  };
}

const deletes = (calls) => calls.filter((c) => c.method === 'deleteBusinessMessages').flatMap((c) => c.payload.message_ids);
const sentTo = (calls, chatId) => calls.filter((c) => c.method.startsWith('send') && String(c.payload.chat_id) === String(chatId));

describe('Business: .команды, мут, анти-удаление', () => {
  beforeEach(() => {
    stopDeleteQueue();
    clearChatRulesCache();
    connectionMeta.clear();
    userSettingsCache.clear();
    store.rules.clear();
  });

  test('business_connection сохраняет права (rights.*) в БД и connectionMeta', async () => {
    const { bot } = makeBot();
    await bot.handleUpdate(connectionUpdate({ canDeleteAll: false }));
    assert.deepEqual(connectionMeta.get(CONN), {
      ownerId: OWNER, userChatId: OWNER, canReply: true, canDeleteSent: true, canDeleteAll: false, isEnabled: true
    });
    assert.equal(store.connections.get(CONN).canDeleteAll, false);

    // Старый Bot API: can_reply на верхнем уровне, rights нет.
    await bot.handleUpdate({
      update_id: updateId++,
      business_connection: { id: CONN, user: ownerUser, user_chat_id: Number(OWNER), date: 0, can_reply: true, is_enabled: true }
    });
    assert.equal(connectionMeta.get(CONN).canReply, true);
    assert.equal(connectionMeta.get(CONN).canDeleteAll, false);
  });

  test('.mute: мут включён, входящее уходит в deleteBusinessMessages без автоответа; .unmute снимает', async () => {
    const PEER = 7001;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate());

    const mute = businessMsg(PEER, ownerUser, { text: '.mute' });
    await bot.handleUpdate(mute.update);
    assert.deepEqual(getChatRule(OWNER, String(PEER)), { isMuted: true, deleteStickersGifs: false });
    assert.deepEqual(store.rules.get(`${OWNER}:${PEER}`), { isMuted: true, deleteStickersGifs: false });
    assert.ok(deletes(calls).includes(mute.id), 'триггер .mute удалён');
    const dm = sentTo(calls, OWNER);
    assert.equal(dm.length, 1);
    assert.match(dm[0].payload.text, /🔇 Мут включён для диалога/);
    assert.equal(sentTo(calls, PEER).length, 0, 'в чат собеседника ничего не отправлено');
    assert.ok(!store.messages.has(msgKey(CONN, PEER, mute.id)), 'команда не кэшируется');

    // Горячий путь: 0 SQL (правила из памяти).
    const before = store.sqlOnHotPath;
    const m1 = businessMsg(PEER, peerUser(PEER), { text: 'спам 1' });
    const m2 = businessMsg(PEER, peerUser(PEER), { text: 'спам 2' });
    await bot.handleUpdate(m1.update);
    await bot.handleUpdate(m2.update);
    assert.equal(store.sqlOnHotPath, before);
    await flushQueue(CONN);
    const batch = calls.filter((c) => c.method === 'deleteBusinessMessages').at(-1);
    assert.deepEqual(batch.payload.message_ids, [m1.id, m2.id], 'одна пачка на два сообщения');
    assert.equal(sentTo(calls, PEER).length, 0, 'замученному автоответ НЕ отправлен');
    assert.ok(isBotDeleted(CONN, m1.id));

    const unmute = businessMsg(PEER, ownerUser, { text: '.unmute' });
    await bot.handleUpdate(unmute.update);
    assert.equal(getChatRule(OWNER, String(PEER)), null);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /Мут снят/);

    const m3 = businessMsg(PEER, peerUser(PEER), { text: 'теперь можно?' });
    await bot.handleUpdate(m3.update);
    assert.equal(sentTo(calls, PEER).length, 1, 'после .unmute автоответ снова работает');
    assert.ok(!deletes(calls).includes(m3.id));
  });

  test('.mute без права can_delete_all_messages — инструкция владельцу', async () => {
    const PEER = 7002;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate({ canDeleteAll: false }));
    await bot.handleUpdate(businessMsg(PEER, ownerUser, { text: '.mute' }).update);
    const dm = sentTo(calls, OWNER);
    assert.equal(dm.length, 1);
    assert.match(dm[0].payload.text, /Удаление всех сообщений/);
    assert.match(dm[0].payload.text, /Telegram Business → Чат-боты → @Kaguya_2_0bot/);
  });

  test('.wsag удаляет стикер и GIF, но пропускает обычный текст', async () => {
    const PEER = 7003;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate());
    await bot.handleUpdate(businessMsg(PEER, ownerUser, { text: '.wsag' }).update);
    assert.deepEqual(getChatRule(OWNER, String(PEER)), { isMuted: false, deleteStickersGifs: true });

    const sticker = businessMsg(PEER, peerUser(PEER), { sticker: { file_id: 's', file_unique_id: 's', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false, emoji: '😀' } });
    const gif = businessMsg(PEER, peerUser(PEER), { animation: { file_id: 'g', file_unique_id: 'g', width: 1, height: 1, duration: 1 }, document: { file_id: 'g', file_unique_id: 'g' } });
    const text = businessMsg(PEER, peerUser(PEER), { text: 'обычный текст' });
    await bot.handleUpdate(sticker.update);
    await bot.handleUpdate(gif.update);
    await bot.handleUpdate(text.update);
    await flushQueue(CONN);

    const del = deletes(calls);
    assert.ok(del.includes(sticker.id) && del.includes(gif.id));
    assert.ok(!del.includes(text.id));
    assert.equal(sentTo(calls, PEER).length, 1, 'на текст сработал обычный автоответ');
  });

  test('неизвестная .команда не трогается: без удаления, ставится обычная пауза', async () => {
    const PEER = 7004;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate());
    const unk = businessMsg(PEER, ownerUser, { text: '.чтото непонятное' });
    await bot.handleUpdate(unk.update);
    assert.equal(calls.filter((c) => c.method !== 'getBusinessConnection').length, 0);
    await bot.handleUpdate(businessMsg(PEER, peerUser(PEER), { text: 'привет' }).update);
    assert.equal(sentTo(calls, PEER).length, 0, 'пауза 10 мин после сообщения владельца');
  });

  test('.calc и .sw: триггер удалён, результат — новым сообщением в чат', async () => {
    const PEER = 7005;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate());
    const calc = businessMsg(PEER, ownerUser, { text: '.calc 2*(3+4)' });
    await bot.handleUpdate(calc.update);
    const sw = businessMsg(PEER, ownerUser, { text: '.sw ghbdtn' });
    await bot.handleUpdate(sw.update);
    assert.ok(deletes(calls).includes(calc.id) && deletes(calls).includes(sw.id));
    const out = sentTo(calls, PEER);
    assert.equal(out.length, 2);
    assert.equal(out[0].payload.text, '2*(3+4) = 14');
    assert.equal(out[0].payload.business_connection_id, CONN);
    assert.equal(out[1].payload.text, 'привет');

    await bot.handleUpdate(businessMsg(PEER, ownerUser, { text: '.calc 1/0' }).update);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /Деление на ноль/);
    assert.equal(sentTo(calls, PEER).length, 2, 'ошибка .calc — только в ЛС');
  });

  test('.del N удаляет последние N из кэша; .help и .id — в ЛС', async () => {
    const PEER = 7006;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate());
    const a = businessMsg(PEER, ownerUser, { text: 'моё 1' });
    const b = businessMsg(PEER, ownerUser, { text: 'моё 2' });
    await bot.handleUpdate(a.update);
    await bot.handleUpdate(b.update);
    const del = businessMsg(PEER, ownerUser, { text: '.del 2' });
    await bot.handleUpdate(del.update);
    const ids = calls.filter((c) => c.method === 'deleteBusinessMessages').at(-1).payload.message_ids;
    assert.deepEqual(ids.sort(), [a.id, b.id, del.id].sort());
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /Удалено сообщений: <b>2<\/b>/);

    await bot.handleUpdate(businessMsg(PEER, ownerUser, { text: '.help' }).update);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /\.mute/);
    await bot.handleUpdate(businessMsg(PEER, ownerUser, { text: '.id' }).update);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, new RegExp(`chat_id: <code>${PEER}</code>`));
    assert.equal(sentTo(calls, PEER).length, 0);
  });

  test('.burn: отправляет сообщение и планирует его удаление', async () => {
    const PEER = 7007;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate());
    await bot.handleUpdate(businessMsg(PEER, ownerUser, { text: '.burn 3s секрет' }).update);
    const out = sentTo(calls, PEER);
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.text, 'секрет');
    // Таймер удаления снимается в stopCacheCleanup() (after) — тест не висит 3 сек.
  });

  test('deleted_business_messages: алерт за сообщение собеседника, тишина за удалённое ботом', async () => {
    const PEER = 7008;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate());
    const peerMsg = businessMsg(PEER, peerUser(PEER), { text: 'секретный <текст>' });
    const botDel = businessMsg(PEER, peerUser(PEER), { text: 'удалит бот' });
    await bot.handleUpdate(peerMsg.update);
    await bot.handleUpdate(botDel.update);
    const dmBefore = sentTo(calls, OWNER).length;

    await bot.handleUpdate({
      update_id: updateId++,
      deleted_business_messages: { business_connection_id: CONN, chat: privateChat(PEER), message_ids: [peerMsg.id] }
    });
    const dm = sentTo(calls, OWNER);
    assert.equal(dm.length, dmBefore + 1);
    assert.match(dm.at(-1).payload.text, /Удалено сообщений: 1/);
    assert.match(dm.at(-1).payload.text, /секретный &lt;текст&gt;/, 'экранирование HTML');
    assert.equal(dm.at(-1).payload.parse_mode, 'HTML');

    markBotDeleted(CONN, [botDel.id]);
    await bot.handleUpdate({
      update_id: updateId++,
      deleted_business_messages: { business_connection_id: CONN, chat: privateChat(PEER), message_ids: [botDel.id] }
    });
    assert.equal(sentTo(calls, OWNER).length, dmBefore + 1, 'удалённое ботом — без алерта');

    // Анти-удаление выключено -> тишина.
    store.settings.set(OWNER, { anti_delete_enabled: false });
    userSettingsCache.clear();
    const another = businessMsg(PEER, peerUser(PEER), { text: 'ещё' });
    await bot.handleUpdate(another.update);
    const n = sentTo(calls, OWNER).length;
    await bot.handleUpdate({
      update_id: updateId++,
      deleted_business_messages: { business_connection_id: CONN, chat: privateChat(PEER), message_ids: [another.id] }
    });
    assert.equal(sentTo(calls, OWNER).length, n);
    store.settings.delete(OWNER);
  });

  test('edited_business_message: алерт «Было / Стало»', async () => {
    const PEER = 7009;
    const { bot, calls } = makeBot();
    await bot.handleUpdate(connectionUpdate());
    const orig = businessMsg(PEER, peerUser(PEER), { text: 'было так' });
    await bot.handleUpdate(orig.update);
    const edited = { ...orig.update.business_message, text: 'стало иначе', edit_date: Math.floor(Date.now() / 1000) };
    await bot.handleUpdate({ update_id: updateId++, edited_business_message: edited });

    const dm = sentTo(calls, OWNER).at(-1);
    assert.match(dm.payload.text, /Было:<\/b>\nбыло так/);
    assert.match(dm.payload.text, /Стало:<\/b>\nстало иначе/);
    assert.equal(store.messages.get(msgKey(CONN, PEER, orig.id)).content, 'стало иначе', 'кэш обновлён');

    // Повтор того же содержимого (новый edit_date) — без алерта.
    const n = sentTo(calls, OWNER).length;
    await bot.handleUpdate({ update_id: updateId++, edited_business_message: { ...edited, edit_date: edited.edit_date + 1 } });
    assert.equal(sentTo(calls, OWNER).length, n);
  });

  test('loadBotState подгружает активные chat_rules в память', async () => {
    store.rules.set(`${OWNER}:8001`, { isMuted: true, deleteStickersGifs: false });
    store.rules.set(`${OWNER}:8002`, { isMuted: false, deleteStickersGifs: false });
    await loadBotState({ pruning: false });
    assert.deepEqual(getChatRule(OWNER, '8001'), { isMuted: true, deleteStickersGifs: false });
    assert.equal(getChatRule(OWNER, '8002'), null);
    setChatRuleInCache(OWNER, '8001', { isMuted: false });
    assert.equal(getChatRule(OWNER, '8001'), null);
  });
});
