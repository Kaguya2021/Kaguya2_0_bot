// Мини-игры для бизнес-чатов (.saper / .ttt / .rps / .tod): чистая логика без сети и БД.
// Состояние партий — только в памяти (BoundedCache, TTL 30 минут). callback_data: `g:<gameId>:<action>` (≤ 64 байт).
import { randomBytes } from 'node:crypto';
import { BoundedCache } from './cache.js';
import { escapeHTML } from './html.js';

export const GAME_TTL_MS = 30 * 60 * 1000;
export const gamesCache = new BoundedCache({ maxSize: 2000, ttlMs: GAME_TTL_MS });

export function clearGamesCache() {
  gamesCache.clear();
}

// 8 символов [a-z0-9] (hex), без коллизий с живыми партиями.
export function generateGameId(cache = gamesCache) {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!cache.has(id)) return id;
  }
}

const cb = (game, action) => `g:${game.id}:${action}`;
const btn = (text, game, action) => ({ text, callback_data: cb(game, action) });
const name = (n, fallback) => escapeHTML(String(n || '').trim() || fallback);
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (toast, alert = false) => ({ ok: false, toast, alert });

export const NOT_YOUR_GAME = 'Это не ваша партия!';

function base(type, { connectionId, chatId, ownerId, ownerName }) {
  return {
    id: generateGameId(),
    type,
    connectionId,
    chatId: String(chatId),
    ownerId: String(ownerId),
    ownerName: ownerName || 'Владелец',
    messageId: null
  };
}

// ======================= Сапёр =======================

export const SAPER_SIZE = 5;
export const SAPER_CELLS = SAPER_SIZE * SAPER_SIZE;
export const SAPER_MINES = 4;
export const SAPER_SAFE = SAPER_CELLS - SAPER_MINES;
const NUM_EMOJI = ['▫️', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'];

export function saperNeighbors(idx) {
  const r = Math.floor(idx / SAPER_SIZE);
  const c = idx % SAPER_SIZE;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < SAPER_SIZE && nc >= 0 && nc < SAPER_SIZE) out.push(nr * SAPER_SIZE + nc);
    }
  }
  return out;
}

