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

bot.start();
console.log('🚀 Бот Кагуя 2.0 успешно запущен с защитой от спячки!');
