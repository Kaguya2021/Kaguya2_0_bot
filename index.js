import express from 'express';
import { bot } from './bot.js'; 

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Кагуя работает в облаке!');
});

app.listen(PORT, () => {
    console.log(`Виртуальный server запущен на порту ${PORT}`);
});

bot.start();
console.log('🚀 Бот Кагуя 2.0 успешно запущен!');
