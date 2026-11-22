import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

// Окружение задаётся ДО импорта модулей src/ (config читает env при первом импорте;
// dotenv не перезаписывает уже заданные переменные). DATABASE_URL пустой — без БД.
const ADMIN = '111';
const USER = '222';
const GROUP = '-1009990001';
process.env.BOT_TOKEN = '123456:TEST-TOKEN';
process.env.ADMIN_IDS = ADMIN;
process.env.DISCUSSION_GROUP_ID = GROUP;
process.env.TARGET_CHANNEL_ID = '';
process.env.DATABASE_URL = '';

const { loadConfig, isAdmin, FALLBACK_ADMIN_IDS, DEFAULT_RENDER_URL } = await import('../src/config.js');
const { runMigrations, MIGRATIONS } = await import('../src/db/migrations.js');
const { createBot, stopCacheCleanup } = await import('../src/bot/index.js');
const { stepState } = await import('../src/bot/state.js');

after(() => stopCacheCleanup());

// --- Мок postgres.js: tagged template + sql.begin(fn) ---
function createMockSql({ tableExists = false, applied = [] } = {}) {
  const state = { tableExists, applied: new Set(applied), queries: [], inserted: [], begins: 0 };
  const run = (strings, ...values) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim();
    state.queries.push(text);
    if (text.startsWith('SELECT version FROM schema_migrations')) {
      if (!state.tableExists) {
        const err = new Error('relation "schema_migrations" does not exist');
        err.code = '42P01';
        return Promise.reject(err);
      }
      return Promise.resolve([...state.applied].map((version) => ({ version })));
    }
    if (text.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      state.tableExists = true;
      return Promise.resolve([]);
    }
    if (text.startsWith('SELECT 1 FROM schema_migrations')) {
      return Promise.resolve(state.applied.has(values[0]) ? [{ '?column?': 1 }] : []);
    }
    if (text.startsWith('INSERT INTO schema_migrations')) {
      state.applied.add(values[0]);
      state.inserted.push(values[0]);
    }
    return Promise.resolve([]);
  };
  const sql = (strings, ...values) => run(strings, ...values);
  sql.begin = async (fn) => {
    state.begins++;
    return fn(run);
  };
  return { sql, state };
}

const isDDL = (q) => /^(CREATE|ALTER|DROP)\b/i.test(q);
const silent = () => {};

