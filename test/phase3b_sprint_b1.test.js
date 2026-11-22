import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Окружение — ДО импорта src/. Gemini "настроен" фиктивным ключом, но fetch всегда замокан (0 сетевых запросов).
const API_KEY = 'TEST-GEMINI-KEY-xyz';
process.env.BOT_TOKEN = '123456:TEST-TOKEN';
process.env.ADMIN_IDS = '111';
process.env.DISCUSSION_GROUP_ID = '';
process.env.TARGET_CHANNEL_ID = '';
process.env.DATABASE_URL = '';
process.env.GEMINI_API_KEY = API_KEY;
process.env.GEMINI_MODEL = 'gemini-2.5-flash';
process.env.AI_DAILY_LIMIT = '25';

const { config, loadConfig } = await import('../src/config.js');
const {
  generateGeminiText, consumeAiQuota, isGeminiConfigured, waitAiTasks, GeminiError,
  buildAiPrompt, buildDialogAnalysisPrompt, buildAutoAiPrompt, buildKawaiiPrompt
} = await import('../src/services/gemini.js');
const { BUILTIN_RP, MAX_CUSTOM_RP, normalizeRpTrigger, formatRpMessage, getBuiltinRp } = await import('../src/services/rp.js');
const { parseDotCommand } = await import('../src/services/dotUtils.js');
const { HELP_TEXT, isKnownDotCommand } = await import('../src/handlers/dotCommands.js');
const { clearAiState, clearAutoAiCooldowns, isKawaiiCandidate } = await import('../src/handlers/aiCommands.js');
const { MIGRATIONS } = await import('../src/db/migrations.js');
const { db, DEFAULT_USER_SETTINGS, NO_RETRY } = await import('../src/db/index.js');
const { createBot, stopCacheCleanup } = await import('../src/bot/index.js');
const {
  getChatRule, setChatRuleInCache, clearChatRulesCache, connectionMeta, userSettingsCache, customRpCache,
  getOwnerCustomRp, invalidateOwnerCustomRp, loadBotState
} = await import('../src/bot/state.js');
const { stopDeleteQueue } = await import('../src/services/deleteQueue.js');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  stopCacheCleanup();
});

// --- Мок fetch Gemini ---
function geminiOk(text) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
}
function geminiErr(status, statusText = 'ERR') {
  return { ok: false, status, json: async () => ({ error: { code: status, status: statusText, message: 'x' } }) };
}
// Ответ по умолчанию для интеграционных тестов; replies — очередь ответов (функций или объектов).
const gem = { calls: [], replies: [] };
function installFetch() {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    gem.calls.push({ url, init, body });
    const next = gem.replies.shift();
    if (typeof next === 'function') return next(url, init, body);
    return next || geminiOk('ответ ИИ');
  };
}
installFetch();

const cfgKey = { geminiApiKey: API_KEY, geminiModel: 'gemini-2.5-flash', adminIds: ['111'], aiDailyLimit: 2 };

// ======================= config / миграция =======================

describe('config и миграция 005', () => {
  test('GEMINI_* и AI_DAILY_LIMIT', () => {
    assert.equal(config.geminiApiKey, API_KEY);
    assert.equal(config.geminiModel, 'gemini-2.5-flash');
    assert.equal(config.aiDailyLimit, 25);
    const d = loadConfig({});
    assert.equal(d.geminiApiKey, '');
    assert.equal(d.geminiModel, 'gemini-2.5-flash');
    assert.equal(d.aiDailyLimit, 25);
    assert.equal(loadConfig({ AI_DAILY_LIMIT: ' 7 ', GEMINI_API_KEY: ' k ', GEMINI_MODEL: ' m ' }).aiDailyLimit, 7);
    assert.equal(loadConfig({ GEMINI_API_KEY: ' k ' }).geminiApiKey, 'k');
    for (const bad of ['0', '-3', 'abc', '2.5']) assert.equal(loadConfig({ AI_DAILY_LIMIT: bad }).aiDailyLimit, 25, bad);
    assert.equal(isGeminiConfigured({ geminiApiKey: '' }), false);
    assert.equal(isGeminiConfigured(cfgKey), true);
  });

  test('005 идемпотентна: только IF NOT EXISTS, без DROP/RENAME', async () => {
    const m = MIGRATIONS.find((x) => x.version === '005');
    assert.equal(m.name, 'phase3b_ai_rp');
    const queries = [];
    await m.up((strings) => { queries.push(strings.join('$').replace(/\s+/g, ' ').trim()); return Promise.resolve([]); });
    const all = queries.join('\n');
    for (const q of queries) {
      assert.match(q, /IF NOT EXISTS/, q);
      assert.doesNotMatch(q, /\b(DROP|RENAME)\b/i, q);
    }
    assert.ok(all.includes('ADD COLUMN IF NOT EXISTS auto_ai_prompt TEXT'));
    assert.ok(all.includes('ADD COLUMN IF NOT EXISTS kawaii_enabled BOOLEAN DEFAULT false'));
    assert.ok(all.includes('CREATE TABLE IF NOT EXISTS ai_usage'));
    assert.ok(all.includes('PRIMARY KEY (owner_id, usage_date)'));
    assert.ok(all.includes('CREATE TABLE IF NOT EXISTS custom_rp_commands'));
    assert.ok(all.includes('PRIMARY KEY (owner_id, trigger)'));
  });

  test('db фасад: новые методы, incrementAiUsage не ретраится', () => {
    for (const name of ['getRecentCachedMessages', 'getAiUsageToday', 'incrementAiUsage', 'listCustomRp', 'upsertCustomRp', 'deleteCustomRp']) {
      assert.equal(typeof db[name], 'function', name);
    }
    assert.ok(NO_RETRY.has('incrementAiUsage'));
  });
});

