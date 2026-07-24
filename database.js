import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ Ошибка: DATABASE_URL не задан!');
}

const sql = postgres(connectionString, {
  ssl: { rejectUnauthorized: false },
  connect_timeout: 10,
  idle_timeout: 15,
  max: 10
});

async function initDb() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS custom_replies (
        user_id TEXT PRIMARY KEY,
        reply_text TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS chat_history (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        message_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // Создаём таблицу для хранения пауз
    await sql`
      CREATE TABLE IF NOT EXISTS chat_pauses (
        chat_id TEXT PRIMARY KEY,
        pause_until TIMESTAMP NOT NULL
      );
    `;

    console.log('✨ Все таблицы Postgres успешно подготовлены!');
  } catch (err) {
    console.error('❌ Ошибка инициализации Postgres:', err.message);
  }
}

initDb();

class Database {
  constructor() {
    this.repliesCache = new Map();
  }

  // Установка автоответа
  async setCustomReply(userId, text) {
    if (!userId) return;
    const uId = String(userId).trim();
    this.repliesCache.set(uId, text);

    try {
      await sql`
        INSERT INTO custom_replies (user_id, reply_text, updated_at)
        VALUES (${uId}, ${text}, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) 
        DO UPDATE SET reply_text = EXCLUDED.reply_text, updated_at = CURRENT_TIMESTAMP;
      `;
      console.log(`📝 [БД] Автоответ сохранен для ${uId}`);
    } catch (err) {
      console.error('❌ Ошибка записи в Postgres:', err.message);
    }
  }

  // Получение автоответа
  async getCustomReply(userId) {
    if (!userId) return null;
    const uId = String(userId).trim();

    if (this.repliesCache.has(uId)) {
      return this.repliesCache.get(uId);
    }

    try {
      const rows = await sql`SELECT reply_text FROM custom_replies WHERE user_id = ${uId}`;
      if (rows && rows.length > 0) {
        const reply = rows[0].reply_text;
        this.repliesCache.set(uId, reply);
        return reply;
      }
    } catch (err) {
      console.error('❌ Ошибка чтения из Postgres:', err.message);
    }

    return null;
  }

  // Установка паузы в чате
  async setPause(chatId, durationMs) {
    try {
      const pauseUntil = new Date(Date.now() + durationMs);
      await sql`
        INSERT INTO chat_pauses (chat_id, pause_until)
        VALUES (${String(chatId)}, ${pauseUntil})
        ON CONFLICT (chat_id) 
        DO UPDATE SET pause_until = EXCLUDED.pause_until;
      `;
      console.log(`⏳ [БД] Пауза для чата ${chatId} установлена до ${pauseUntil.toISOString()}`);
    } catch (err) {
      console.error('❌ Ошибка сохранения паузы:', err.message);
    }
  }

  // Проверка активна ли пауза
  async isPaused(chatId) {
    try {
      const rows = await sql`
        SELECT pause_until FROM chat_pauses 
        WHERE chat_id = ${String(chatId)} AND pause_until > CURRENT_TIMESTAMP;
      `;
      return rows.length > 0;
    } catch (err) {
      console.error('❌ Ошибка проверки паузы:', err.message);
      return false;
    }
  }

  // Сохранение истории сообщений
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

