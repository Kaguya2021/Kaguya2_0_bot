// Чистые функции для .команд владельца в Telegram Business (без БД и сети).

// --- Парсинг .команды ---

// Имя команды начинается с буквы; дальше буквы, цифры и _ (кастомные RP-триггеры).
const DOT_COMMAND_RE = /^\.([a-zа-яё][a-zа-яё0-9_]*)(?:\s+([\s\S]*))?$/i;

// ".mute" -> { command: 'mute', args: '', raw }; "..", "...", "текст", ". x" -> null.
export function parseDotCommand(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw.startsWith('.') || raw.startsWith('..')) return null;
  const m = DOT_COMMAND_RE.exec(raw);
  if (!m) return null;
  return { command: m[1].toLowerCase(), args: (m[2] || '').trim(), raw };
}

// --- Смена раскладки EN <-> RU ---

const EN_KEYS = "`qwertyuiop[]asdfghjkl;'zxcvbnm,./~QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>?";
const RU_KEYS = 'ёйцукенгшщзхъфывапролджэячсмитьбю.ЁЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ,';

const EN_TO_RU = new Map();
const RU_TO_EN = new Map();
for (let i = 0; i < EN_KEYS.length; i++) {
  EN_TO_RU.set(EN_KEYS[i], RU_KEYS[i]);
  RU_TO_EN.set(RU_KEYS[i], EN_KEYS[i]);
}

// Направление выбирается по преобладающему алфавиту: латиницы больше -> EN->RU, иначе RU->EN.
export function switchLayout(text) {
  if (typeof text !== 'string' || !text) return '';
  const latin = (text.match(/[a-z]/gi) || []).length;
  const cyrillic = (text.match(/[а-яё]/gi) || []).length;
  if (!latin && !cyrillic) return text;
  const map = latin >= cyrillic ? EN_TO_RU : RU_TO_EN;
  let out = '';
  for (const ch of text) out += map.get(ch) ?? ch;
  return out;
}

// --- Длительность: 30s, 2m, 1h, 30с, 5м, 1ч, 500ms; без единицы — секунды ---

const UNIT_MS = {
  ms: 1, мс: 1,
  s: 1000, sec: 1000, с: 1000, сек: 1000,
  m: 60_000, min: 60_000, м: 60_000, мин: 60_000,
  h: 3_600_000, ч: 3_600_000
};

// Возвращает миллисекунды, зажатые в [minMs, maxMs], или null (не длительность / 0).
export function parseDurationMs(token, { minMs = 3000, maxMs = 600_000 } = {}) {
  if (typeof token !== 'string') return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*([a-zа-яё]*)$/i.exec(token.trim());
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase() || 's';
  const factor = UNIT_MS[unit];
  if (!factor || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(maxMs, Math.max(minMs, Math.round(value * factor)));
}

// --- Безопасный калькулятор (рекурсивный спуск, без eval/new Function) ---

const MAX_EXPR_LENGTH = 200;
const MAX_DEPTH = 50;

function tokenize(expr) {
  const tokens = [];
  const s = expr.replace(/[×х]/g, '*').replace(/[÷:]/g, '/').replace(/−/g, '-');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[\d.,]/.test(ch)) {
      let j = i;
      while (j < s.length && /[\d.,]/.test(s[j])) j++;
      const raw = s.slice(i, j).replace(',', '.');
      if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) throw new Error('Некорректное число');
      tokens.push({ type: 'num', value: Number(raw) });
      i = j;
      continue;
    }
    if ('+-*/%^()'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    throw new Error(`Недопустимый символ: ${ch}`);
  }
  return tokens;
}

