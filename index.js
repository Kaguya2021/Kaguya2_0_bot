import express from 'express';
import { webhookCallback } from 'grammy';
import { bot } from './bot.js';
import https from 'https'; // Подключаем модуль для пинга

const app = express();
app.use(express.json());

// Главная страница для проверки
app.get('/', (req, res) => {
  res.send('Кагуя успешно запущена!');
});

// Настройка вебхука от Telegram
app.post('/api/webhook', webhookCallback(bot, 'express'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер слушает порт ${PORT}`);
});

// --- САМА ПИНГОВАЛКА ДЛЯ RENDER ---
// Каждые 5 минут делает запрос на сайт, чтобы Render не усыплял бота
setInterval(() => {
  // ВАЖНО: Замени эту ссылку на реальный URL твоего приложения на Render!
  const APP_URL = 'https://kaguya-bot.onrender.com'; 
  
  https.get(APP_URL, (res) => {
    console.log(`📡 Само-пинг выполнен! Статус: ${res.statusCode}`);
  }).on('error', (err) => {
    console.error('❌ Ошибка пинговалки:', err.message);
  });
}, 5 * 60 * 1000);

export default app;
