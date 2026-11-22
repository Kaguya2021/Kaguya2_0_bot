import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Окружение — ДО импорта src/. Гейт подписки активен (канал задан @username). БД мокается ниже.
process.env.BOT_TOKEN = '123456:TEST-TOKEN';
process.env.ADMIN_IDS = '111';
process.env.DISCUSSION_GROUP_ID = '';
process.env.TARGET_CHANNEL_ID = '@kaguya_test_channel';
process.env.DATABASE_URL = '';
delete process.env.REQUIRE_SUBSCRIPTION;

const { config, loadConfig } = await import('../src/config.js');
const {
  checkUserSubscription, clearSubscriptionCache, isSubscriptionGateActive, getChannelUrl, isMemberStatus
} = await import('../src/services/subscription.js');
const {
  buildOnboardingScreen, buildSubscriptionScreen, buildMainMenuScreen, buildAutoReplyMenuScreen, pluralUsers
} = await import('../src/services/screens.js');
const { buildScreenMessage } = await import('../src/bot/menu.js');
const { HELP_TEXT } = await import('../src/handlers/dotCommands.js');
const { db, DEFAULT_USER_SETTINGS } = await import('../src/db/index.js');
const { createBot, stopCacheCleanup } = await import('../src/bot/index.js');
const { getUsersCountCached, clearUsersCountCache, userSettingsCache, connectionMeta } = await import('../src/bot/state.js');

after(() => stopCacheCleanup());

const CHANNEL = '@kaguya_test_channel';
const gateCfg = { requireSubscription: true, targetChannelId: CHANNEL, adminIds: ['111'], channelInviteUrl: '' };
const apiErr = (description, code = 400) => Object.assign(new Error(description), { description, error_code: code });

function memberApi(resolve) {
  const api = { calls: 0 };
  api.getChatMember = async (chatId, userId) => {
    api.calls++;
    assert.equal(chatId, CHANNEL);
    return resolve(userId);
  };
  return api;
}

// ======================= config =======================

describe('config: подписка и ссылки', () => {
  test('requireSubscription по TARGET_CHANNEL_ID, отключается REQUIRE_SUBSCRIPTION=false', () => {
    assert.equal(loadConfig({}).requireSubscription, false);
    assert.equal(loadConfig({ TARGET_CHANNEL_ID: '@ch' }).requireSubscription, true);
    assert.equal(loadConfig({ TARGET_CHANNEL_ID: '@ch', REQUIRE_SUBSCRIPTION: 'false' }).requireSubscription, false);
    assert.equal(loadConfig({}).guideUrl, 'https://threatux.github.io/kaguya-site/');
    assert.equal(loadConfig({ GUIDE_URL: 'https://g.example' }).guideUrl, 'https://g.example');
    assert.equal(loadConfig({}).channelInviteUrl, '');
    assert.equal(isSubscriptionGateActive(config), true);
  });

  test('getChannelUrl: @username -> t.me, числовой ID -> CHANNEL_INVITE_URL или null', () => {
    assert.equal(getChannelUrl({ targetChannelId: '@kanal' }), 'https://t.me/kanal');
    assert.equal(getChannelUrl({ targetChannelId: '-1001', channelInviteUrl: 'https://t.me/+abc' }), 'https://t.me/+abc');
    assert.equal(getChannelUrl({ targetChannelId: '-1001', channelInviteUrl: '' }), null);
  });
});

// ======================= checkUserSubscription =======================

