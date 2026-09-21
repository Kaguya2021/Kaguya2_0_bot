import express from 'express';
import { webhookCallback } from 'grammy';
import { bot } from './bot.js';
import { db } from './database.js';

const app = express();
app.use(express.json());

// Подавление ошибок блокировки и запись неожиданных отказов в БД
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
  db.saveErrorLog('SYSTEM', 'UNHANDLED_REJECTION', msg);
});

// Роут статуса для внешнего мониторинга
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

app.get('/', (req, res) => {
  res.send('Кагуя успешно запущена на Render!');
});

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
    db.saveErrorLog('SYSTEM', 'WEBHOOK_SETUP_FAIL', err.message);
  }
});

export default app;