describe('runMigrations', () => {
  test('пустая БД: создаёт schema_migrations и применяет 001..004 по порядку', async () => {
    const { sql, state } = createMockSql();
    const res = await runMigrations(sql, { log: silent });

    assert.deepEqual(res.applied, ['001_initial_schema', '002_phase1_stability', '003_phase2_feedback_publishing', '004_phase3b_rules_antidelete']);
    assert.deepEqual(state.inserted, ['001', '002', '003', '004']);
    assert.equal(state.begins, 4, 'каждая миграция — в отдельной транзакции');
    assert.ok(state.queries.some((q) => q.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')));
    // Все DDL идемпотентны (безопасно на боевой БД, где таблицы уже есть).
    for (const q of state.queries.filter(isDDL)) {
      assert.match(q, /IF NOT EXISTS/, q);
      assert.doesNotMatch(q, /^DROP/i, q);
    }
    // Ключевые объекты схемы на месте.
    const all = state.queries.join('\n');
    for (const name of ['user_settings', 'users', 'chat_pauses', 'message_logs', 'bot_state', 'channel_comments', 'post_drafts',
      'business_connections', 'chat_rules', 'business_messages_cache']) {
      assert.ok(all.includes(`CREATE TABLE IF NOT EXISTS ${name}`), name);
    }
    for (const col of ['timezone_offset_min', 'auto_off_until', 'blocked_until', 'anti_delete_enabled']) {
      assert.ok(all.includes(`ADD COLUMN IF NOT EXISTS ${col}`), col);
    }
    assert.ok(all.includes('ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS status'));
    assert.ok(all.includes('ON channel_comments (status, created_at)'));
    assert.ok(all.includes('ON message_logs (role, status, created_at)'));
    assert.ok(all.includes('ON post_drafts (status)'));
    assert.ok(all.includes('ON business_messages_cache (created_at)'));
    assert.ok(all.includes('ON business_messages_cache (connection_id, chat_id, message_id DESC)'));
  });

  test('повторный вызов: все версии применены -> один SELECT, ни одной миграции и DDL', async () => {
    const { sql, state } = createMockSql();
    await runMigrations(sql, { log: silent });
    state.queries.length = 0;
    state.begins = 0;

    const res = await runMigrations(sql, { log: silent });
    assert.deepEqual(res.applied, []);
    assert.equal(res.skipped.length, MIGRATIONS.length);
    assert.equal(state.begins, 0);
    assert.deepEqual(state.queries, ['SELECT version FROM schema_migrations']);
  });

  test('частично применённая БД: выполняются только недостающие миграции', async () => {
    const { sql, state } = createMockSql({ tableExists: true, applied: ['001'] });
    const res = await runMigrations(sql, { log: silent });
    assert.deepEqual(res.applied, ['002_phase1_stability', '003_phase2_feedback_publishing', '004_phase3b_rules_antidelete']);
    assert.deepEqual(state.inserted, ['002', '003', '004']);
    assert.ok(!state.queries.some((q) => q.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')));
  });

  test('гонка инстансов: миграция, применённая другим инстансом под блокировкой, пропускается', async () => {
    const { sql, state } = createMockSql({ tableExists: true, applied: [] });
    const origBegin = sql.begin;
    // Пока ждали блокировку, другой инстанс применил 001.
    sql.begin = async (fn) => {
      if (state.begins === 0) state.applied.add('001');
      return origBegin(fn);
    };
    const res = await runMigrations(sql, { log: silent });
    assert.deepEqual(res.applied, ['002_phase1_stability', '003_phase2_feedback_publishing', '004_phase3b_rules_antidelete']);
    assert.ok(res.skipped.includes('001_initial_schema'));
    assert.deepEqual(state.inserted, ['002', '003', '004']);
  });

  test('версии миграций уникальны и упорядочены', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    assert.deepEqual(versions, ['001', '002', '003', '004']);
    assert.deepEqual([...versions].sort(), versions);
  });
});

describe('config', () => {
  test('ADMIN_IDS: парсинг, пробелы и мусор отбрасываются', () => {
    const c = loadConfig({ ADMIN_IDS: ' 1, 2 ,abc,,3 ' });
    assert.deepEqual([...c.adminIds], ['1', '2', '3']);
    assert.deepEqual([...c.adminIdsFromEnv], ['1', '2', '3']);
  });

  test('дефолты при пустом env', () => {
    const c = loadConfig({});
    assert.equal(c.botToken, '');
    assert.equal(c.databaseUrl, '');
    assert.equal(c.adminIdsFromEnv, null);
    assert.deepEqual([...c.adminIds], [...FALLBACK_ADMIN_IDS]);
    assert.equal(c.webhookSecret, '');
    assert.equal(c.targetChannelId, '');
    assert.equal(c.discussionGroupId, '');
    assert.equal(c.renderUrl, DEFAULT_RENDER_URL);
    assert.equal(c.port, 3000);
    assert.equal(c.usePolling, false);
  });

  test('значения из env: trim ID каналов, USE_POLLING только "true"', () => {
    const c = loadConfig({
      TARGET_CHANNEL_ID: ' -1001 ',
      DISCUSSION_GROUP_ID: ' -1002 ',
      PORT: '8080',
      USE_POLLING: 'true',
      RENDER_EXTERNAL_URL: 'https://x.onrender.com',
      WEBHOOK_SECRET: 's3cret'
    });
    assert.equal(c.targetChannelId, '-1001');
    assert.equal(c.discussionGroupId, '-1002');
    assert.equal(c.port, '8080');
    assert.equal(c.usePolling, true);
    assert.equal(c.renderUrl, 'https://x.onrender.com');
    assert.equal(c.webhookSecret, 's3cret');
    assert.equal(loadConfig({ USE_POLLING: '1' }).usePolling, false);
  });

  test('isAdmin: строки и числа, явный список и список из env', () => {
    assert.equal(isAdmin(123, ['123']), true);
    assert.equal(isAdmin('123', ['123']), true);
    assert.equal(isAdmin('124', ['123']), false);
    assert.equal(isAdmin(undefined, ['123']), false);
    assert.equal(isAdmin(Number(ADMIN)), true);
    assert.equal(isAdmin(USER), false);
  });
});

describe('createBot (smoke, без сети)', () => {
  const botInfo = {
    id: 123456, is_bot: true, first_name: 'Kaguya Test', username: 'kaguya_test_bot',
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false
  };

  function makeBot() {
    const bot = createBot('123456:TEST-TOKEN', { botInfo });
    const calls = [];
    // Перехват всех вызовов Bot API: реальных сетевых запросов нет.
    bot.api.config.use(async (prev, method, payload) => {
      calls.push({ method, payload });
      const result = method.startsWith('send') ? { message_id: calls.length, date: 0, chat: { id: payload.chat_id } } : true;
      return { ok: true, result };
    });
    return { bot, calls };
  }

  let updateId = 1;
  const msg = (chat, from, text, extra = {}) => ({
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat,
      from,
      text,
      ...(text?.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] } : {}),
      ...extra
    }
  });
  const privateChat = (id) => ({ id: Number(id), type: 'private', first_name: 'U' });
  const user = (id) => ({ id: Number(id), is_bot: false, first_name: 'U' });
  const group = { id: Number(GROUP), type: 'supergroup', title: 'Discussion' };

  test('без токена createBot бросает ошибку', () => {
    assert.throws(() => createBot(''), /BOT_TOKEN/);
  });

  test('сборка регистрирует обработчики без падения и без сетевых запросов', () => {
    const { bot, calls } = makeBot();
    assert.equal(typeof bot.handleUpdate, 'function');
    assert.equal(calls.length, 0);
  });

  test('/chatid от админа в личке отвечает и НЕ проваливается в stepState', async () => {
    const { bot, calls } = makeBot();
    stepState.set(ADMIN, { step: 'WAITING_TEXT_ONLY' });
    await bot.handleUpdate(msg(privateChat(ADMIN), user(ADMIN), '/chatid'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendMessage');
    assert.match(calls[0].payload.text, /chat\.id: <code>111<\/code>/);
    assert.deepEqual(stepState.get(ADMIN), { step: 'WAITING_TEXT_ONLY' }, 'команда не должна сохраниться как автоответ');
    stepState.delete(ADMIN);
  });

  test('/sred (команда) обрабатывается до privateSteps и ставит шаг', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg(privateChat(USER), user(USER), '/sred'));
    assert.equal(calls.length, 1);
    assert.match(calls[0].payload.text, /Шаг 1\/2/);
    assert.deepEqual(stepState.get(USER), { step: 'WAITING_TEXT' });
    stepState.delete(USER);
  });

  test('группа обсуждений: /chatid от админа проходит сквозь сборщик комментариев', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg(group, user(ADMIN), '/chatid'));
    assert.equal(calls.length, 1);
    assert.match(calls[0].payload.text, new RegExp(`chat\\.id: <code>${GROUP}</code>`));
  });

  test('группа обсуждений: команды не-админов глушатся, бот не отвечает в группе', async () => {
    const { bot, calls } = makeBot();
    // Автопересылка поста канала: сборщик её отбрасывает (без БД) и дальше не передаёт.
    await bot.handleUpdate(msg(group, user(USER), '/start', { is_automatic_forward: true }));
    await bot.handleUpdate(msg(group, user(USER), '/chatid', { is_automatic_forward: true }));
    assert.equal(calls.length, 0);
  });

  test('privateSteps изолирован от групп: stepState не срабатывает вне лички', async () => {
    const { bot, calls } = makeBot();
    stepState.set(USER, { step: 'WAITING_TEXT' });
    const otherGroup = { id: -100777, type: 'supergroup', title: 'Other' };
    await bot.handleUpdate(msg(otherGroup, user(USER), 'просто текст'));
    assert.equal(calls.length, 0);
    assert.deepEqual(stepState.get(USER), { step: 'WAITING_TEXT' });
    stepState.delete(USER);
  });

  test('шаг WAITING_TEXT в личке переходит к стикеру (без БД)', async () => {
    const { bot, calls } = makeBot();
    stepState.set(USER, { step: 'WAITING_TEXT' });
    await bot.handleUpdate(msg(privateChat(USER), user(USER), 'Привет'));
    assert.equal(calls.length, 1);
    assert.match(calls[0].payload.text, /Шаг 2\/2/);
    assert.deepEqual(stepState.get(USER), { step: 'WAITING_STICKER', text: 'Привет' });
    stepState.delete(USER);
  });
});