describe('checkUserSubscription', () => {
  beforeEach(() => clearSubscriptionCache());

  test('пропускает member / administrator / creator / restricted(is_member)', async () => {
    for (const member of [{ status: 'member' }, { status: 'administrator' }, { status: 'creator' }, { status: 'restricted', is_member: true }]) {
      clearSubscriptionCache();
      const res = await checkUserSubscription(memberApi(() => member), 1, { cfg: gateCfg });
      assert.deepEqual(res, { subscribed: true }, member.status);
    }
  });

  test('блокирует left / kicked / restricted(!is_member) и USER_NOT_PARTICIPANT', async () => {
    for (const member of [{ status: 'left' }, { status: 'kicked' }, { status: 'restricted', is_member: false }]) {
      assert.deepEqual(await checkUserSubscription(memberApi(() => member), 2, { cfg: gateCfg }), { subscribed: false });
      assert.equal(isMemberStatus(member), false);
    }
    for (const desc of ['Bad Request: USER_NOT_PARTICIPANT', 'Bad Request: PARTICIPANT_ID_INVALID', 'Bad Request: user not found']) {
      const api = memberApi(() => { throw apiErr(desc); });
      assert.deepEqual(await checkUserSubscription(api, 2, { cfg: gateCfg }), { subscribed: false }, desc);
    }
  });

  test('админ и выключенный гейт — без вызова getChatMember', async () => {
    const api = memberApi(() => ({ status: 'left' }));
    assert.deepEqual(await checkUserSubscription(api, 111, { cfg: gateCfg }), { subscribed: true, bypassed: true });
    assert.deepEqual(await checkUserSubscription(api, 5, { cfg: { ...gateCfg, requireSubscription: false } }), { subscribed: true, bypassed: true });
    assert.deepEqual(await checkUserSubscription(api, 5, { cfg: { ...gateCfg, targetChannelId: '' } }), { subscribed: true, bypassed: true });
    assert.equal(api.calls, 0);
  });

  test('кэширует true, НЕ кэширует false, force игнорирует кэш', async () => {
    let status = 'member';
    const api = memberApi(() => ({ status }));
    assert.deepEqual(await checkUserSubscription(api, 3, { cfg: gateCfg }), { subscribed: true });
    assert.deepEqual(await checkUserSubscription(api, 3, { cfg: gateCfg }), { subscribed: true, cached: true });
    assert.equal(api.calls, 1);

    status = 'left';
    assert.deepEqual(await checkUserSubscription(api, 3, { cfg: gateCfg, force: true }), { subscribed: false });
    assert.equal(api.calls, 2);
    await checkUserSubscription(api, 3, { cfg: gateCfg });
    await checkUserSubscription(api, 3, { cfg: gateCfg });
    assert.equal(api.calls, 4, 'false не кэшируется');
  });

  test('fail-open на сбое API, предупреждение троттлится', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const errors = [apiErr('Bad Request: chat not found'), apiErr('Forbidden: bot is not a member', 403), new Error('Network request failed')];
    for (const err of errors) {
      const api = memberApi(() => { throw err; });
      assert.deepEqual(await checkUserSubscription(api, 4, { cfg: gateCfg }), { subscribed: true, fallback: true });
    }
    assert.equal(warn.mock.callCount(), 1, 'не чаще раза в 10 минут');
  });
});

// ======================= Счётчик пользователей =======================

describe('getUsersCountCached', () => {
  test('1 запрос в БД в пределах TTL; при сбое — последнее значение', async () => {
    clearUsersCountCache();
    let queries = 0;
    let fail = false;
    const original = db.getUsersCount;
    db.getUsersCount = async () => { queries++; if (fail) throw new Error('db down'); return 42; };
    assert.equal(await getUsersCountCached(), 42);
    assert.equal(await getUsersCountCached(), 42);
    await Promise.all([getUsersCountCached(), getUsersCountCached()]);
    assert.equal(queries, 1);

    fail = true;
    assert.equal(await getUsersCountCached({ force: true }), 42);
    assert.equal(queries, 2);

    clearUsersCountCache();
    assert.equal(await getUsersCountCached(), null, 'БД недоступна и значения нет -> null');
    clearUsersCountCache();
    db.getUsersCount = original;
  });
});

// ======================= Экраны =======================

const allButtons = (kb) => kb.inline_keyboard.flat();

