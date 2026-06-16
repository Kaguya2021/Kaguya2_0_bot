// Имитация базы данных в памяти
// Хранит настройки пользователей (включен ли автоответчик)
const userSettings = new Map(); 

// Хранит контекст диалогов (историю сообщений для каждого чата)
const chatContexts = new Map();

export const db = {
  // Получить настройки автоответа (по умолчанию - включен)
  getAutoReplyStatus: (userId) => {
    if (!userSettings.has(userId)) {
      userSettings.set(userId, true);
    }
    return userSettings.get(userId);
  },

  // Переключить статус автоответа
  toggleAutoReply: (userId) => {
    const current = db.getAutoReplyStatus(userId);
    userSettings.set(userId, !current);
    return !current;
  },

  // Сохранить сообщение в контекст для имитации памяти диалога
  saveMessage: (chatId, role, text) => {
    if (!chatContexts.has(chatId)) {
      chatContexts.set(chatId, []);
    }
    const history = chatContexts.get(chatId);
    history.push({ role, text, timestamp: Date.now() });
    
    // Ограничиваем историю последними 10 сообщениями, чтобы не перегружать память
    if (history.length > 10) history.shift();
  },

  // Получить всю историю переписки по чату
  getChatHistory: (chatId) => {
    return chatContexts.get(chatId) || [];
  }
};
