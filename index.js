import express from 'express';
import './bot.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Кагуя работает в облаке!');
});

app.listen(PORT, () => {
    console.log(`Виртуальный сервер запущен на порту ${PORT}`);
});
