import express from 'express';
import { webhookCallback } from 'grammy';
import { bot } from './bot.js';

const app = express();
app.use(express.json());

// Главная страница для проверки
app.get('/', (req, res) => {
    res.send('Кагуя успешно запущена на Vercel!');
});

// Настройка вебхука от Telegram
app.use('/api/webhook', webhookCallback(bot, 'express'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер слушает порт ${PORT}`);
});
