// Чистая фильтрация комментариев из группы обсуждений канала (без БД и сети).

// Возвращает объект для db.saveChannelComment или null, если сообщение не нужно сохранять.
// message — объект Message из Telegram Bot API (ctx.message).
export function extractChannelComment(message, discussionGroupId) {
  if (!discussionGroupId || !message) return null;
  if (String(message.chat?.id) !== String(discussionGroupId)) return null;

  // Посты канала, автоматически пересланные в группу обсуждений, и сообщения от имени канала.
  if (message.is_automatic_forward === true) return null;
  if (message.sender_chat?.type === 'channel') return null;
  if (message.from?.is_bot) return null;

  const text = typeof message.text === 'string' ? message.text : message.caption;
  if (typeof text !== 'string' || !text.trim()) return null;

  return {
    chat_id: String(message.chat.id),
    message_id: message.message_id,
    reply_to_message_id: message.reply_to_message?.message_id ?? null,
    thread_id: message.message_thread_id ?? null,
    user_id: message.from?.id != null ? String(message.from.id) : null,
    username: message.from?.username ?? null,
    first_name: message.from?.first_name ?? null,
    text
  };
}
