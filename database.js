import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ Ошибка: Переменная DATABASE_URL не задана в .env или на Render!');
}

const sql = postgres(connectionString, {
  ssl: 'require',
  transform: {
    undefined: null
  }
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

    console.log('✨ Облачная база данных Postgres успешно инициализирована!');
  } catch (err) {
    console.error('❌ Ошибка инициализации таблиц в Postgres:', err.message);
  }
}

initDb();

class Database {
  constructor() {
    this.repliesCache = new Map();
    this.loadCache();
  }

  async loadCache() {
    try {
      const rows = await sql`SELECT user_id, reply_text FROM custom_replies`;
      for (const row of rows) {
        this.repliesCache.set(String(row.user_id), row.reply_text);
      }
      console.log(`📦 Кэш автоответов загружен: ${this.repliesCache.size} записей.`);
    } catch (err) {
      console.error('❌ Ошибка загрузки кэша из Postgres:', err.message);
    }
  }

  async setCustomReply(userId, text) {
    const uId = String(userId);
    this.repliesCache.set(uId, text);

    try {
      await sql`
        INSERT INTO custom_replies (user_id, reply_text, updated_at)
        VALUES (${uId}, ${text}, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) 
        DO UPDATE SET reply_text = EXCLUDED.reply_text, updated_at = CURRENT_TIMESTAMP;
      `;
      console.log(`📝 Автоответ для ${uId} сохранен в облако.`);
    } catch (err) {
      console.error('❌ Ошибка записи автоответа в Postgres:', err.message);
    }
  }

    async getCustomReply(userId) {
    const uId = String(userId);
    // Если в локальном кэше процесса уже есть значение, отдаем его сразу
    if (this.repliesCache.has(uId)) {
      return this.repliesCache.get(uId);
    }
    
    // Если процесса новый и кэш пуст, делаем точечный быстрый запрос в Postgres
    try {
      const rows = await sql`SELECT reply_text FROM custom_replies WHERE user_id = ${uId}`;
      if (rows.length > 0) {
        this.repliesCache.set(uId, rows[0].reply_text);
        return rows[0].reply_text;
      }
    } catch (err) {
      console.error('❌ Ошибка точечного получения автоответа:', err.message);
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
      console.error('❌ Ошибка записи истории в Postgres:', err.message);
    }
  }
}

export const db = new Database();
