import express from 'express';
import https from 'https';
import { bot } from './bot.js'; 

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Кагуя работает в облаке и не спит!');
});

app.listen(PORT, () => {
    console.log(`Виртуальный server запущен на порту ${PORT}`);
});

// Авто-пинг сервера каждые 10 минут, чтобы Render не засыпал
setInterval(() => {
    const RENDER_URL = 'https://kaguya2-0-bot.onrender.com'; 
    
    https.get(RENDER_URL, (res) => {
        console.log(`[Пинг] Сервер успешно спингован, статус: ${res.statusCode}`);
    }).on('error', (err) => {
        console.error('[Пинг] Ошибка пинга:', err.message);
    });
}, 10 * 60 * 1000); // 10 минут

bot.start();
console.log('🚀 Бот Кагуя 2.0 успешно запущен с защитой от спячки!');