// ======================= generateGeminiText =======================

describe('generateGeminiText', () => {
  test('ключ только в заголовке x-goog-api-key, не в URL; тело и извлечение текста', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init }; return geminiOk('  привет  '); };
    const text = await generateGeminiText({ systemPrompt: 'sys', userPrompt: 'вопрос', temperature: 0.3, maxOutputTokens: 100, cfg: cfgKey, fetchImpl });
    assert.equal(text, 'привет');
    assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.ok(!seen.url.includes(API_KEY), 'ключа нет в URL');
    assert.ok(!seen.url.includes('key='));
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers['x-goog-api-key'], API_KEY);
    assert.equal(seen.init.headers['Content-Type'], 'application/json');
    assert.ok(seen.init.signal instanceof AbortSignal);
    const body = JSON.parse(seen.init.body);
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'вопрос' }] }]);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] });
    assert.equal(body.generationConfig.temperature, 0.3);
    assert.equal(body.generationConfig.maxOutputTokens, 100);
  });

  test('без systemPrompt — без systemInstruction; мысли отбрасываются; обрезка до 3800', async () => {
    let body;
    const long = 'я'.repeat(5000);
    const fetchImpl = async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'мысль', thought: true }, { text: long }] } }] }) };
    };
    const text = await generateGeminiText({ userPrompt: 'q', cfg: cfgKey, fetchImpl });
    assert.equal(body.systemInstruction, undefined);
    assert.equal(text.length, 3800);
    assert.ok(!text.includes('мысль'));
  });

  test('HTTP 429 / 500 -> GeminiError без ключа в тексте', async () => {
    for (const status of [429, 500]) {
      await assert.rejects(
        generateGeminiText({ userPrompt: 'q', cfg: cfgKey, fetchImpl: async () => geminiErr(status, `KEY ${API_KEY}`) }),
        (e) => {
          assert.ok(e instanceof GeminiError);
          assert.equal(e.code, 'HTTP');
          assert.equal(e.status, status);
          assert.match(e.message, new RegExp(`HTTP ${status}`));
          assert.ok(!e.message.includes(API_KEY), 'ключ не утёк в сообщение');
          return true;
        }
      );
    }
  });

  test('таймаут через AbortController', async () => {
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const started = Date.now();
    await assert.rejects(generateGeminiText({ userPrompt: 'q', timeoutMs: 30, cfg: cfgKey, fetchImpl }), (e) => e.code === 'TIMEOUT');
    assert.ok(Date.now() - started < 2000);
  });

  test('пустой ответ, сетевая ошибка, ключ не задан', async () => {
    await assert.rejects(
      generateGeminiText({ userPrompt: 'q', cfg: cfgKey, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }) }) }),
      (e) => e.code === 'EMPTY' && /SAFETY/.test(e.message)
    );
    await assert.rejects(
      generateGeminiText({ userPrompt: 'q', cfg: cfgKey, fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
      (e) => e.code === 'NETWORK'
    );
    let called = false;
    await assert.rejects(
      generateGeminiText({ userPrompt: 'q', cfg: { ...cfgKey, geminiApiKey: '' }, fetchImpl: async () => { called = true; } }),
      (e) => e.code === 'NOT_CONFIGURED'
    );
    assert.equal(called, false);
  });
});

// ======================= consumeAiQuota =======================

describe('consumeAiQuota', () => {
  function quotaDb() {
    const usage = new Map();
    return {
      usage,
      getAiUsageToday: async (id) => usage.get(id) || 0,
      incrementAiUsage: async (id) => { usage.set(id, (usage.get(id) || 0) + 1); return usage.get(id); }
    };
  }

  test('обычный пользователь блокируется после лимита', async () => {
    const dbImpl = quotaDb();
    assert.deepEqual(await consumeAiQuota('222', { cfg: cfgKey, dbImpl }), { allowed: true, used: 1, limit: 2 });
    assert.deepEqual(await consumeAiQuota('222', { cfg: cfgKey, dbImpl }), { allowed: true, used: 2, limit: 2 });
    assert.deepEqual(await consumeAiQuota('222', { cfg: cfgKey, dbImpl }), { allowed: false, used: 2, limit: 2 });
    assert.equal(dbImpl.usage.get('222'), 2, 'отказ не списывает квоту');
  });

  test('админ — без лимита и без обращений к БД', async () => {
    const dbImpl = { getAiUsageToday: async () => { throw new Error('не должно вызываться'); }, incrementAiUsage: async () => { throw new Error('x'); } };
    for (let i = 0; i < 5; i++) assert.deepEqual(await consumeAiQuota(111, { cfg: cfgKey, dbImpl }), { allowed: true, unlimited: true });
  });
});

// ======================= Промпты и RP (чистые функции) =======================

