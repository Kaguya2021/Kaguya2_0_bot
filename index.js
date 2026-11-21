import express from 'express';
import { webhookCallback } from 'grammy';
import { bot, loadBotState } from './bot.js';
import { createWebhookSecretMiddleware } from './lib/webhookAuth.js';

const USE_POLLING = process.env.USE_POLLING === 'true';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

if (!USE_POLLING && !WEBHOOK_SECRET) {
  console.error('🚨 КРИТИЧНО: WEBHOOK_SECRET не задан! /api/webhook принимает запросы без проверки подписи Telegram. Добавьте WEBHOOK_SECRET в переменные окружения Render.');
}

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

// Обработчик вебхука от Telegram (только в webhook-режиме).
// Проверка X-Telegram-Bot-Api-Secret-Token выполняется ДО webhookCallback.
if (!USE_POLLING) {
  app.post('/api/webhook', createWebhookSecretMiddleware(WEBHOOK_SECRET), webhookCallback(bot, 'express'));
}

const PORT = process.env.PORT || 3000;
// Render сам подставляет RENDER_EXTERNAL_URL для каждого веб-сервиса.
// Если переменная почему-то не пришла — используем актуальный адрес этого сервиса
// (раньше тут был захардкожен старый/чужой домен, из-за чего вебхук не ставился).
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://kaguya2-0-bot-clhl.onrender.com';

async function setWebhookWithRetry(webhookUrl, attempt = 1) {
  try {
    await bot.api.setWebhook(webhookUrl, WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : undefined);
    console.log(`🔗 Webhook успешно установлен на: ${webhookUrl}`);
  } catch (err) {
    console.error(`❌ Ошибка при установке Webhook (попытка ${attempt}):`, err.message);
    if (attempt < 5) {
      const delay = attempt * 3000;
      setTimeout(() => setWebhookWithRetry(webhookUrl, attempt + 1), delay);
    } else {
      console.error('❌ Не удалось установить Webhook после нескольких попыток. Проверьте BOT_TOKEN и RENDER_URL.');
    }
  }
}

// Локальный запуск (Windows и т.п.): USE_POLLING=true — без webhook, через getUpdates.
async function startPolling() {
  await bot.api.deleteWebhook();
  console.log('🔁 Режим polling (USE_POLLING=true): webhook удалён, запускаю bot.start()');
  const stop = () => bot.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await bot.start({
    onStart: (info) => console.log(`🤖 Бот @${info.username} запущен в режиме polling`)
  });
}

// Подгружаем персистентное состояние (global_stop) в фоне — не блокируем старт сервера.
loadBotState();

app.listen(PORT, () => {
  console.log(`🚀 Сервер слушает порт ${PORT}`);

  if (USE_POLLING) {
    startPolling().catch((err) => {
      console.error('❌ Ошибка запуска polling:', err?.message || err);
    });
    return;
  }

  console.log(`🌐 Используемый адрес хоста: ${RENDER_URL}`);
  const webhookUrl = `${RENDER_URL}/api/webhook`;
  setWebhookWithRetry(webhookUrl);
});

export default app;
