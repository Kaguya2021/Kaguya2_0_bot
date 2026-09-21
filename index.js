import express from 'express';
import { bot } from './bot.js'; // Убедись, что путь к bot.js указан верно
import { webhookCallback } from 'grammy';

const app = express();

app.use(express.json());

// 1. Маршрут для Health Check / Пингера (отдаёт 200 OK вместо 404)
app.get('/', (req, res) => {
  res.status(200).send('Bot is active and running!');
});

// 2. Обработчик вебхука Telegram
app.use('/api/webhook', webhookCallback(bot, 'express'));

// 3. Запуск веб-сервера
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

// 4. Защита от падения процесса при необработанных ошибках
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