describe('промпт-билдеры', () => {
  test('buildAiPrompt объединяет контекст и вопрос', () => {
    assert.equal(buildAiPrompt('что это?', '').userPrompt, 'что это?');
    assert.match(buildAiPrompt('', 'текст reply').userPrompt, /текст reply/);
    const both = buildAiPrompt('переведи', 'hello');
    assert.match(both.userPrompt, /hello/);
    assert.match(both.userPrompt, /переведи/);
    assert.match(both.systemPrompt, /кратко/i);
  });

  test('buildDialogAnalysisPrompt / buildAutoAiPrompt / buildKawaiiPrompt', () => {
    const msgs = [
      { sender_id: '555', sender_name: 'Owner', content: 'привет' },
      { sender_id: '9', sender_name: 'Пётр', content: 'ну привет' }
    ];
    const d = buildDialogAnalysisPrompt(msgs, '555');
    assert.match(d.userPrompt, /Я: привет\nПётр: ну привет/);
    assert.match(d.userPrompt, /Тон/);
    assert.match(d.userPrompt, /мотив/);
    assert.match(d.userPrompt, /вовлечённ/);
    assert.match(d.userPrompt, /совет/);

    const a = buildAutoAiPrompt('скажи что я занят', msgs, 'ты где?', '555');
    assert.match(a.systemPrompt, /скажи что я занят/);
    assert.match(a.systemPrompt, /1–3 предложения/);
    assert.match(a.systemPrompt, /не признавайся, что ты ИИ/i);
    assert.match(a.userPrompt, /ты где\?/);

    const k = buildKawaiiPrompt('я дома');
    assert.equal(k.userPrompt, 'я дома');
    assert.match(k.systemPrompt, /каомодзи/);
    assert.match(k.systemPrompt, /смысл/);
  });
});

describe('RP: словарь, триггеры, форматирование', () => {
  test('минимум 16 встроенных глаголов', () => {
    for (const v of ['обнять', 'поцеловать', 'ударить', 'укусить', 'кусь', 'погладить', 'лизнуть', 'пнуть', 'шлепнуть',
      'пожать', 'покормить', 'напоить', 'укрыть', 'поздравить', 'успокоить', 'испугать']) {
      assert.ok(BUILTIN_RP[v]?.emoji && BUILTIN_RP[v]?.verb, v);
    }
    assert.equal(BUILTIN_RP['обнять'].verb, 'обнял(а)');
    assert.equal(getBuiltinRp('шлёпнуть'), BUILTIN_RP['шлепнуть']);
    assert.equal(MAX_CUSTOM_RP, 3);
  });

  test('normalizeRpTrigger', () => {
    assert.equal(normalizeRpTrigger('.Обнимашки'), 'обнимашки');
    assert.equal(normalizeRpTrigger('hug_2'), 'hug_2');
    for (const bad of ['.', '.a', 'с пробелом', '.x!', 'a'.repeat(31), '', null, '.2pac']) assert.equal(normalizeRpTrigger(bad), null, String(bad));
    assert.deepEqual(parseDotCommand('.hug_2 привет'), { command: 'hug_2', args: 'привет', raw: '.hug_2 привет' });
  });

  test('formatRpMessage экранирует HTML', () => {
    assert.equal(
      formatRpMessage({ emoji: '🫂', actorName: 'Эрмек', targetName: 'Алихан', actionText: 'обнял(а)' }),
      '🫂 <b>Эрмек</b> обнял(а) <b>Алихан</b>'
    );
    assert.equal(
      formatRpMessage({ emoji: '🫂', actorName: '<A>', targetName: 'B&C', actionText: 'обнял(а)', comment: 'ты <лучший>' }),
      '🫂 <b>&lt;A&gt;</b> обнял(а) <b>B&amp;C</b>\n💬 <i>«ты &lt;лучший&gt;»</i>'
    );
  });

  test('HELP_TEXT сгруппирован и содержит новые команды', () => {
    for (const s of ['Модерация', 'ИИ (Gemini)', 'Утилиты', 'RP-команды', '.ai', '.autoai', '.unautoai', '.dialog', '.kawaii', '.addrp', '.myrp', '.delrp', '.mute']) {
      assert.ok(HELP_TEXT.includes(s), s);
    }
    assert.ok(HELP_TEXT.length < 4096);
    for (const c of ['mute', 'ai', 'autoai', 'kawaii', 'addrp', 'myrp', 'delrp', 'help']) assert.ok(isKnownDotCommand(c), c);
    assert.equal(isKnownDotCommand('обнять'), false);
  });

  test('isKawaiiCandidate: эхо бота, команды, пустые и длинные — нет', () => {
    assert.equal(isKawaiiCandidate({ text: 'привет' }), true);
    assert.equal(isKawaiiCandidate({ text: 'привет', sender_business_bot: { id: 1 } }), false);
    assert.equal(isKawaiiCandidate({ text: '.mute' }), false);
    assert.equal(isKawaiiCandidate({ text: '   ' }), false);
    assert.equal(isKawaiiCandidate({ text: 'я'.repeat(501) }), false);
    assert.equal(isKawaiiCandidate({ text: 'я'.repeat(500) }), true);
    assert.equal(isKawaiiCandidate({ sticker: {} }), false);
    assert.equal(isKawaiiCandidate({ caption: 'подпись' }), false);
  });
});

// ======================= Кэш правил и кастомных RP =======================

