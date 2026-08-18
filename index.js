import express from 'express';
import { webhookCallback } from 'grammy';
import { bot } from './bot.js';

const app = express();
app.use(express.json());

// Эндпоинт для проверки активности
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Авто-пинг каждые 10 минут
const RENDER_URL = process.env.RENDER_EXTERNAL_URL; // Render автоматически создает эту переменную
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/ping`);
      console.log('📡 Пинг успешно отправлен, бот бодрствует!');
    } catch (e) {
      console.error('Ошибка само-пинга:', e.message);
    }
  }, 10 * 60 * 1000); // 10 минут
}

// Главная страница для проверки
app.get('/', (req, res) => {
  res.send('Кагуя успешно запущена на Render!');
});

// Настройка вебхука от Telegram
app.post('/api/webhook', webhookCallback(bot, 'express'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер слушает порт ${PORT}`);
});

export default app;
