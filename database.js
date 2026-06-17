import fs from 'fs';
import path from 'path';

// Если бот на Render, сохраняем в папку /data (это будет наш постоянный диск)
// Если запускаешь на телефоне, сохранится в текущую папку проекта
const IS_RENDER = process.env.RENDER === 'true' || fs.existsSync('/opt/render');
const DB_DIR = IS_RENDER ? '/data' : path.resolve('./');
const DB_FILE = path.join(DB_DIR, 'database.json');

// Проверяем наличие папки /data (на случай локальных тестов)
if (IS_RENDER && !fs.existsSync('/data')) {
  try {
    fs.mkdirSync('/data', { recursive: true });
  } catch (e) {
    console.error('Не удалось создать папку /data, сохраняем локально:', e.message);
  }
}

class Database {
  constructor() {
    this.data = {
      replies: {}, // userId -> customText
      history: {}  // chatId -> messages[]
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(raw);
        console.log(`💾 База данных успешно загружена из: ${DB_FILE}`);
      } else {
        this.save();
      }
    } catch (err) {
      console.error('❌ Ошибка при загрузке базы данных:', err.message);
    }
  }

  save() {
    try {
      // Используем синхронную запись во временный файл, чтобы не повредить базу
      const tempFile = DB_FILE + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (err) {
      console.error('❌ Ошибка при сохранении базы данных:', err.message);
    }
  }

  setCustomReply(userId, text) {
    this.data.replies[String(userId)] = text;
    this.save();
  }

  getCustomReply(userId) {
    return this.data.replies[String(userId)] || null;
  }

  saveMessage(chatId, role, text) {
    const id = String(chatId);
    if (!this.data.history[id]) {
      this.data.history[id] = [];
    }
    this.data.history[id].push({ role, text, timestamp: Date.now() });
    // Храним только последние 50 сообщений в истории чата, чтобы файл не раздувался
    if (this.data.history[id].length > 50) {
      this.data.history[id].shift();
    }
    this.save();
  }
}

export const db = new Database();