export function safeCalc(expr) {
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('Пустое выражение');
  if (expr.length > MAX_EXPR_LENGTH) throw new Error('Слишком длинное выражение');
  const tokens = tokenize(expr);
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const isOp = (v) => peek()?.type === 'op' && peek().value === v;
  const check = (n) => {
    if (!Number.isFinite(n)) throw new Error('Переполнение');
    return n;
  };

  function parseExpr() {
    if (++depth > MAX_DEPTH) throw new Error('Слишком глубокая вложенность');
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      left = check(op === '+' ? left + right : left - right);
    }
    depth--;
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[pos++].value;
      const right = parseUnary();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Деление на ноль');
      left = check(op === '*' ? left * right : op === '/' ? left / right : left % right);
    }
    return left;
  }

  function parseUnary() {
    if (isOp('-') || isOp('+')) {
      const op = tokens[pos++].value;
      if (++depth > MAX_DEPTH) throw new Error('Слишком глубокая вложенность');
      const v = parseUnary();
      depth--;
      return op === '-' ? -v : v;
    }
    return parsePower();
  }

  // Степень правоассоциативна: 2^3^2 = 2^9; -2^2 = -4.
  function parsePower() {
    const base = parsePrimary();
    if (isOp('^')) {
      pos++;
      if (++depth > MAX_DEPTH) throw new Error('Слишком глубокая вложенность');
      const exp = parseUnary();
      depth--;
      return check(base ** exp);
    }
    return base;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Неожиданный конец выражения');
    if (t.type === 'num') {
      pos++;
      return t.value;
    }
    if (isOp('(')) {
      pos++;
      const v = parseExpr();
      if (!isOp(')')) throw new Error('Не закрыта скобка');
      pos++;
      return v;
    }
    throw new Error(`Неожиданный символ: ${t.value}`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error(`Неожиданный символ: ${tokens[pos].value}`);
  if (Number.isNaN(result)) throw new Error('Не число');
  // Убираем артефакты плавающей точки (0.1 + 0.2 -> 0.3), -0 -> 0.
  const rounded = Number(check(result).toPrecision(12));
  return rounded === 0 ? 0 : rounded;
}

// --- Краткое описание сообщения для кэша анти-удаления ---

export const MAX_SUMMARY_LENGTH = 4000;

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const withCaption = (label, msg) => (msg.caption ? `${label} ${msg.caption}` : label);

// msg -> { msgType, content }. Медиа не скачиваем — только тип, подпись и метаданные.
export function extractMessageSummary(msg) {
  if (!msg || typeof msg !== 'object') return { msgType: 'other', content: '' };
  let msgType;
  let content;
  if (typeof msg.text === 'string') {
    msgType = 'text'; content = msg.text;
  } else if (msg.photo) {
    msgType = 'photo'; content = withCaption('[Фото]', msg);
  } else if (msg.animation) { // у GIF есть и document — проверяем раньше
    msgType = 'animation'; content = withCaption('[GIF]', msg);
  } else if (msg.video) {
    msgType = 'video'; content = withCaption(`[Видео ${formatDuration(msg.video.duration)}]`, msg);
  } else if (msg.video_note) {
    msgType = 'video_note'; content = `[Кружок ${formatDuration(msg.video_note.duration)}]`;
  } else if (msg.voice) {
    msgType = 'voice'; content = withCaption(`[Голосовое ${formatDuration(msg.voice.duration)}]`, msg);
  } else if (msg.audio) {
    const name = [msg.audio.performer, msg.audio.title].filter(Boolean).join(' – ') || msg.audio.file_name || 'аудио';
    msgType = 'audio'; content = withCaption(`[Аудио: ${name} ${formatDuration(msg.audio.duration)}]`, msg);
  } else if (msg.document) {
    msgType = 'document'; content = withCaption(`[Документ: ${msg.document.file_name || 'файл'}]`, msg);
  } else if (msg.sticker) {
    msgType = 'sticker'; content = `[Стикер${msg.sticker.emoji ? ` ${msg.sticker.emoji}` : ''}]`;
  } else if (msg.location) {
    msgType = 'location'; content = `[Геолокация ${msg.location.latitude}, ${msg.location.longitude}]`;
  } else if (msg.contact) {
    const name = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ');
    msgType = 'contact'; content = `[Контакт: ${name}${msg.contact.phone_number ? ` ${msg.contact.phone_number}` : ''}]`;
  } else if (msg.poll) {
    msgType = 'poll'; content = `[Опрос: ${msg.poll.question}]`;
  } else if (msg.dice) {
    msgType = 'dice'; content = `[Кубик ${msg.dice.emoji} = ${msg.dice.value}]`;
  } else {
    msgType = 'other'; content = '[Сообщение]';
  }
  return { msgType, content: String(content).slice(0, MAX_SUMMARY_LENGTH) };
}

// Имя отправителя: "Имя Фамилия" -> "@username" -> "ID 123".
export function formatSenderName(user) {
  if (!user) return 'Неизвестный';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (user.username) return `@${user.username}`;
  return user.id !== undefined ? `ID ${user.id}` : 'Неизвестный';
}
