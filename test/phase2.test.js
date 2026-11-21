import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractChannelComment } from '../src/services/comments.js';
import {
  validateDraft,
  isAllowedButtonUrl,
  buildPostKeyboard,
  buildApprovalKeyboard,
  buildSendPayload,
  MAX_TEXT_LENGTH,
  MAX_CAPTION_LENGTH
} from '../src/services/publishing.js';
import { formatInboxReport, parseInboxArgs } from '../src/services/inbox.js';

const GROUP = '-1001234567890';
const msg = (over = {}) => ({
  message_id: 42,
  chat: { id: Number(GROUP), type: 'supergroup' },
  from: { id: 777, is_bot: false, username: 'alice', first_name: 'Alice' },
  text: 'Классный бот, но нет тёмной темы',
  ...over
});

describe('extractChannelComment', () => {
  test('выключено без DISCUSSION_GROUP_ID', () => {
    assert.equal(extractChannelComment(msg(), ''), null);
  });

  test('игнорирует чужой chat_id', () => {
    assert.equal(extractChannelComment(msg({ chat: { id: -100999, type: 'supergroup' } }), GROUP), null);
  });

  test('игнорирует ботов', () => {
    assert.equal(extractChannelComment(msg({ from: { id: 1, is_bot: true } }), GROUP), null);
  });

  test('игнорирует автопересылку поста из канала и сообщения от имени канала', () => {
    assert.equal(extractChannelComment(msg({ is_automatic_forward: true }), GROUP), null);
    assert.equal(extractChannelComment(msg({ sender_chat: { id: -100555, type: 'channel' } }), GROUP), null);
  });

  test('игнорирует сообщения без текста и подписи', () => {
    assert.equal(extractChannelComment(msg({ text: undefined, sticker: { file_id: 'x' } }), GROUP), null);
    assert.equal(extractChannelComment(msg({ text: '   ' }), GROUP), null);
    assert.equal(extractChannelComment(msg({ text: undefined, new_chat_members: [{ id: 1 }] }), GROUP), null);
  });

  test('принимает обычный комментарий (ответ на пост в треде)', () => {
    const c = extractChannelComment(
      msg({ reply_to_message: { message_id: 10 }, message_thread_id: 10 }),
      GROUP
    );
    assert.deepEqual(c, {
      chat_id: GROUP,
      message_id: 42,
      reply_to_message_id: 10,
      thread_id: 10,
      user_id: '777',
      username: 'alice',
      first_name: 'Alice',
      text: 'Классный бот, но нет тёмной темы'
    });
  });

  test('принимает фото с подписью', () => {
    const c = extractChannelComment(msg({ text: undefined, photo: [{ file_id: 'p' }], caption: 'Скрин бага' }), GROUP);
    assert.equal(c.text, 'Скрин бага');
    assert.equal(c.reply_to_message_id, null);
  });
});

describe('validateDraft', () => {
  const good = { html_text: '<b>Привет</b>', buttons: [[{ text: 'Сайт', url: 'https://example.com' }]] };

  test('валидный пост', () => {
    const r = validateDraft(good);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.draft.htmlText, '<b>Привет</b>');
    assert.equal(r.draft.mediaType, null);
  });

  test('валидный пост с фото и tg:// кнопкой', () => {
    const r = validateDraft({ html_text: 'x', media_type: 'photo', media_file_id: 'AgACAgIAAxk', buttons: [[{ text: 't', url: 'tg://resolve?domain=kaguya' }]] });
    assert.equal(r.ok, true, r.errors.join('; '));
  });

  test('пустой текст', () => {
    assert.equal(validateDraft({ html_text: '' }).ok, false);
    assert.equal(validateDraft({ html_text: '   ' }).ok, false);
    assert.equal(validateDraft({}).ok, false);
  });

  test('превышение 4096 символов текста', () => {
    assert.equal(validateDraft({ html_text: 'a'.repeat(MAX_TEXT_LENGTH) }).ok, true);
    assert.equal(validateDraft({ html_text: 'a'.repeat(MAX_TEXT_LENGTH + 1) }).ok, false);
  });

  test('HTML-теги не учитываются в лимите', () => {
    assert.equal(validateDraft({ html_text: `<b>${'a'.repeat(MAX_TEXT_LENGTH)}</b>` }).ok, true);
  });

  test('превышение 1024 символов подписи к медиа', () => {
    const base = { media_type: 'video', media_file_id: 'https://example.com/v.mp4' };
    assert.equal(validateDraft({ ...base, html_text: 'a'.repeat(MAX_CAPTION_LENGTH) }).ok, true);
    assert.equal(validateDraft({ ...base, html_text: 'a'.repeat(MAX_CAPTION_LENGTH + 1) }).ok, false);
  });

  test('невалидный URL в кнопке отклоняется (javascript:)', () => {
    const r = validateDraft({ html_text: 'x', buttons: [[{ text: 'click', url: 'javascript:alert(1)' }]] });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /url/);
  });

  test('проверка URL и структуры кнопок', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,1', 'ftp://x.y', 'https://', 'example.com', '', null]) {
      assert.equal(isAllowedButtonUrl(bad), false, String(bad));
    }
    assert.equal(validateDraft({ html_text: 'x', buttons: { text: 'a' } }).ok, false);
    assert.equal(validateDraft({ html_text: 'x', buttons: [[{ text: '', url: 'https://a.b' }]] }).ok, false);
    assert.equal(validateDraft({ html_text: 'x', buttons: [[]] }).ok, false);
  });

  test('неизвестный media_type и медиа без file_id', () => {
    assert.equal(validateDraft({ html_text: 'x', media_type: 'audio', media_file_id: 'a' }).ok, false);
    assert.equal(validateDraft({ html_text: 'x', media_type: 'photo' }).ok, false);
  });
});

