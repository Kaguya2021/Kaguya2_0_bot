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

// 1. Эндпоинт для внешних пинговалок
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// 2. Главная страница проверки статуса
app.get('/', (req, res) => {
  res.send('Кагуя успешно запущена на Render!');
});

// 3. Обработчик вебхука от Telegram
app.post('/api/webhook', webhookCallback(bot, 'express'));

// 4. Бесшумный само-пинг (работает молча, логов нет)
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://kaguya2-0-bot-say4.onrender.com';

setInterval(async () => {
  try {
    await fetch(`${RENDER_URL}/ping`);
  } catch (e) {
    // Никаких логов даже при отправке
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
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
