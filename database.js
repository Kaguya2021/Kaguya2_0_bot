const userSettings = new Map(); 
const chatContexts = new Map();
// Новое хранилище для кастомных текстов ответов
const customReplies = new Map(); 

export const db = {
  getAutoReplyStatus: (userId) => {
    if (!userSettings.has(userId)) {
      userSettings.set(userId, true);
    }
    return userSettings.get(userId);
  },

  toggleAutoReply: (userId) => {
    const current = db.getAutoReplyStatus(userId);
    userSettings.set(userId, !current);
    return !current;
  },

  // Сохранить кастомный текст для чата
  setCustomReply: (chatId, text) => {
    customReplies.set(chatId, text);
  },

  // Получить кастомный текст (или вернуть null, если его нет)
  getCustomReply: (chatId) => {
    return customReplies.get(chatId) || null;
  },

  saveMessage: (chatId, role, text) => {
    if (!chatContexts.has(chatId)) {
      chatContexts.set(chatId, []);
    }
    const history = chatContexts.get(chatId);
    history.push({ role, text, timestamp: Date.now() });
    
    if (history.length > 10) history.shift();
  },

  getChatHistory: (chatId) => {
    return chatContexts.get(chatId) || [];
  }
};