describe('state: chatRules (4 поля) и customRpCache', () => {
  beforeEach(() => clearChatRulesCache());

  test('autoAiPrompt: undefined не меняет, null сбрасывает; неактивное правило удаляется', () => {
    setChatRuleInCache('1', '2', { autoAiPrompt: 'будь вежлив' });
    assert.deepEqual(getChatRule('1', '2'), { isMuted: false, deleteStickersGifs: false, autoAiPrompt: 'будь вежлив', kawaiiEnabled: false });
    setChatRuleInCache('1', '2', { kawaiiEnabled: true, autoAiPrompt: undefined });
    assert.equal(getChatRule('1', '2').autoAiPrompt, 'будь вежлив');
    assert.equal(getChatRule('1', '2').kawaiiEnabled, true);
    setChatRuleInCache('1', '2', { autoAiPrompt: null });
    assert.equal(getChatRule('1', '2').autoAiPrompt, null);
    setChatRuleInCache('1', '2', { kawaiiEnabled: false });
    assert.equal(getChatRule('1', '2'), null);
  });

  test('getOwnerCustomRp: кэш на 10 мин, инвалидация', async () => {
    let loads = 0;
    const orig = db.listCustomRp;
    db.listCustomRp = async () => { loads++; return [{ trigger: 'hug', action_text: 'обнял', media_file_id: null, media_type: null }]; };
    try {
      customRpCache.clear();
      assert.equal((await getOwnerCustomRp('42')).get('hug').action_text, 'обнял');
      await getOwnerCustomRp('42');
      assert.equal(loads, 1);
      assert.equal(customRpCache.maxSize, 2000);
      assert.equal(customRpCache.ttlMs, 10 * 60 * 1000);
      invalidateOwnerCustomRp('42');
      await getOwnerCustomRp('42');
      assert.equal(loads, 2);
    } finally {
      db.listCustomRp = orig;
      customRpCache.clear();
    }
  });
});

// ======================= Интеграция: бот + мок БД + мок Bot API + мок fetch =======================

const OWNER = '555';
const ADMIN_OWNER = '111';
const CONN = 'conn-b1';
const CONN_ADMIN = 'conn-b1-admin';

const store = { connections: new Map(), rules: new Map(), messages: new Map(), usage: new Map(), rp: new Map() };
const msgKey = (c, chat, id) => `${c}:${chat}:${Number(id)}`;
const rpOf = (ownerId) => {
  if (!store.rp.has(ownerId)) store.rp.set(ownerId, new Map());
  return store.rp.get(ownerId);
};

Object.assign(db, {
  saveErrorLog: async () => {},
  upsertBusinessConnection: async (info) => { store.connections.set(info.connectionId, { ...info }); },
  getBusinessConnection: async (id) => store.connections.get(id) || null,
  setChatRule: async (ownerId, chatId, patch) => {
    const k = `${ownerId}:${chatId}`;
    const cur = store.rules.get(k) || { isMuted: false, deleteStickersGifs: false, autoAiPrompt: null, kawaiiEnabled: false };
    const next = {
      isMuted: typeof patch.isMuted === 'boolean' ? patch.isMuted : cur.isMuted,
      deleteStickersGifs: typeof patch.deleteStickersGifs === 'boolean' ? patch.deleteStickersGifs : cur.deleteStickersGifs,
      autoAiPrompt: patch.autoAiPrompt === undefined ? cur.autoAiPrompt : (patch.autoAiPrompt ? String(patch.autoAiPrompt).slice(0, 500) : null),
      kawaiiEnabled: typeof patch.kawaiiEnabled === 'boolean' ? patch.kawaiiEnabled : cur.kawaiiEnabled
    };
    store.rules.set(k, next);
    return next;
  },
  getAllActiveChatRules: async () => [...store.rules]
    .filter(([, r]) => r.isMuted || r.deleteStickersGifs || r.autoAiPrompt !== null || r.kawaiiEnabled)
    .map(([k, r]) => ({ ownerId: k.split(':')[0], chatId: k.split(':')[1], ...r })),
  saveCachedBusinessMessage: async (m) => {
    store.messages.set(msgKey(m.connectionId, m.chatId, m.messageId), {
      message_id: Number(m.messageId), sender_id: m.senderId, sender_name: m.senderName,
      sender_username: m.senderUsername, msg_type: m.msgType, content: m.content, created_at: new Date()
    });
  },
  getCachedBusinessMessages: async (c, chat, ids) => ids.map((id) => store.messages.get(msgKey(c, chat, id))).filter(Boolean),
  getRecentCachedMessageIds: async () => [],
  getRecentCachedMessages: async (c, chat, limit = 20) => [...store.messages]
    .filter(([k]) => k.startsWith(`${c}:${chat}:`)).map(([, m]) => m)
    .sort((a, b) => a.message_id - b.message_id).slice(-limit),
  pruneOldBusinessMessages: async () => 0,
  getBotState: async () => null,
  getUserSettings: async () => ({ ...DEFAULT_USER_SETTINGS }),
  getAiUsageToday: async (id) => store.usage.get(id) || 0,
  incrementAiUsage: async (id) => { store.usage.set(id, (store.usage.get(id) || 0) + 1); return store.usage.get(id); },
  listCustomRp: async (ownerId) => [...rpOf(String(ownerId)).values()],
  upsertCustomRp: async (ownerId, { trigger, actionText, mediaFileId = null, mediaType = null }) => {
    rpOf(String(ownerId)).set(trigger, { trigger, action_text: actionText, media_file_id: mediaFileId, media_type: mediaType });
  },
  deleteCustomRp: async (ownerId, trigger) => rpOf(String(ownerId)).delete(trigger)
});

const botInfo = {
  id: 123456, is_bot: true, first_name: 'Kaguya Test', username: 'kaguya_test_bot',
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false
};

