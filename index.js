import express from 'express';
import { bot } from './bot.js';
import { webhookCallback } from 'grammy';

const app = express();

app.use(express.json());

// 1. Маршрут для проверки работоспособности (Health Check)
app.get('/', (req, res) => {
  res.status(200).send('Bot is active and running!');
});

// Инициализируем бота перед привязкой вебхука
async function startServer() {
  try {
    // Получаем информацию о боте от Telegram API
    await bot.init();
    console.log(`Бот @${bot.botInfo.username} успешно инициализирован`);

    // 2. Обработчик вебхука Telegram
    app.use('/api/webhook', webhookCallback(bot, 'express'));

    // 3. Запуск веб-сервера
    const PORT = process.env.PORT || 10000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Сервер запущен на порту ${PORT}`);
    });
  } catch (error) {
    console.error('Ошибка при запуске бота:', error);
  }
}

startServer();

// 4. Защита от падения процесса
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