describe('экраны', () => {
  test('buildOnboardingScreen: динамический @username, copy_text, без tg://, expandable', () => {
    const { text, reply_markup } = buildOnboardingScreen({ botUsername: 'threatux_smsbot', cfg: { guideUrl: 'https://g.example' } });
    assert.match(text, /@threatux_smsbot/);
    assert.doesNotMatch(text, /Kaguya_2_0bot/);
    assert.match(text, /<blockquote expandable>/);
    const json = JSON.stringify(reply_markup);
    assert.doesNotMatch(json, /tg:\/\//);
    const btns = allButtons(reply_markup);
    const copy = btns.find((b) => b.copy_text);
    assert.deepEqual(copy.copy_text, { text: '@threatux_smsbot' });
    assert.match(copy.text, /Скопировать @threatux_smsbot/);
    assert.ok(btns.some((b) => b.callback_data === 'check_connection'));
    assert.ok(btns.some((b) => b.url === 'https://g.example'));
    assert.ok(btns.some((b) => b.callback_data === 'open_main_menu'));
    assert.match(buildOnboardingScreen().text, /@Kaguya_2_0bot/, 'fallback username');
  });

  test('buildSubscriptionScreen: счётчик и кнопки', () => {
    const { text, reply_markup } = buildSubscriptionScreen({ usersCount: 1234, cfg: gateCfg });
    assert.match(text, /<blockquote>/);
    assert.match(text, /Обязательная подписка/);
    assert.match(text, /Уже с нами: <b>1 234<\/b> пользователя/);
    const btns = allButtons(reply_markup);
    assert.ok(btns.some((b) => b.url === 'https://t.me/kaguya_test_channel'));
    assert.ok(btns.some((b) => b.callback_data === 'check_sub'));
    assert.doesNotMatch(buildSubscriptionScreen({ usersCount: 0, cfg: gateCfg }).text, /Уже с нами/);
    assert.equal(pluralUsers(1), 'пользователь');
    assert.equal(pluralUsers(11), 'пользователей');
    assert.equal(pluralUsers(22), 'пользователя');
  });

  test('buildMainMenuScreen: карточка профиля, статус подключения, компактные кнопки', () => {
    const now = Date.UTC(2026, 10, 22);
    const created = new Date(Date.UTC(2026, 10, 12));
    const { text, reply_markup, banner } = buildMainMenuScreen({
      userId: '5', settings: { ...DEFAULT_USER_SETTINGS }, profile: { created_at: created }, usersCount: 10,
      connection: { connected: true, canDeleteAll: false }, now, cfg: gateCfg
    });
    assert.equal(banner, true);
    assert.match(text, /^✨ <b>Kaguya 2\.0<\/b>\n\n<blockquote>👤 <b>Профиль<\/b>/);
    assert.match(text, /📅 В боте с <b>12\.11\.2026<\/b> \(10 дн\.\)/);
    assert.match(text, /👥 Пользователей: <b>10<\/b>/);
    assert.match(text, /🟢 Активен · ⚠️ без прав \.mute/);
    assert.match(text, /💬 Автоответ: <b>ВКЛ<\/b> · 👁 Анти-удаление: <b>ВКЛ<\/b><\/blockquote>/);
    assert.match(text, /<\/blockquote>\n\n<i>.+<\/i>$/);

    const rows = reply_markup.inline_keyboard;
    assert.deepEqual(rows[0].map((b) => b.callback_data), ['open_autoreply_menu', 'show_dot_commands']);
    assert.deepEqual(rows[1].map((b) => b.callback_data), ['toggle_autoreply', 'settings_menu']);
    assert.equal(rows[1][0].text, '🔕 Пауза 5 мин');
    assert.equal(rows[2][0].callback_data, 'open_onboarding');
    assert.equal(rows[2][1].url, 'https://t.me/kaguya_test_channel');
    assert.equal(rows.length, 3, 'не-админ: без ADMINPPA');
    const data = allButtons(reply_markup).map((b) => b.callback_data);
    for (const cb of ['set_text', 'set_voice', 'set_combo', 'my_reply', 'set_time', 'reset_reply', 'toggle_timer_mode']) {
      assert.ok(!data.includes(cb), `${cb} перенесён в подменю`);
    }

    const admin = buildMainMenuScreen({ userId: '111', settings: { ...DEFAULT_USER_SETTINGS }, cfg: { ...gateCfg, targetChannelId: '' } });
    const adminRows = admin.reply_markup.inline_keyboard;
    assert.equal(adminRows[2].length, 1, 'без канала — только «Подключение»');
    assert.equal(adminRows.at(-1)[0].callback_data, 'admin_panel');

    const off = buildMainMenuScreen({
      userId: '5', settings: { ...DEFAULT_USER_SETTINGS, anti_delete_enabled: false, auto_off_until: Date.now() + 60_000 },
      profile: { created_at: null }, connection: { connected: false }, cfg: gateCfg
    });
    assert.match(off.text, /⚪ Не подключён/);
    assert.match(off.text, /Автоответ: <b>ВЫКЛ<\/b> · 👁 Анти-удаление: <b>ВЫКЛ<\/b>/);
    assert.doesNotMatch(off.text, /В боте с|Пользователей|<i>/);
    assert.equal(off.reply_markup.inline_keyboard[1][0].text, '🔔 Включить автоответ');
    assert.match(buildMainMenuScreen({ userId: '5', connection: null }).text, /❔ Нет данных/);
  });

  test('buildMainMenuScreen: 0 дн. -> (сегодня)', () => {
    const now = Date.UTC(2026, 10, 22, 18);
    const { text } = buildMainMenuScreen({
      userId: '5', settings: { ...DEFAULT_USER_SETTINGS }, profile: { created_at: new Date(Date.UTC(2026, 10, 22, 9)) }, now, cfg: gateCfg
    });
    assert.match(text, /📅 В боте с <b>22\.11\.2026<\/b> \(сегодня\)/);
    assert.doesNotMatch(text, /0 дн\./);
  });

  test('usersCountOffset: прибавляется на экране подписки и в главном меню', () => {
    const cfg = { ...gateCfg, usersCountOffset: 1400 };
    assert.match(buildSubscriptionScreen({ usersCount: 16, cfg }).text, /Уже с нами: <b>1 416<\/b> пользователей/);
    assert.match(buildMainMenuScreen({ userId: '5', usersCount: 16, cfg }).text, /👥 Пользователей: <b>1 416<\/b>/);
    // 0 из БД + offset -> показываем; null (БД недоступна) -> строки нет
    assert.match(buildSubscriptionScreen({ usersCount: 0, cfg }).text, /Уже с нами: <b>1 400<\/b>/);
    assert.doesNotMatch(buildSubscriptionScreen({ usersCount: null, cfg }).text, /Уже с нами/);
    assert.doesNotMatch(buildMainMenuScreen({ userId: '5', usersCount: null, cfg }).text, /Пользователей/);
    assert.match(buildMainMenuScreen({ userId: '5', usersCount: 16, cfg: gateCfg }).text, /Пользователей: <b>16<\/b>/, 'без offset');
  });

  test('buildAutoReplyMenuScreen: статус и все прежние callback_data', () => {
    const { text, reply_markup } = buildAutoReplyMenuScreen({ settings: { ...DEFAULT_USER_SETTINGS, timer_mode: true, custom_reply: 'voice:abc' } });
    assert.match(text, /💬 <b>Автоответчик<\/b>\n\n<blockquote>/);
    assert.match(text, /🟢 Включён/);
    assert.match(text, /Таймер 15 мин: <b>ВКЛ<\/b>/);
    assert.match(text, /голосовое/);
    const rows = reply_markup.inline_keyboard.map((r) => r.map((b) => b.callback_data));
    assert.deepEqual(rows, [
      ['set_text', 'set_voice'], ['set_combo', 'my_reply'], ['set_time', 'toggle_timer_mode'], ['reset_reply'], ['open_main_menu']
    ]);
    assert.equal(reply_markup.inline_keyboard[2][1].text, '⏱ Таймер 15м: ВКЛ');

    const def = buildAutoReplyMenuScreen({ settings: { ...DEFAULT_USER_SETTINGS } });
    assert.match(def.text, /Таймер 15 мин: <b>ОТКЛ<\/b>/);
    assert.match(def.text, /стандартный/);
    assert.equal(def.reply_markup.inline_keyboard[2][1].text, '⏱ Таймер 15м: ОТКЛ');
  });

  test('баннер: MENU_BANNER_URL -> невидимая ссылка + превью над текстом; пусто -> is_disabled', () => {
    const url = 'https://cdn.example/banner.jpg?a=1&b=2';
    const screen = { text: 'X', banner: true };
    const on = buildScreenMessage(screen, { menuBannerUrl: url });
    assert.equal(on.text, '<a href="https://cdn.example/banner.jpg?a=1&amp;b=2">&#8205;</a>X');
    assert.deepEqual(on.link_preview_options, { url, prefer_large_media: true, show_above_text: true, is_disabled: false });

    assert.deepEqual(buildScreenMessage(screen, { menuBannerUrl: '' }), { text: 'X', link_preview_options: { is_disabled: true } });
    assert.deepEqual(buildScreenMessage({ text: 'X' }, { menuBannerUrl: url }), { text: 'X', link_preview_options: { is_disabled: true } },
      'экран без banner: true');
    assert.equal(buildSubscriptionScreen({ cfg: gateCfg }).banner, true);
    assert.equal(buildOnboardingScreen().banner, true);
  });

  test('config: USERS_COUNT_OFFSET и MENU_BANNER_URL', () => {
    assert.equal(loadConfig({}).usersCountOffset, 0);
    assert.equal(loadConfig({ USERS_COUNT_OFFSET: ' 1400 ' }).usersCountOffset, 1400);
    for (const bad of ['-5', '1.5', 'abc']) assert.equal(loadConfig({ USERS_COUNT_OFFSET: bad }).usersCountOffset, 0, bad);
    assert.equal(loadConfig({}).menuBannerUrl, '');
    assert.equal(loadConfig({ MENU_BANNER_URL: ' https://x.example/b.png ' }).menuBannerUrl, 'https://x.example/b.png');
    assert.equal(loadConfig({ MENU_BANNER_URL: 'http://x.example/b.png' }).menuBannerUrl, '');
  });
});

// ======================= Интеграция через createBot =======================

const store = { members: new Map(), connections: new Map(), settings: new Map() };
Object.assign(db, {
  saveErrorLog: async () => {},
  registerUser: async () => {},
  getBotState: async () => null,
  getUsersCount: async () => 7,
  getUserProfile: async (userId) => ({ user_id: userId, username: 'u', created_at: new Date() }),
  getUserSettings: async (userId) => ({ ...DEFAULT_USER_SETTINGS, ...(store.settings.get(userId) || {}) }),
  getOwnerConnectionStatus: async (ownerId) => store.connections.get(String(ownerId)) ||
    { connected: false, canReply: false, canDeleteSent: false, canDeleteAll: false, updatedAt: null },
  upsertBusinessConnection: async () => {},
  getBusinessConnection: async () => null,
  saveCachedBusinessMessage: async () => {},
  getCachedBusinessMessages: async () => [],
  getRecentCachedMessageIds: async () => [],
  getAllActiveChatRules: async () => []
});

const botInfo = {
  id: 999000, is_bot: true, first_name: 'SMS Test', username: 'threatux_smsbot',
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false
};

function makeBot() {
  const bot = createBot('123456:TEST-TOKEN', { botInfo });
  const calls = [];
  let nextId = 50_000;
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getChatMember') {
      const status = store.members.get(String(payload.user_id));
      if (!status) return { ok: false, error_code: 400, description: 'Bad Request: USER_NOT_PARTICIPANT' };
      return { ok: true, result: { status, user: { id: payload.user_id, is_bot: false, first_name: 'U' } } };
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
const user = (id) => ({ id: Number(id), is_bot: false, first_name: 'U' });
const privateChat = (id) => ({ id: Number(id), type: 'private', first_name: 'U' });

const startUpdate = (id) => ({
  update_id: updateId++,
  message: {
    message_id: updateId, date: Math.floor(Date.now() / 1000), chat: privateChat(id), from: user(id),
    text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }]
  }
});

