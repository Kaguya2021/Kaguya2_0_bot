// Чистые функции CLI inbox: разбор аргументов и форматирование Markdown-отчёта.

export function parseInboxArgs(argv = []) {
  const opts = { ack: false, commentsOnly: false, errorsOnly: false, ids: null, out: null, limit: 100, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ack') opts.ack = true;
    else if (a === '--comments-only') opts.commentsOnly = true;
    else if (a === '--errors-only') opts.errorsOnly = true;
    else if (a === '--out') opts.out = argv[++i] || null;
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--ids') {
      const raw = argv[++i] || '';
      opts.ids = raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    } else {
      opts.error = `Неизвестный аргумент: ${a}`;
    }
  }
  if (!opts.error) {
    if (opts.commentsOnly && opts.errorsOnly) opts.error = '--comments-only и --errors-only взаимоисключающие';
    else if (opts.out === null && argv.includes('--out')) opts.error = '--out требует путь к файлу';
    else if (!Number.isInteger(opts.limit) || opts.limit < 1) opts.error = '--limit должен быть положительным целым';
    else if (opts.ids) {
      if (!opts.ids.length || opts.ids.some((n) => !Number.isInteger(n) || n < 1)) opts.error = '--ids: список положительных целых через запятую';
      else if (!opts.ack) opts.error = '--ids используется только вместе с --ack';
      else if (!opts.commentsOnly && !opts.errorsOnly) opts.error = '--ids требует --comments-only или --errors-only (ID в таблицах независимы)';
    }
  }
  return opts;
}

function fmtDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().replace('T', ' ').slice(0, 19);
}

// Текст в виде цитаты: многострочный текст не ломает структуру отчёта.
function quote(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => `> ${l}`).join('\n');
}

function author(c) {
  const parts = [];
  if (c.first_name) parts.push(c.first_name);
  if (c.username) parts.push(`@${c.username}`);
  if (c.user_id) parts.push(`id:${c.user_id}`);
  return parts.length ? parts.join(' ') : 'неизвестно';
}

export function formatInboxReport({ comments = [], errors = [], generatedAt = new Date() } = {}) {
  const lines = [
    '# Kaguya inbox',
    '',
    `Сформировано: ${fmtDate(generatedAt)} UTC`,
    `Новых комментариев: ${comments.length}, новых ошибок: ${errors.length}`,
    ''
  ];

  if (!comments.length && !errors.length) {
    lines.push('_Инбокс пуст: новых комментариев и ошибок нет._', '');
    return lines.join('\n');
  }

  lines.push(`## Комментарии (${comments.length})`, '');
  if (!comments.length) lines.push('_Нет новых комментариев._', '');
  for (const c of comments) {
    lines.push(
      `### Комментарий #${c.id}`,
      `- Дата: ${fmtDate(c.created_at)}`,
      `- Автор: ${author(c)}`,
      `- chat_id: ${c.chat_id}, message_id: ${c.message_id}`,
      `- reply_to_message_id: ${c.reply_to_message_id ?? '—'}, thread_id: ${c.thread_id ?? '—'}`,
      '',
      quote(c.text),
      ''
    );
  }

  lines.push(`## Ошибки бота (${errors.length})`, '');
  if (!errors.length) lines.push('_Нет новых ошибок._', '');
  for (const e of errors) {
    lines.push(
      `### Ошибка #${e.id}`,
      `- Дата: ${fmtDate(e.created_at)}`,
      `- chat_id: ${e.chat_id ?? '—'}`,
      '',
      quote(e.content),
      ''
    );
  }

  lines.push(
    '---',
    `ID комментариев: ${comments.map((c) => c.id).join(',') || '—'}`,
    `ID ошибок: ${errors.map((e) => e.id).join(',') || '—'}`,
    ''
  );
  return lines.join('\n');
}
