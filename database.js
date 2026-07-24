import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: DATABASE_URL не найден в process.env!');
}

// Настраиваем подключение с таймаутами для Serverless (Vercel)
const sql = postgres(connectionString, {
  ssl: { rejectUnauthorized: false }, // Обход строгого SSL для Supabase/Neon/Render Postgres
  connect_timeout: 10,
  idle_timeout: 15,
  max: 10
});

class Database {
  constructor() {
    this.repliesCache = new Map();
  }

  // Запись автоответа
  async setCustomReply(userId, text) {
    if (!userId) return;
    const uId = String(userId).trim();
    
    // Сразу обновляем локальный кэш
    this.repliesCache.set(uId, text);

    try {
      await sql`
        INSERT INTO custom_replies (user_id, reply_text, updated_at)
        VALUES (${uId}, ${text}, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) 
        DO UPDATE SET reply_text = EXCLUDED.reply_text, updated_at = CURRENT_TIMESTAMP;
      `;
      console.log(`✅ [БД] Автоответ сохранен для ID: ${uId}`);
    } catch (err) {
      console.error(`❌ [БД Ошибка записи] ID ${uId}:`, err.message);
    }
  }

  // Чтение автоответа
  async getCustomReply(userId) {
    if (!userId) return null;
    const uId = String(userId).trim();

    // 1. Проверяем кэш
    if (this.repliesCache.has(uId)) {
      console.log(`🎯 [БД] Ответ для ${uId} взят из КЭША`);
      return this.repliesCache.get(uId);
    }
    
    // 2. Читаем из Postgres
    try {
      const rows = await sql`SELECT reply_text FROM custom_replies WHERE user_id = ${uId}`;
      if (rows && rows.length > 0) {
        const reply = rows[0].reply_text;
        this.repliesCache.set(uId, reply);
        console.log(`📥 [БД] Ответ для ${uId} загружен из POSTGRES: "${reply}"`);
        return reply;
      } else {
        console.log(`⚠️ [БД] Запись для ${uId} в базах данных НЕ НАЙДЕНА.`);
      }
    } catch (err) {
      console.error(`❌ [БД Ошибка чтения] ID ${uId}:`, err.message);
    }

    return null;
  }
  
  async saveMessage(chatId, role, text) {
    try {
      await sql`
        INSERT INTO chat_history (chat_id, role, message_text)
        VALUES (${String(chatId)}, ${role}, ${text});
      `;
    } catch (err) {
      console.error('❌ Ошибка записи истории:', err.message);
    }
  }
}

export const db = new Database();