// Случайная расстановка мин в обход клетки `exclude`.
export function placeMines(exclude, rng = Math.random, count = SAPER_MINES) {
  const pool = [];
  for (let i = 0; i < SAPER_CELLS; i++) if (i !== exclude) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

function countAround(mines, idx) {
  return saperNeighbors(idx).filter((n) => mines.includes(n)).length;
}

function resetSaper(game, mines = null) {
  game.mines = mines ? [...mines] : null; // null — мины ставятся при первом клике
  game.opened = Array(SAPER_CELLS).fill(false);
  game.openedCount = 0;
  game.status = 'playing'; // 'playing' | 'won' | 'lost'
  game.exploded = null;
  game.moves = 0;
  game.lastActorName = null;
}

// mines — фиксированная расстановка (для тестов); иначе случайная при первом клике.
export function createSaperGame({ connectionId, chatId, ownerId, ownerName, mines = null }) {
  const game = base('saper', { connectionId, chatId, ownerId, ownerName });
  game.round = 1;
  resetSaper(game, mines);
  return game;
}

export function stepSaper(game, idx, { rng = Math.random, actorName = null } = {}) {
  if (game.status !== 'playing') return fail('Игра окончена — нажмите «Новая игра».');
  if (!Number.isInteger(idx) || idx < 0 || idx >= SAPER_CELLS) return fail('Неизвестная клетка');
  if (game.opened[idx]) return fail('Клетка уже открыта');

  if (game.moves === 0) {
    if (!game.mines) {
      game.mines = placeMines(idx, rng);
    } else if (game.mines.includes(idx)) {
      // Первый клик безопасен: мина переносится на первую свободную клетку.
      const free = Array.from({ length: SAPER_CELLS }, (_, i) => i).find((i) => i !== idx && !game.mines.includes(i));
      game.mines = game.mines.map((m) => (m === idx ? free : m)).sort((a, b) => a - b);
    }
  }
  game.moves++;
  game.lastActorName = actorName;

  if (game.mines.includes(idx)) {
    game.status = 'lost';
    game.exploded = idx;
    return ok({ result: 'lost' });
  }

  // BFS: каскадное раскрытие пустых клеток.
  const queue = [idx];
  while (queue.length) {
    const cur = queue.shift();
    if (game.opened[cur] || game.mines.includes(cur)) continue;
    game.opened[cur] = true;
    game.openedCount++;
    if (countAround(game.mines, cur) === 0) {
      for (const n of saperNeighbors(cur)) if (!game.opened[n]) queue.push(n);
    }
  }

  if (game.openedCount >= SAPER_SAFE) {
    game.status = 'won';
    return ok({ result: 'won' });
  }
  return ok({ result: 'open' });
}

export function restartSaper(game) {
  if (game.status === 'playing') return fail('Партия ещё идёт');
  game.round++;
  resetSaper(game);
  return ok();
}

function saperCell(game, idx) {
  const over = game.status !== 'playing';
  const isMine = game.mines?.includes(idx);
  if (over && isMine) return idx === game.exploded ? '💥' : '💣';
  if (game.opened[idx] || over) return NUM_EMOJI[countAround(game.mines || [], idx)];
  return '⬜';
}

export function renderSaper(game) {
  const rows = [];
  for (let r = 0; r < SAPER_SIZE; r++) {
    const row = [];
    for (let c = 0; c < SAPER_SIZE; c++) {
      const idx = r * SAPER_SIZE + c;
      row.push(btn(saperCell(game, idx), game, String(idx)));
    }
    rows.push(row);
  }
  let status;
  if (game.status === 'won') status = '🎉 <b>Победа!</b> Все мины обезврежены.';
  else if (game.status === 'lost') {
    status = game.lastActorName
      ? `💥 <b>Бум!</b> ${name(game.lastActorName, 'Игрок')} наступил(а) на мину.`
      : '💥 <b>Бум!</b> Вы наступили на мину.';
  } else status = `Открыто: <b>${game.openedCount}/${SAPER_SAFE}</b>. Первый ход безопасен.`;
  if (game.status !== 'playing') rows.push([btn('🔄 Новая игра', game, 'r')]);
  return {
    text: `💣 <b>Сапёр</b> ${SAPER_SIZE}×${SAPER_SIZE} · мин: ${SAPER_MINES}\n\n${status}`,
    reply_markup: { inline_keyboard: rows }
  };
}

// ======================= Крестики-нолики =======================

export const TTT_LINES = Object.freeze([
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
]);

export function tttWinner(board) {
  for (const line of TTT_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { mark: board[a], line };
  }
  return null;
}

function twoPlayers(type, opts) {
  const game = base(type, opts);
  game.peerId = String(opts.peerId);
  game.peerName = opts.peerName || 'Собеседник';
  game.score = { p1: 0, p2: 0, draw: 0 };
  game.round = 1;
  return game;
}

const isPlayer = (game, actorId) => [game.ownerId, game.peerId].includes(String(actorId));

function resetTtt(game) {
  game.board = Array(9).fill(null);
  game.turn = game.firstTurn;
  game.status = 'playing'; // 'playing' | 'won' | 'draw'
  game.winner = null;
  game.winLine = null;
}

// ❌ — владелец (player1), ⭕ — собеседник (player2).
export function createTttGame({ connectionId, chatId, ownerId, ownerName, peerId, peerName }) {
  const game = twoPlayers('ttt', { connectionId, chatId, ownerId, ownerName, peerId, peerName });
  game.firstTurn = 'X';
  resetTtt(game);
  return game;
}

const tttMarkOf = (game, actorId) => (String(actorId) === game.ownerId ? 'X' : 'O');

export function stepTtt(game, actorId, idx) {
  if (!isPlayer(game, actorId)) return fail(NOT_YOUR_GAME, true);
  if (game.status !== 'playing') return fail('Партия окончена — нажмите «Реванш».');
  if (!Number.isInteger(idx) || idx < 0 || idx > 8) return fail('Неизвестная клетка');
  if (tttMarkOf(game, actorId) !== game.turn) return fail('Сейчас не ваш ход');
  if (game.board[idx]) return fail('Клетка занята');

  game.board[idx] = game.turn;
  const win = tttWinner(game.board);
  if (win) {
    game.status = 'won';
    game.winner = win.mark;
    game.winLine = win.line;
    game.score[win.mark === 'X' ? 'p1' : 'p2']++;
    return ok({ result: 'won' });
  }
  if (game.board.every(Boolean)) {
    game.status = 'draw';
    game.score.draw++;
    return ok({ result: 'draw' });
  }
  game.turn = game.turn === 'X' ? 'O' : 'X';
  return ok({ result: 'move' });
}

// Реванш: первый ход переходит к другому игроку.
export function restartTtt(game, actorId) {
  if (!isPlayer(game, actorId)) return fail(NOT_YOUR_GAME, true);
  if (game.status === 'playing') return fail('Партия ещё идёт');
  game.firstTurn = game.firstTurn === 'X' ? 'O' : 'X';
  game.round++;
  resetTtt(game);
  return ok();
}

const TTT_MARK = { X: '❌', O: '⭕' };

export function renderTtt(game) {
  const p1 = name(game.ownerName, 'Игрок 1');
  const p2 = name(game.peerName, 'Игрок 2');
  const nameOf = (mark) => (mark === 'X' ? p1 : p2);
  const rows = [];
  for (let r = 0; r < 3; r++) {
    rows.push([0, 1, 2].map((c) => {
      const idx = r * 3 + c;
      return btn(game.board[idx] ? TTT_MARK[game.board[idx]] : '⬜', game, String(idx));
    }));
  }
  let status;
  if (game.status === 'won') status = `🏆 Победа: ${TTT_MARK[game.winner]} <b>${nameOf(game.winner)}</b>!`;
  else if (game.status === 'draw') status = '🤝 <b>Ничья!</b>';
  else status = `Ходит: ${TTT_MARK[game.turn]} <b>${nameOf(game.turn)}</b>`;
  if (game.status !== 'playing') rows.push([btn('🔄 Реванш', game, 'r')]);
  const s = game.score;
  return {
    text: `🎮 <b>Крестики-нолики</b> · раунд ${game.round}\n` +
      `❌ ${p1} vs ⭕ ${p2}\n` +
      `Счёт: ${s.p1} : ${s.p2}${s.draw ? ` (ничьих: ${s.draw})` : ''}\n\n${status}`,
    reply_markup: { inline_keyboard: rows }
  };
}

// ======================= Камень-ножницы-бумага =======================

export const RPS_CHOICES = Object.freeze({ r: '🪨 Камень', s: '✂️ Ножницы', p: '📄 Бумага' });
const RPS_BEATS = { r: 's', s: 'p', p: 'r' };

export function rpsOutcome(a, b) {
  if (a === b) return 'draw';
  return RPS_BEATS[a] === b ? 'p1' : 'p2';
}

function resetRps(game) {
  game.choices = { p1: null, p2: null };
  game.status = 'waiting'; // 'waiting' | 'done'
  game.result = null;
}

export function createRpsGame({ connectionId, chatId, ownerId, ownerName, peerId, peerName }) {
  const game = twoPlayers('rps', { connectionId, chatId, ownerId, ownerName, peerId, peerName });
  resetRps(game);
  return game;
}

export function stepRps(game, actorId, choice) {
  if (!isPlayer(game, actorId)) return fail(NOT_YOUR_GAME, true);
  if (game.status !== 'waiting') return fail('Раунд окончен — нажмите «Реванш».');
  if (!Object.hasOwn(RPS_CHOICES, choice)) return fail('Неизвестный ход');
  const slot = String(actorId) === game.ownerId ? 'p1' : 'p2';
  if (game.choices[slot]) return fail('Вы уже сделали выбор 🤫');
  game.choices[slot] = choice;
  if (game.choices.p1 && game.choices.p2) {
    game.status = 'done';
    game.result = rpsOutcome(game.choices.p1, game.choices.p2);
    game.score[game.result]++;
    return ok({ result: game.result });
  }
  return ok({ result: 'waiting', toast: `Ваш выбор: ${RPS_CHOICES[choice]} 🤫` });
}

export function restartRps(game, actorId) {
  if (!isPlayer(game, actorId)) return fail(NOT_YOUR_GAME, true);
  if (game.status !== 'done') return fail('Раунд ещё идёт');
  game.round++;
  resetRps(game);
  return ok();
}

export function renderRps(game) {
  const p1 = name(game.ownerName, 'Игрок 1');
  const p2 = name(game.peerName, 'Игрок 2');
  const s = game.score;
  const head = `✊ <b>Камень-ножницы-бумага</b> · раунд ${game.round}\n` +
    `${p1} vs ${p2}\nСчёт: ${s.p1} : ${s.p2}${s.draw ? ` (ничьих: ${s.draw})` : ''}\n\n`;
  if (game.status === 'done') {
    const verdict = game.result === 'draw'
      ? '🤝 <b>Ничья!</b>'
      : `🏆 Победа: <b>${game.result === 'p1' ? p1 : p2}</b>!`;
    return {
      text: `${head}${p1}: ${RPS_CHOICES[game.choices.p1]}\n${p2}: ${RPS_CHOICES[game.choices.p2]}\n\n${verdict}`,
      reply_markup: { inline_keyboard: [[btn('🔄 Реванш', game, 'n')]] }
    };
  }
  // Выбор скрыт до хода обоих игроков.
  const line = (n, v) => (v ? `✅ ${n} сделал(а) выбор` : `⏳ ${n} думает…`);
  return {
    text: `${head}${line(p1, game.choices.p1)}\n${line(p2, game.choices.p2)}`,
    reply_markup: {
      inline_keyboard: [[btn(RPS_CHOICES.r, game, 'r'), btn(RPS_CHOICES.s, game, 's'), btn(RPS_CHOICES.p, game, 'p')]]
    }
  };
}

// ======================= Правда или действие =======================

export const TOD_TRUTHS = Object.freeze([
  'Какое твоё самое неловкое воспоминание из школы?',
  'Кому ты последнему написал(а) сообщение, кроме меня?',
  'Какую песню ты слушаешь на повторе, но стесняешься признаться?',
  'Был ли у тебя краш на учителя или преподавателя?',
  'Что ты делаешь, когда никто не видит?',
  'Какую самую большую глупость ты совершал(а) ради симпатии?',
  'Какое у тебя самое странное пищевое сочетание, которое ты любишь?',
  'О чём ты мечтаешь, но никому не рассказывал(а)?',
  'Какой твой самый большой страх?',
  'Было ли такое, что ты читал(а) сообщение и специально не отвечал(а)?',
  'Какое приложение ты открываешь чаще всего?',
  'Что ты подумал(а) обо мне при первом знакомстве?',
  'Какой самый безумный сон тебе снился?',
  'Если бы ты мог(ла) стать невидимым на день — что бы сделал(а)?',
  'Какую привычку ты хотел(а) бы в себе изменить?',
  'Какая твоя самая большая ложь, которая сошла с рук?',
  'Ты когда-нибудь плакал(а) из-за фильма или аниме? Из-за какого?',
  'Какой комплимент тебе запомнился больше всего?',
  'Кого из знаменитостей ты бы позвал(а) на свидание?',
  'Чего ты больше всего боишься в отношениях?',
  'Сколько времени ты в среднем проводишь в телефоне за день?',
  'Какое у тебя было самое неудачное свидание?',
  'Что ты обычно делаешь первым делом после пробуждения?',
  'Какой поступок ты бы отменил(а), если бы мог(ла)?',
  'Какое у тебя тайное хобби или увлечение?',
  'Ты когда-нибудь ревновал(а) без причины?',
  'Кто из твоих друзей знает о тебе больше всех?',
  'Какую суперсилу ты бы выбрал(а) и почему?'
]);

export const TOD_DARES = Object.freeze([
  'Отправь голосовое, где ты поёшь припев любой песни.',
  'Пришли самое смешное фото из своей галереи.',
  'Напиши мне комплимент из пяти слов, начинающихся на одну букву.',
  'Отправь селфи с самым смешным лицом, какое сможешь сделать.',
  'Следующие 3 сообщения пиши только капсом.',
  'Запиши голосовое с самым драматичным «привет», на какое способен(на).',
  'Пришли стикер, который лучше всего описывает твоё настроение.',
  'Опиши свой день, используя только эмодзи.',
  'Поставь реакцию 🔥 на пять моих последних сообщений.',
  'Напиши стихотворение из 4 строк про свой завтрак.',
  'Отправь скриншот главного экрана своего телефона.',
  'Расскажи анекдот голосовым — смеяться самому нельзя.',
  'Следующее сообщение напиши левой рукой (или носом) — без исправлений.',
  'Пришли фото того, что сейчас лежит у тебя на столе.',
  'Изобрази голосовым звук любого животного.',
  'Напиши признание в любви своему холодильнику.',
  'Пришли 3 эмодзи, которые описывают меня.',
  'Отправь мне песню, которая у тебя ассоциируется со мной.',
  'Сделай комплимент самому себе голосовым сообщением.',
  'Напиши мне сообщение в стиле официального письма.',
  'Расскажи, что ты ел(а) сегодня, как ведущий кулинарного шоу.',
  'Отправь голосовое, говоря скороговорку «Карл у Клары украл кораллы» три раза быстро.',
  'Следующие 5 минут отвечай только вопросами.',
  'Пришли фото вида из своего окна.',
  'Придумай мне смешное прозвище и обоснуй его.',
  'Опиши свою жизнь в трёх словах.',
  'Отправь мем, который недавно тебя рассмешил.',
  'Напиши текст на 2 предложения с ошибками в каждом слове.'
]);

const TOD_KIND = { t: 'truth', d: 'dare' };
const parseTodMode = (mode) => {
  const m = String(mode || '').trim().toLowerCase();
  if (['t', 'truth', 'правда', 'п'].includes(m)) return 't';
  if (['d', 'dare', 'действие', 'д'].includes(m)) return 'd';
  return null;
};

export function createTodGame({ connectionId, chatId, ownerId, ownerName, peerName, mode = null, rng = Math.random }) {
  const game = base('tod', { connectionId, chatId, ownerId, ownerName });
  game.peerName = peerName || 'Собеседник';
  game.kind = null; // null — стартовый экран; 'truth' | 'dare'
  game.card = null;
  game.cardIdx = null;
  game.count = 0;
  const m = parseTodMode(mode);
  if (m) stepTod(game, m, { rng });
  return game;
}

// t — «Правда», d — «Действие». Та же карточка подряд не повторяется.
export function stepTod(game, action, { rng = Math.random } = {}) {
  const kind = TOD_KIND[action];
  if (!kind) return fail('Неизвестное действие');
  const pool = kind === 'truth' ? TOD_TRUTHS : TOD_DARES;
  const prev = game.kind === kind ? game.cardIdx : null;
  let idx = Math.floor(rng() * pool.length) % pool.length;
  // Сдвиг на 1..len-1 гарантирует другую карточку.
  if (idx === prev) idx = (idx + 1 + Math.floor(rng() * (pool.length - 1))) % pool.length;
  game.kind = kind;
  game.cardIdx = idx;
  game.card = pool[idx];
  game.count++;
  return ok();
}

export function renderTod(game) {
  const reply_markup = { inline_keyboard: [[btn('🤔 Правда', game, 't'), btn('🔥 Действие', game, 'd')]] };
  if (!game.kind) {
    return {
      text: '🎲 <b>Правда или действие</b>\n\nВыбирайте: честный ответ или смелое задание?',
      reply_markup
    };
  }
  const title = game.kind === 'truth' ? '🤔 <b>Правда</b>' : '🔥 <b>Действие</b>';
  return {
    text: `🎲 <b>Правда или действие</b> · карточка ${game.count}\n\n${title}\n${escapeHTML(game.card)}`,
    reply_markup
  };
}

// ======================= Общий диспетчер =======================

export const renderGame = (game) => ({ saper: renderSaper, ttt: renderTtt, rps: renderRps, tod: renderTod })[game.type](game);

// Применяет действие из callback_data к партии. actor: { id, name }.
export function applyGameAction(game, action, actor, opts = {}) {
  switch (game.type) {
    case 'saper':
      if (action === 'r') return restartSaper(game);
      if (/^\d+$/.test(action)) return stepSaper(game, Number(action), { ...opts, actorName: actor?.name });
      break;
    case 'ttt':
      if (action === 'r') return restartTtt(game, actor?.id);
      if (/^\d$/.test(action)) return stepTtt(game, actor?.id, Number(action));
      break;
    case 'rps':
      if (action === 'n') return restartRps(game, actor?.id);
      return stepRps(game, actor?.id, action);
    case 'tod':
      return stepTod(game, action, opts);
    default:
  }
  return fail('Неизвестное действие');
}
