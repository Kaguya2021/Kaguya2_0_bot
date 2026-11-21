// Репозиторий канала: channel_comments (фидбек из группы обсуждений) и post_drafts (Human-in-the-loop).
import { sql } from './client.js';
import { ensureSchema } from './migrations.js';
import { assertStatus, normalizeIds, cut, strOrNull, COMMENT_STATUSES, DRAFT_STATUSES } from './helpers.js';

export const channelRepo = {
  saveChannelComment: async (c) => {
    await ensureSchema();
    return sql`
      INSERT INTO channel_comments
        (chat_id, message_id, reply_to_message_id, thread_id, user_id, username, first_name, text)
      VALUES (
        ${String(c.chat_id)}, ${c.message_id}, ${c.reply_to_message_id ?? null}, ${c.thread_id ?? null},
        ${strOrNull(c.user_id)}, ${cut(c.username, 100)}, ${cut(c.first_name, 100)}, ${c.text}
      )
      ON CONFLICT (chat_id, message_id) DO NOTHING;
    `;
  },

  getNewComments: async (limit = 100) => {
    await ensureSchema();
    return sql`
      SELECT id, chat_id, message_id, reply_to_message_id, thread_id, user_id, username, first_name, text, created_at
      FROM channel_comments WHERE status = 'new'
      ORDER BY id ASC LIMIT ${limit};
    `;
  },

  markCommentsStatus: async (ids, status) => {
    await ensureSchema();
    assertStatus(COMMENT_STATUSES, status);
    const list = normalizeIds(ids);
    if (list && !list.length) return 0;
    const res = list
      ? await sql`UPDATE channel_comments SET status = ${status} WHERE id = ANY(${list}::int[]) RETURNING id;`
      : await sql`UPDATE channel_comments SET status = ${status} WHERE status = 'new' RETURNING id;`;
    return res.length;
  },

  createPostDraft: async ({ htmlText, buttons, mediaType, mediaFileId, createdBy }) => {
    await ensureSchema();
    const res = await sql`
      INSERT INTO post_drafts (html_text, buttons_json, media_type, media_file_id, created_by)
      VALUES (
        ${htmlText}, ${buttons && buttons.length ? sql.json(buttons) : null},
        ${mediaType || null}, ${mediaFileId || null}, ${strOrNull(createdBy)}
      )
      RETURNING *;
    `;
    return res[0];
  },

  getPostDraft: async (id) => {
    await ensureSchema();
    const res = await sql`SELECT * FROM post_drafts WHERE id = ${id};`;
    return res[0] || null;
  },

  claimDraftForPublishing: async (id) => {
    await ensureSchema();
    const res = await sql`
      UPDATE post_drafts SET status = 'publishing'
      WHERE id = ${id} AND status = 'pending_approval'
      RETURNING *;
    `;
    return res[0] || null;
  },

  markDraftPublished: async (id, { approvedBy, publishedMessageId }) => {
    await ensureSchema();
    const res = await sql`
      UPDATE post_drafts
      SET status = 'published', approved_by = ${strOrNull(approvedBy)},
          published_message_id = ${publishedMessageId ?? null}, published_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
      RETURNING *;
    `;
    return res[0] || null;
  },

  markDraftStatus: async (id, status, approvedBy = null, fromStatus = null) => {
    await ensureSchema();
    assertStatus(DRAFT_STATUSES, status);
    const by = strOrNull(approvedBy);
    const res = fromStatus
      ? await sql`
          UPDATE post_drafts SET status = ${status}, approved_by = COALESCE(${by}, approved_by)
          WHERE id = ${id} AND status = ${fromStatus} RETURNING *;`
      : await sql`
          UPDATE post_drafts SET status = ${status}, approved_by = COALESCE(${by}, approved_by)
          WHERE id = ${id} RETURNING *;`;
    return res[0] || null;
  }
};
