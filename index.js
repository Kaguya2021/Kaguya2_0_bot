import express from 'express';
import { bot } from './bot.js';
import { webhookCallback } from 'grammy';

const app = express();

// Обязательно подключаем обработку JSON до вебхука
app.use(express.json());

// 1. Health check для Render
app.get('/', (req, res) => {
  res.status(200).send('Bot is active and running!');
});

// 2. Роут вебхука с явной передачей req/res
app.post('/api/webhook', (req, res) => {
  return webhookCallback(bot, 'express')(req, res);
});

// 3. Запуск сервера
const PORT = process.env.PORT || 10000;

async function start() {
  try {
    await bot.init();
    console.log(`Бот @${bot.botInfo.username} инициализирован!`);

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Сервер запущен на порту ${PORT}`);
    });
  } catch (err) {
    console.error('Ошибка при старте бота:', err);
  }
}

start();

// Защита от падений
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