function makeBot() {
  const bot = createBot('123456:TEST-TOKEN', { botInfo });
  const calls = [];
  let nextId = 90_000;
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
let messageId = 5000;
const peerUser = (id) => ({ id: Number(id), is_bot: false, first_name: 'Алихан', username: `peer${id}` });
const ownerUser = { id: Number(OWNER), is_bot: false, first_name: 'Эрмек' };
const adminUser = { id: Number(ADMIN_OWNER), is_bot: false, first_name: 'Админ' };
const privateChat = (peerId) => ({ id: Number(peerId), type: 'private', first_name: 'Алихан', username: `peer${peerId}` });

function businessMsg(peerId, from, extra = {}, conn = CONN) {
  const id = ++messageId;
  return {
    id,
    message: { message_id: id, business_connection_id: conn, date: Math.floor(Date.now() / 1000), chat: privateChat(peerId), from, ...extra },
    get update() {
      return { update_id: updateId++, business_message: this.message };
    }
  };
}

function connectionUpdate({ conn = CONN, user = ownerUser, canDeleteAll = true, canDeleteSent = true } = {}) {
  return {
    update_id: updateId++,
    business_connection: {
      id: conn, user, user_chat_id: user.id, date: 0, is_enabled: true,
      rights: { can_reply: true, can_delete_sent_messages: canDeleteSent, can_delete_all_messages: canDeleteAll }
    }
  };
}

async function send(bot, update) {
  await bot.handleUpdate(update);
  await waitAiTasks();
}

const deletes = (calls) => calls.filter((c) => c.method === 'deleteBusinessMessages').flatMap((c) => c.payload.message_ids);
const sentTo = (calls, chatId) => calls.filter((c) => c.method.startsWith('send') && String(c.payload.chat_id) === String(chatId));
const ANIM = { file_id: 'GIF-FILE-1', file_unique_id: 'g1', width: 1, height: 1, duration: 1 };

describe('Business: ИИ-команды', () => {
  beforeEach(() => {
    stopDeleteQueue();
    clearChatRulesCache();
    clearAiState();
    connectionMeta.clear();
    userSettingsCache.clear();
    customRpCache.clear();
    store.rules.clear();
    store.messages.clear();
    store.usage.clear();
    store.rp.clear();
    gem.calls.length = 0;
    gem.replies.length = 0;
    installFetch();
  });

  test('.ai вопрос: триггер удалён, ответ Gemini — plain text в чат, квота списана', async () => {
    const PEER = 9101;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    gem.replies.push(geminiOk('Столица Франции — Париж.'));
    const m = businessMsg(PEER, ownerUser, { text: '.ai столица Франции?' });
    await send(bot, m.update);
    assert.ok(deletes(calls).includes(m.id));
    assert.equal(gem.calls.length, 1);
    assert.equal(gem.calls[0].init.headers['x-goog-api-key'], API_KEY);
    assert.ok(!gem.calls[0].url.includes(API_KEY));
    assert.match(gem.calls[0].body.contents[0].parts[0].text, /столица Франции\?/);
    const out = sentTo(calls, PEER);
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.text, 'Столица Франции — Париж.');
    assert.equal(out[0].payload.business_connection_id, CONN);
    assert.equal(out[0].payload.parse_mode, undefined, 'plain text');
    assert.equal(store.usage.get(OWNER), 1);
  });

  test('.ai reply: берёт текст отвеченного сообщения; reply + вопрос — объединяет', async () => {
    const PEER = 9102;
    const { bot } = makeBot();
    await send(bot, connectionUpdate());
    const reply = { message_id: 1, date: 0, chat: privateChat(PEER), from: peerUser(PEER), text: 'how are you?' };
    await send(bot, businessMsg(PEER, ownerUser, { text: '.ai', reply_to_message: reply }).update);
    assert.match(gem.calls[0].body.contents[0].parts[0].text, /how are you\?/);
    await send(bot, businessMsg(PEER, ownerUser, { text: '.ai переведи', reply_to_message: reply }).update);
    const p = gem.calls[1].body.contents[0].parts[0].text;
    assert.match(p, /how are you\?/);
    assert.match(p, /переведи/);
  });

  test('.ai: ошибка Gemini и лимит — только в ЛС владельца, в чат ничего', async () => {
    const PEER = 9103;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    gem.replies.push(geminiErr(500));
    await send(bot, businessMsg(PEER, ownerUser, { text: '.ai вопрос' }).update);
    assert.equal(sentTo(calls, PEER).length, 0);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /HTTP 500/);

    store.usage.set(OWNER, 25);
    const before = gem.calls.length;
    await send(bot, businessMsg(PEER, ownerUser, { text: '.ai ещё вопрос' }).update);
    assert.equal(gem.calls.length, before, 'Gemini не вызывался');
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /лимит ИИ исчерпан: <b>25\/25<\/b>/);
    assert.equal(sentTo(calls, PEER).length, 0);
  });

  test('админ не ограничен дневным лимитом', async () => {
    const PEER = 9104;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate({ conn: CONN_ADMIN, user: adminUser }));
    store.usage.set(ADMIN_OWNER, 999);
    await send(bot, businessMsg(PEER, adminUser, { text: '.ai вопрос' }, CONN_ADMIN).update);
    assert.equal(sentTo(calls, PEER).length, 1);
    assert.equal(store.usage.get(ADMIN_OWNER), 999, 'счётчик админа не трогается');
  });

  test('.dialog: разбор уходит строго в ЛС владельца, не в чат', async () => {
    const PEER = 9105;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    // Мало сообщений -> уведомление без вызова Gemini.
    await send(bot, businessMsg(PEER, ownerUser, { text: '.dialog' }).update);
    assert.equal(gem.calls.length, 0);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /слишком мало/);

    await send(bot, businessMsg(PEER, peerUser(PEER), { text: 'ты где пропал?' }).update);
    await send(bot, businessMsg(PEER, ownerUser, { text: 'работаю' }).update);
    await send(bot, businessMsg(PEER, peerUser(PEER), { text: 'ну ок <3' }).update);
    gem.calls.length = 0;
    const peerSentBefore = sentTo(calls, PEER).length;
    gem.replies.push(geminiOk('Тон: обиженный <немного>'));
    const d = businessMsg(PEER, ownerUser, { text: '.dialog 10' });
    await send(bot, d.update);
    assert.ok(deletes(calls).includes(d.id));
    assert.equal(gem.calls.length, 1);
    const prompt = gem.calls[0].body.contents[0].parts[0].text;
    assert.match(prompt, /Алихан: ты где пропал\?/);
    assert.match(prompt, /Я: работаю/);
    const dm = sentTo(calls, OWNER).at(-1);
    assert.match(dm.payload.text, /Разбор диалога/);
    assert.match(dm.payload.text, /обиженный &lt;немного&gt;/);
    assert.equal(dm.payload.parse_mode, 'HTML');
    assert.equal(sentTo(calls, PEER).length, peerSentBefore, 'в чат собеседника ничего');

    await send(bot, businessMsg(PEER, ownerUser, { text: '.dialog 3' }).update);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /от 5 до 50/);
  });

  test('.autoai: ИИ отвечает собеседнику, статичный автоответ не дублируется, кулдаун 5 с; .unautoai сбрасывает в null', async () => {
    const PEER = 9106;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    const on = businessMsg(PEER, ownerUser, { text: '.autoai отвечай, что я на встрече' });
    await send(bot, on.update);
    assert.ok(deletes(calls).includes(on.id));
    assert.equal(getChatRule(OWNER, String(PEER)).autoAiPrompt, 'отвечай, что я на встрече');
    assert.equal(store.rules.get(`${OWNER}:${PEER}`).autoAiPrompt, 'отвечай, что я на встрече');
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /ИИ-автоответ включён/);

    gem.replies.push(geminiOk('Я сейчас на встрече, наберу позже!'));
    await send(bot, businessMsg(PEER, peerUser(PEER), { text: 'привет, ты тут?' }).update);
    const out = sentTo(calls, PEER);
    assert.equal(out.length, 1, 'ровно один ответ (без статичного автоответа)');
    assert.equal(out[0].payload.text, 'Я сейчас на встрече, наберу позже!');
    assert.equal(out[0].payload.business_connection_id, CONN);
    assert.match(gem.calls[0].body.systemInstruction.parts[0].text, /на встрече/);
    assert.match(gem.calls[0].body.contents[0].parts[0].text, /привет, ты тут\?/);

    // Кулдаун 5 с: второе сообщение сразу — без вызова Gemini и без ответа.
    await send(bot, businessMsg(PEER, peerUser(PEER), { text: 'алло?' }).update);
    assert.equal(gem.calls.length, 1);
    assert.equal(sentTo(calls, PEER).length, 1);

    // Сообщение от бота (is_bot) — игнорируется.
    clearAiState();
    await send(bot, businessMsg(PEER, { id: 777, is_bot: true, first_name: 'Bot' }, { text: 'я бот' }).update);
    assert.equal(gem.calls.length, 1);

    const off = businessMsg(PEER, ownerUser, { text: '.unautoai' });
    await send(bot, off.update);
    assert.equal(getChatRule(OWNER, String(PEER)), null, 'правило удалено из кэша');
    assert.equal(store.rules.get(`${OWNER}:${PEER}`).autoAiPrompt, null, 'в БД NULL');
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /ИИ-автоответ выключен/);
  });

  test('.autoai: ошибка Gemini и лимит — тихо, алерт о лимите раз в час', async () => {
    const PEER = 9107;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    await send(bot, businessMsg(PEER, ownerUser, { text: '.autoai будь вежлив' }).update);
    const dmBase = sentTo(calls, OWNER).length;

    gem.replies.push(geminiErr(429, 'RESOURCE_EXHAUSTED'));
    await send(bot, businessMsg(PEER, peerUser(PEER), { text: 'привет' }).update);
    assert.equal(sentTo(calls, PEER).length, 0, 'техническая ошибка не попала в чат');
    assert.equal(sentTo(calls, OWNER).length, dmBase);

    store.usage.set(OWNER, 25);
    clearAiState();
    await send(bot, businessMsg(PEER, peerUser(PEER), { text: 'ау' }).update);
    assert.equal(sentTo(calls, OWNER).length, dmBase + 1);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /лимит ИИ исчерпан/);
    // Повтор (после кулдауна) — без нового алерта (троттлинг раз в час).
    clearAutoAiCooldowns();
    await send(bot, businessMsg(PEER, peerUser(PEER), { text: 'x' }).update);
    assert.equal(sentTo(calls, OWNER).length, dmBase + 1);
    assert.equal(sentTo(calls, PEER).length, 0);
  });

  test('.kawaii: переписывает текст владельца и удаляет оригинал; эхо sender_business_bot не трогает', async () => {
    const PEER = 9108;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    await send(bot, businessMsg(PEER, ownerUser, { text: '.kawaii' }).update);
    assert.equal(getChatRule(OWNER, String(PEER)).kawaiiEnabled, true);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /Kawaii-режим включён/);
    assert.doesNotMatch(sentTo(calls, OWNER).at(-1).payload.text, /нет права/);

    gem.replies.push(geminiOk('я дома (◕‿◕✿)'));
    const orig = businessMsg(PEER, ownerUser, { text: 'я дома' });
    await send(bot, orig.update);
    assert.equal(gem.calls.length, 1);
    assert.equal(gem.calls[0].body.contents[0].parts[0].text, 'я дома');
    assert.ok(deletes(calls).includes(orig.id), 'оригинал удалён');
    const out = sentTo(calls, PEER);
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.text, 'я дома (◕‿◕✿)');
    assert.equal(out[0].payload.business_connection_id, CONN);

    // Эхо отправленного ботом сообщения — без вызова Gemini (нет цикла).
    const echo = businessMsg(PEER, ownerUser, { text: 'я дома (◕‿◕✿)', sender_business_bot: { id: botInfo.id, is_bot: true, first_name: 'Kaguya' } });
    await send(bot, echo.update);
    assert.equal(gem.calls.length, 1);
    assert.ok(!deletes(calls).includes(echo.id));

    // Неизвестная .команда, длинный текст, стикер — не переписываются.
    await send(bot, businessMsg(PEER, ownerUser, { text: '.чтото' }).update);
    await send(bot, businessMsg(PEER, ownerUser, { text: 'я'.repeat(501) }).update);
    await send(bot, businessMsg(PEER, ownerUser, { sticker: { file_id: 's', file_unique_id: 's', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false } }).update);
    assert.equal(gem.calls.length, 1);

    // Ошибка Gemini — оригинал остаётся, в чат ничего.
    gem.replies.push(geminiErr(500));
    const keep = businessMsg(PEER, ownerUser, { text: 'оставь как есть' });
    await send(bot, keep.update);
    assert.ok(!deletes(calls).includes(keep.id));
    assert.equal(sentTo(calls, PEER).length, 1);

    // Автоответ на паузе после сообщений владельца (как и раньше).
    await send(bot, businessMsg(PEER, peerUser(PEER), { text: 'привет' }).update);
    assert.equal(sentTo(calls, PEER).length, 1);

    await send(bot, businessMsg(PEER, ownerUser, { text: '.unkawaii' }).update);
    assert.equal(getChatRule(OWNER, String(PEER)), null);
    const n = gem.calls.length;
    await send(bot, businessMsg(PEER, ownerUser, { text: 'обычный текст' }).update);
    assert.equal(gem.calls.length, n);
  });

  test('.kawaii без прав на удаление — предупреждение в ЛС', async () => {
    const PEER = 9109;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate({ canDeleteAll: false, canDeleteSent: false }));
    await send(bot, businessMsg(PEER, ownerUser, { text: '.kawaii' }).update);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /Удаление отправленных сообщений/);
  });

  test('loadBotState подгружает autoAiPrompt / kawaiiEnabled', async () => {
    store.rules.set(`${OWNER}:8101`, { isMuted: false, deleteStickersGifs: false, autoAiPrompt: 'x', kawaiiEnabled: false });
    store.rules.set(`${OWNER}:8102`, { isMuted: false, deleteStickersGifs: false, autoAiPrompt: null, kawaiiEnabled: true });
    await loadBotState({ pruning: false });
    assert.equal(getChatRule(OWNER, '8101').autoAiPrompt, 'x');
    assert.equal(getChatRule(OWNER, '8102').kawaiiEnabled, true);
  });
});

