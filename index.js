import express from 'express';
import { webhookCallback } from 'grammy';
import { bot } from './bot.js';

const app = express();
app.use(express.json());

// Подавляет вывод 403 ошибок в консоль Render
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (
    reason?.error_code === 403 ||
    msg.includes('blocked by the user') ||
    msg.includes('user is deactivated')
  ) {
    return; // Просто игнорируем
  }
  console.error('Unhandled Rejection:', reason);
});

// 1. Эндпоинт для внешних пинговалок (UptimeRobot)
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// 2. Главная страница проверки статуса
app.get('/', (req, res) => {
  res.send('Кагуя успешно запущена на Render!');
});

// 3. Обработчик вебхука от Telegram
app.post('/api/webhook', webhookCallback(bot, 'express'));

// 4. Автоматический само-пинг каждые 5 минут
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://kaguya2-0-bot-yd5z.onrender.com';

setInterval(async () => {
  try {
    await fetch(`${RENDER_URL}/ping`);
    console.log('📡 Само-пинг отправлен, бот активен!');
  } catch (e) {
    console.error('⚠️ Ошибка само-пинга:', e.message);
  }
}, 5 * 60 * 1000); // Раз в 5 минут

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Сервер слушает порт ${PORT}`);

  // Автоматическая установка вебхука при старте сервера
  try {
    const webhookUrl = `${RENDER_URL}/api/webhook`;
    await bot.api.setWebhook(webhookUrl);
    console.log(`🔗 Webhook успешно установлен на: ${webhookUrl}`);
  } catch (err) {
    console.error('❌ Ошибка при установке Webhook:', err.message);
  }
});

export default app;
