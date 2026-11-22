// Общие хелперы .команд (без зависимостей от роутера — нет циклических импортов).
import { deleteBusinessNow } from '../services/deleteQueue.js';

export const RIGHTS_HINT =
  'Включите право <b>«Удаление всех сообщений»</b>:\n' +
  '<i>Настройки → Telegram Business → Чат-боты → @Kaguya_2_0bot</i>';

// Сообщение владельцу в личку бота (не бросает).
export async function notifyOwner(api, ownerId, html) {
  try {
    await api.sendMessage(ownerId, html, { parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (e) {
    return false;
  }
}

// Удаление триггера .команды (best-effort, не бросает).
export async function deleteTrigger(api, connectionId, messageId) {
  try {
    await deleteBusinessNow(api, connectionId, [messageId]);
    return true;
  } catch (e) {
    return false;
  }
}

export function chatTitle(chat) {
  if (!chat) return 'чат';
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '';
  const user = chat.username ? ` (@${chat.username})` : '';
  return `${name || `ID ${chat.id}`}${user}`;
}

export const errText = (e) => e?.description || e?.message || 'ошибка';