describe('Business: RP-команды', () => {
  beforeEach(() => {
    stopDeleteQueue();
    clearChatRulesCache();
    connectionMeta.clear();
    customRpCache.clear();
    store.rp.clear();
    store.messages.clear();
  });

  test('встроенная .обнять: без комментария и с комментарием, цель из reply', async () => {
    const PEER = 9201;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    const m = businessMsg(PEER, ownerUser, { text: '.обнять' });
    await send(bot, m.update);
    assert.ok(deletes(calls).includes(m.id));
    let out = sentTo(calls, PEER).at(-1);
    assert.equal(out.payload.text, '🫂 <b>Эрмек</b> обнял(а) <b>Алихан</b>');
    assert.equal(out.payload.parse_mode, 'HTML');
    assert.equal(out.payload.business_connection_id, CONN);

    const reply = { message_id: 1, date: 0, chat: privateChat(PEER), from: { id: 42, is_bot: false, first_name: 'Дина' }, text: 'hi' };
    await send(bot, businessMsg(PEER, ownerUser, { text: '.обнять ты <лучшая>', reply_to_message: reply }).update);
    out = sentTo(calls, PEER).at(-1);
    assert.equal(out.payload.text, '🫂 <b>Эрмек</b> обнял(а) <b>Дина</b>\n💬 <i>«ты &lt;лучшая&gt;»</i>');
  });

  test('.addrp / .myrp / .delrp, лимит 3 слота, обновление не тратит слот', async () => {
    const PEER = 9202;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    const dm = () => sentTo(calls, OWNER).at(-1).payload.text;

    const add = businessMsg(PEER, ownerUser, { text: '.addrp .обнимашки крепко обнял(а)' });
    await send(bot, add.update);
    assert.ok(deletes(calls).includes(add.id));
    assert.match(dm(), /RP добавлена: <code>\.обнимашки<\/code>/);
    assert.match(dm(), /1\/3/);

    // Выполнение кастомной RP.
    await send(bot, businessMsg(PEER, ownerUser, { text: '.обнимашки' }).update);
    assert.equal(sentTo(calls, PEER).at(-1).payload.text, '✨ <b>Эрмек</b> крепко обнял(а) <b>Алихан</b>');

    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp .hug_2 обнял' }).update);
    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp .тык тыкнул(а)' }).update);
    assert.match(dm(), /3\/3/);
    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp .четвёртая лишняя' }).update);
    assert.match(dm(), /Занято 3\/3/);
    assert.equal(rpOf(OWNER).size, 3);

    // Обновление существующего триггера при полном лимите — разрешено.
    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp .тык легонько тыкнул(а)' }).update);
    assert.match(dm(), /RP обновлена/);
    assert.equal(rpOf(OWNER).get('тык').action_text, 'легонько тыкнул(а)');
    // Кэш инвалидирован — выполняется новая версия.
    await send(bot, businessMsg(PEER, ownerUser, { text: '.тык' }).update);
    assert.match(sentTo(calls, PEER).at(-1).payload.text, /легонько тыкнул\(а\)/);

    await send(bot, businessMsg(PEER, ownerUser, { text: '.myrp' }).update);
    assert.match(dm(), /Ваши RP-команды<\/b> \(3\/3\)/);
    assert.match(dm(), /\.hug_2/);

    await send(bot, businessMsg(PEER, ownerUser, { text: '.delrp .hug_2' }).update);
    assert.match(dm(), /удалена/);
    assert.equal(rpOf(OWNER).has('hug_2'), false);
    await send(bot, businessMsg(PEER, ownerUser, { text: '.delrp .hug_2' }).update);
    assert.match(dm(), /не найдена/);
    // После удаления триггер больше не RP: неизвестная команда не трогается.
    const n = calls.length;
    await send(bot, businessMsg(PEER, ownerUser, { text: '.hug_2' }).update);
    assert.equal(calls.length, n);
  });

  test('.addrp: запрет перезаписи системных .mute / .ai / .addrp, невалидный формат', async () => {
    const PEER = 9203;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    for (const t of ['mute', 'ai', 'autoai', 'addrp', 'help']) {
      await send(bot, businessMsg(PEER, ownerUser, { text: `.addrp .${t} что-то` }).update);
      assert.match(sentTo(calls, OWNER).at(-1).payload.text, /системная команда/, t);
    }
    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp обнять без точки' }).update);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /Формат/);
    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp .ок' }).update);
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /Формат/);
    assert.equal(rpOf(OWNER).size, 0);
    assert.equal(sentTo(calls, PEER).length, 0);
  });

  test('.addrp ответом на GIF — sendAnimation с HTML-подписью; стикер — стикер + текст', async () => {
    const PEER = 9204;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    const gifMsg = { message_id: 2, date: 0, chat: privateChat(PEER), from: peerUser(PEER), animation: ANIM, document: { file_id: 'GIF-FILE-1', file_unique_id: 'g1' } };
    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp .танец станцевал(а) с', reply_to_message: gifMsg }).update);
    assert.deepEqual(rpOf(OWNER).get('танец'), { trigger: 'танец', action_text: 'станцевал(а) с', media_file_id: 'GIF-FILE-1', media_type: 'animation' });
    assert.match(sentTo(calls, OWNER).at(-1).payload.text, /\+ GIF/);

    await send(bot, businessMsg(PEER, ownerUser, { text: '.танец ура' }).update);
    const anim = calls.filter((c) => c.method === 'sendAnimation').at(-1);
    assert.equal(anim.payload.animation, 'GIF-FILE-1');
    assert.equal(anim.payload.caption, '✨ <b>Эрмек</b> станцевал(а) с <b>Алихан</b>\n💬 <i>«ура»</i>');
    assert.equal(anim.payload.parse_mode, 'HTML');
    assert.equal(anim.payload.business_connection_id, CONN);

    const stickerMsg = { message_id: 3, date: 0, chat: privateChat(PEER), from: peerUser(PEER), sticker: { file_id: 'STK-1', file_unique_id: 's1', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false } };
    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp .пат погладил(а)', reply_to_message: stickerMsg }).update);
    await send(bot, businessMsg(PEER, ownerUser, { text: '.пат' }).update);
    const st = calls.filter((c) => c.method === 'sendSticker').at(-1);
    assert.equal(st.payload.sticker, 'STK-1');
    assert.equal(st.payload.business_connection_id, CONN);
    assert.equal(sentTo(calls, PEER).at(-1).payload.text, '✨ <b>Эрмек</b> погладил(а) <b>Алихан</b>');
  });

  test('кастомная RP перекрывает встроенную; БД недоступна — работают встроенные', async () => {
    const PEER = 9205;
    const { bot, calls } = makeBot();
    await send(bot, connectionUpdate());
    await send(bot, businessMsg(PEER, ownerUser, { text: '.addrp .обнять задушил(а) в объятиях' }).update);
    await send(bot, businessMsg(PEER, ownerUser, { text: '.обнять' }).update);
    assert.match(sentTo(calls, PEER).at(-1).payload.text, /задушил\(а\) в объятиях/);

    const orig = db.listCustomRp;
    db.listCustomRp = async () => { throw new Error('db down'); };
    try {
      customRpCache.clear();
      await send(bot, businessMsg(PEER, ownerUser, { text: '.погладить' }).update);
      assert.equal(sentTo(calls, PEER).at(-1).payload.text, '🤚 <b>Эрмек</b> погладил(а) <b>Алихан</b>');
    } finally {
      db.listCustomRp = orig;
    }
  });
});