const callbackUpdate = (id, data) => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`, from: user(id), chat_instance: 'ci', data,
    message: { message_id: 777, date: 0, chat: privateChat(id), from: { id: botInfo.id, is_bot: true, first_name: 'B' }, text: 'old' }
  }
});

const screens = (calls) => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
  .filter((c) => c.payload.text !== '🧹');
const lastScreen = (calls) => screens(calls).at(-1);
const buttonsOf = (c) => (c.payload.reply_markup?.inline_keyboard || []).flat();
const answers = (calls) => calls.filter((c) => c.method === 'answerCallbackQuery');

describe('Воронка: /start и callback-кнопки', () => {
  beforeEach(() => {
    clearSubscriptionCache();
    clearUsersCountCache();
    userSettingsCache.clear();
    store.members.clear();
    store.connections.clear();
    store.settings.clear();
  });

  test('/start от неподписанного -> экран подписки с кнопками канала и check_sub', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(startUpdate(201));
    const s = lastScreen(calls);
    assert.equal(screens(calls).length, 1);
    assert.match(s.payload.text, /Обязательная подписка/);
    assert.match(s.payload.text, /Уже с нами: <b>7<\/b>/);
    const btns = buttonsOf(s);
    assert.ok(btns.some((b) => b.url === 'https://t.me/kaguya_test_channel'));
    assert.ok(btns.some((b) => b.callback_data === 'check_sub'));
  });

  test('check_sub: без подписки — alert; после подписки новичок -> экран подключения', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(callbackUpdate(202, 'check_sub'));
    assert.equal(answers(calls).at(-1).payload.show_alert, true);
    assert.match(answers(calls).at(-1).payload.text, /Подписка на канал не найдена/);
    assert.equal(screens(calls).length, 0);

    store.members.set('202', 'member');
    await bot.handleUpdate(callbackUpdate(202, 'check_sub'));
    assert.equal(answers(calls).at(-1).payload.text, '✅ Подписка подтверждена!');
    const s = lastScreen(calls);
    assert.equal(s.method, 'editMessageText');
    assert.match(s.payload.text, /Подключение бизнес-бота/);
    assert.match(s.payload.text, /@threatux_smsbot/, 'username из ctx.me');
    assert.deepEqual(buttonsOf(s).find((b) => b.copy_text).copy_text, { text: '@threatux_smsbot' });
  });

  test('check_sub: подключённый пользователь -> главное меню', async () => {
    const { bot, calls } = makeBot();
    store.members.set('203', 'administrator');
    store.connections.set('203', { connected: true, canReply: true, canDeleteSent: true, canDeleteAll: true, updatedAt: new Date() });
    await bot.handleUpdate(callbackUpdate(203, 'check_sub'));
    assert.match(lastScreen(calls).payload.text, /Kaguya 2\.0/);
    assert.match(lastScreen(calls).payload.text, /🟢 Активен/);
  });

  test('/start: подписан, есть свой автоответ -> главное меню (старый пользователь)', async () => {
    const { bot, calls } = makeBot();
    store.members.set('204', 'member');
    store.settings.set('204', { custom_reply: 'привет' });
    await bot.handleUpdate(startUpdate(204));
    assert.match(lastScreen(calls).payload.text, /Kaguya 2\.0/);
    assert.match(lastScreen(calls).payload.text, /⚪ Не подключён/);
  });

  test('check_connection: не найдено -> alert; найдено -> главное меню', async () => {
    const { bot, calls } = makeBot();
    store.members.set('205', 'member');
    await bot.handleUpdate(callbackUpdate(205, 'check_connection'));
    assert.match(answers(calls).at(-1).payload.text, /Подключение пока не обнаружено/);
    assert.equal(screens(calls).length, 0);

    store.connections.set('205', { connected: true, canReply: true, canDeleteSent: true, canDeleteAll: false, updatedAt: new Date() });
    await bot.handleUpdate(callbackUpdate(205, 'check_connection'));
    assert.match(answers(calls).at(-1).payload.text, /✅ Бизнес-бот активен!/);
    assert.match(answers(calls).at(-1).payload.text, /Удаление всех сообщений/);
    const s = lastScreen(calls);
    assert.match(s.payload.text, /Kaguya 2\.0/);
    assert.match(s.payload.text, /без прав \.mute/);
  });

  test('show_dot_commands -> справка с кнопкой назад; open_onboarding/open_main_menu', async () => {
    const { bot, calls } = makeBot();
    store.members.set('206', 'member');
    await bot.handleUpdate(callbackUpdate(206, 'show_dot_commands'));
    assert.equal(lastScreen(calls).payload.text, HELP_TEXT);
    assert.ok(buttonsOf(lastScreen(calls)).some((b) => b.callback_data === 'open_main_menu'));

    await bot.handleUpdate(callbackUpdate(206, 'open_onboarding'));
    assert.match(lastScreen(calls).payload.text, /Подключение бизнес-бота/);
    await bot.handleUpdate(callbackUpdate(206, 'open_main_menu'));
    assert.match(lastScreen(calls).payload.text, /Kaguya 2\.0/);
    assert.equal(calls.filter((c) => c.method === 'getChatMember').length, 1, 'подписка — из кэша');
  });

  test('open_autoreply_menu -> подменю со старыми callback_data; toggle_timer_mode обновляет на месте; open_main_menu -> назад', async () => {
    const { bot, calls } = makeBot();
    store.members.set('209', 'member');
    await bot.handleUpdate(callbackUpdate(209, 'open_autoreply_menu'));
    let s = lastScreen(calls);
    assert.equal(s.method, 'editMessageText');
    assert.match(s.payload.text, /Автоответчик/);
    assert.deepEqual(s.payload.link_preview_options, { is_disabled: true });
    const data = buttonsOf(s).map((b) => b.callback_data);
    for (const cb of ['set_text', 'set_voice', 'set_combo', 'my_reply', 'set_time', 'toggle_timer_mode', 'reset_reply', 'open_main_menu']) {
      assert.ok(data.includes(cb), cb);
    }

    db.setTimerMode = async () => {};
    await bot.handleUpdate(callbackUpdate(209, 'toggle_timer_mode'));
    s = lastScreen(calls);
    assert.equal(s.method, 'editMessageText');
    assert.match(s.payload.text, /Таймер 15 мин: <b>ВКЛ<\/b>/);
    assert.ok(buttonsOf(s).some((b) => b.text === '⏱ Таймер 15м: ВКЛ'));

    await bot.handleUpdate(callbackUpdate(209, 'open_main_menu'));
    s = lastScreen(calls);
    assert.match(s.payload.text, /Kaguya 2\.0/);
    assert.equal(buttonsOf(s)[0].callback_data, 'open_autoreply_menu');
  });

  test('старые callback_data и алиасы show_my/open_settings работают; settings_back редактирует экран', async () => {
    const { bot, calls } = makeBot();
    store.members.set('210', 'member');
    for (const cb of ['my_reply', 'show_my']) {
      await bot.handleUpdate(callbackUpdate(210, cb));
      assert.match(lastScreen(calls).payload.text, /дефолтный текст/, cb);
    }
    for (const cb of ['settings_menu', 'open_settings']) {
      await bot.handleUpdate(callbackUpdate(210, cb));
      assert.match(lastScreen(calls).payload.text, /⚙️ <b>Настройки<\/b>/, cb);
    }
    await bot.handleUpdate(callbackUpdate(210, 'set_text'));
    assert.match(lastScreen(calls).payload.text, /Напишите текст автоответа/);
    await bot.handleUpdate(callbackUpdate(210, 'set_time'));
    assert.ok(lastScreen(calls).payload.text.length > 0);

    await bot.handleUpdate(callbackUpdate(210, 'settings_back'));
    const s = lastScreen(calls);
    assert.equal(s.method, 'editMessageText');
    assert.match(s.payload.text, /Kaguya 2\.0/);
  });

  test('гейт на callback: отписанный видит экран подписки, обработчик не вызывается', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(callbackUpdate(207, 'show_dot_commands'));
    assert.match(lastScreen(calls).payload.text, /Обязательная подписка/);
    assert.ok(!screens(calls).some((c) => c.payload.text === HELP_TEXT));
  });

  test('админ проходит без getChatMember', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(startUpdate(111));
    assert.equal(calls.filter((c) => c.method === 'getChatMember').length, 0);
    assert.doesNotMatch(lastScreen(calls).payload.text, /Обязательная подписка/);
  });

  test('business_* апдейты НИКОГДА не вызывают getChatMember', async () => {
    const { bot, calls } = makeBot();
    const OWNER = 208;
    const CONN = 'conn-208';
    await bot.handleUpdate({
      update_id: updateId++,
      business_connection: {
        id: CONN, user: user(OWNER), user_chat_id: OWNER, date: 0, is_enabled: true,
        rights: { can_reply: true, can_delete_sent_messages: true, can_delete_all_messages: true }
      }
    });
    const msg = (id, from, text) => ({
      message_id: id, business_connection_id: CONN, date: Math.floor(Date.now() / 1000),
      chat: privateChat(9001), from, text
    });
    await bot.handleUpdate({ update_id: updateId++, business_message: msg(1, user(9001), 'привет') });
    await bot.handleUpdate({ update_id: updateId++, business_message: msg(2, user(OWNER), '.help') });
    await bot.handleUpdate({ update_id: updateId++, edited_business_message: { ...msg(1, user(9001), 'изменено'), edit_date: 1 } });
    await bot.handleUpdate({
      update_id: updateId++,
      deleted_business_messages: { business_connection_id: CONN, chat: privateChat(9001), message_ids: [1] }
    });
    assert.ok(calls.length > 0, 'бизнес-обработчики отработали');
    assert.equal(calls.filter((c) => c.method === 'getChatMember').length, 0);
    connectionMeta.clear();
  });
});
