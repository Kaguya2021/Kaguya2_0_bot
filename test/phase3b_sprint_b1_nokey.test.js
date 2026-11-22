import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

// Отдельный процесс без GEMINI_API_KEY: ИИ-команды вежливо сообщают владельцу, бот не падает, fetch не вызывается.
process.env.BOT_TOKEN = '123456:TEST-TOKEN';
process.env.ADMIN_IDS = '111';
process.env.DISCUSSION_GROUP_ID = '';
process.env.TARGET_CHANNEL_ID = '';
process.env.DATABASE_URL = '';
process.env.GEMINI_API_KEY = '';

const { config } = await import('../src/config.js');
const { isGeminiConfigured, waitAiTasks } = await import('../src/services/gemini.js');
const { db, DEFAULT_USER_SETTINGS } = await import('../src/db/index.js');
const { createBot, stopCacheCleanup } = await import('../src/bot/index.js');
const { getChatRule } = await import('../src/bot/state.js');

const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('сеть запрещена в тестах'); };
after(() => {
  globalThis.fetch = realFetch;
  stopCacheCleanup();
});

const OWNER = '777';
const CONN = 'conn-nokey';
const rules = new Map();
let quotaCalls = 0;
Object.assign(db, {
  saveErrorLog: async () => {},
  upsertBusinessConnection: async () => {},
  getBusinessConnection: async () => null,
  setChatRule: async (o, c, patch) => {
    const next = { isMuted: false, deleteStickersGifs: false, autoAiPrompt: null, kawaiiEnabled: false, ...(rules.get(`${o}:${c}`) || {}), ...patch };
    rules.set(`${o}:${c}`, next);
    return next;
  },
  getAllActiveChatRules: async () => [],
  saveCachedBusinessMessage: async () => {},
  getCachedBusinessMessages: async () => [],
  getRecentCachedMessages: async () => [],
  getBotState: async () => null,
  getUserSettings: async () => ({ ...DEFAULT_USER_SETTINGS }),
  getAiUsageToday: async () => { quotaCalls++; return 0; },
  incrementAiUsage: async () => { quotaCalls++; return 1; },
  listCustomRp: async () => []
});

const botInfo = { id: 1, is_bot: true, first_name: 'K', username: 'k_bot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
const owner = { id: Number(OWNER), is_bot: false, first_name: 'Owner' };
const peer = { id: 4242, is_bot: false, first_name: 'Peer' };
const chat = { id: 4242, type: 'private', first_name: 'Peer' };
let uid = 1;
let mid = 1;
const bm = (from, text) => ({ update_id: uid++, business_message: { message_id: mid++, business_connection_id: CONN, date: 0, chat, from, text } });

describe('ИИ без GEMINI_API_KEY', () => {
  test('.ai / .autoai / .kawaii: вежливое сообщение в ЛС, без fetch и без ответа в чат', async () => {
    assert.equal(config.geminiApiKey, '');
    assert.equal(isGeminiConfigured(), false);
    const bot = createBot('123456:TEST-TOKEN', { botInfo });
    const calls = [];
    bot.api.config.use(async (prev, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: method.startsWith('send') ? { message_id: 9000 + calls.length, date: 0, chat: { id: payload.chat_id } } : true };
    });
    await bot.handleUpdate({
      update_id: uid++,
      business_connection: { id: CONN, user: owner, user_chat_id: owner.id, date: 0, is_enabled: true, rights: { can_reply: true, can_delete_sent_messages: true, can_delete_all_messages: true } }
    });
    const dm = () => calls.filter((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === OWNER).at(-1)?.payload.text || '';
    const toPeer = () => calls.filter((c) => c.method.startsWith('send') && String(c.payload.chat_id) === String(peer.id));

    await bot.handleUpdate(bm(owner, '.ai привет'));
    await waitAiTasks();
    assert.match(dm(), /ИИ пока не настроен/);
    assert.match(dm(), /GEMINI_API_KEY/);

    await bot.handleUpdate(bm(owner, '.autoai будь вежлив'));
    assert.match(dm(), /ИИ-автоответ включён/);
    assert.match(dm(), /ИИ пока не настроен/);
    assert.equal(getChatRule(OWNER, String(peer.id)).autoAiPrompt, 'будь вежлив');
    await bot.handleUpdate(bm(peer, 'привет'));
    await waitAiTasks();

    await bot.handleUpdate(bm(owner, '.kawaii'));
    await bot.handleUpdate(bm(owner, 'обычный текст'));
    await waitAiTasks();

    assert.equal(fetchCalls, 0);
    assert.equal(quotaCalls, 0, 'квота не списывается');
    assert.equal(toPeer().length, 0, 'в чат собеседника ничего (ни ИИ, ни статичного автоответа)');
  });
});
