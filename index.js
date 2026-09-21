import express from 'express';
import { webhookCallback } from 'grammy';
import { bot } from './bot.js';

const app = express();
app.use(express.json());

// Подавляет вывод 403 ошибок в консоль
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (
    reason?.error_code === 403 ||
    msg.includes('blocked by the user') ||
    msg.includes('user is deactivated')
  ) {
    return;
  }
  console.error('Unhandled Rejection:', reason);
});

// Эндпоинт для вашей внешней бот-пинговалки
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Главная страница проверки статуса
app.get('/', (req, res) => {
  res.send('Кагуя успешно запущена на Render!');
});

// Обработчик вебхука от Telegram
app.post('/api/webhook', webhookCallback(bot, 'express'));

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://kaguya2-0-bot-say4.onrender.com';

app.listen(PORT, async () => {
  console.log(`🚀 Сервер слушает порт ${PORT}`);

  try {
    const webhookUrl = `${RENDER_URL}/api/webhook`;
    await bot.api.setWebhook(webhookUrl);
    console.log(`🔗 Webhook успешно установлен на: ${webhookUrl}`);
  } catch (err) {
    console.error('❌ Ошибка при установке Webhook:', err.message);
  }
});

export default app;