describe('клавиатуры', () => {
  const buttons = [[{ text: 'A', url: 'https://a.example' }, { text: 'B', url: 'https://b.example' }]];
  const allCallbacks = (kb) => kb.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);

  test('buildPostKeyboard — только URL-кнопки, без draft_approve', () => {
    const kb = buildPostKeyboard(buttons);
    assert.equal(kb.inline_keyboard.length, 1);
    assert.deepEqual(allCallbacks(kb), []);
    assert.ok(!JSON.stringify(kb).includes('draft_approve'));
    assert.equal(buildPostKeyboard(null), null);
    assert.equal(buildPostKeyboard([]), null);
  });

  test('buildApprovalKeyboard — ряд одобрения последним', () => {
    const kb = buildApprovalKeyboard(buttons, 15);
    assert.equal(kb.inline_keyboard.length, 2);
    assert.deepEqual(kb.inline_keyboard[0], buildPostKeyboard(buttons).inline_keyboard[0]);
    const last = kb.inline_keyboard.at(-1);
    assert.deepEqual(last.map((b) => b.callback_data), ['draft_approve:15', 'draft_cancel:15']);
  });

  test('buildApprovalKeyboard без кнопок поста', () => {
    const kb = buildApprovalKeyboard(null, 3);
    assert.equal(kb.inline_keyboard.length, 1);
    assert.deepEqual(allCallbacks(kb), ['draft_approve:3', 'draft_cancel:3']);
  });

  test('buildSendPayload выбирает метод по media_type', () => {
    assert.equal(buildSendPayload({ html_text: 't' }, 1).method, 'sendMessage');
    const p = buildSendPayload({ html_text: 't', media_type: 'photo', media_file_id: 'f' }, 1);
    assert.equal(p.method, 'sendPhoto');
    assert.equal(p.args[2].caption, 't');
    assert.equal(p.args[2].parse_mode, 'HTML');
    assert.equal(buildSendPayload({ html_text: 't', media_type: 'video', media_file_id: 'f' }, 1).method, 'sendVideo');
  });
});

describe('inbox', () => {
  const at = new Date('2026-11-22T10:00:00Z');

  test('пустой инбокс', () => {
    const md = formatInboxReport({ comments: [], errors: [], generatedAt: at });
    assert.match(md, /^# Kaguya inbox/);
    assert.match(md, /Инбокс пуст/);
    assert.match(md, /Новых комментариев: 0, новых ошибок: 0/);
  });

  test('отчёт с комментариями и ошибками', () => {
    const md = formatInboxReport({
      generatedAt: at,
      comments: [
        { id: 5, chat_id: GROUP, message_id: 42, reply_to_message_id: 10, thread_id: 10, user_id: '777', username: 'alice', first_name: 'Alice', text: 'Строка 1\nСтрока 2', created_at: at },
        { id: 6, chat_id: GROUP, message_id: 43, reply_to_message_id: null, thread_id: null, user_id: null, username: null, first_name: null, text: 'Аноним', created_at: at }
      ],
      errors: [{ id: 9, chat_id: '123', content: '[business_message] Bad Request', created_at: at }]
    });
    assert.match(md, /## Комментарии \(2\)/);
    assert.match(md, /### Комментарий #5/);
    assert.match(md, /Автор: Alice @alice id:777/);
    assert.match(md, /reply_to_message_id: 10/);
    assert.match(md, /> Строка 1\n> Строка 2/);
    assert.match(md, /Автор: неизвестно/);
    assert.match(md, /## Ошибки бота \(1\)/);
    assert.match(md, /### Ошибка #9/);
    assert.match(md, /> \[business_message\] Bad Request/);
    assert.match(md, /2026-11-22 10:00:00/);
    assert.match(md, /ID комментариев: 5,6/);
    assert.match(md, /ID ошибок: 9/);
  });

  test('parseInboxArgs', () => {
    assert.deepEqual(
      parseInboxArgs(['--ack', '--comments-only', '--ids', '1,2,3']),
      { ack: true, commentsOnly: true, errorsOnly: false, ids: [1, 2, 3], out: null, limit: 100, error: null }
    );
    assert.equal(parseInboxArgs(['--out', 'inbox-report.md']).out, 'inbox-report.md');
    assert.ok(parseInboxArgs(['--ack', '--ids', '1']).error, '--ids без указания таблицы');
    assert.ok(parseInboxArgs(['--ids', '1', '--comments-only']).error, '--ids без --ack');
    assert.ok(parseInboxArgs(['--ack', '--errors-only', '--ids', '1,x']).error);
    assert.ok(parseInboxArgs(['--comments-only', '--errors-only']).error);
    assert.ok(parseInboxArgs(['--bogus']).error);
  });
});
