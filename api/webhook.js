import { webhookCallback } from 'grammy';
import { bot } from '../bot.js'; // Путь к вашему bot.js

const handleUpdate = webhookCallback(bot, 'express');

export default async function handler(req, res) {
  try {
    await handleUpdate(req, res);
  } catch (err) {
    // Глушим ошибки 403 и блокировки на уровне HTTP-эндпоинта
    const msg = err?.message || String(err);
    if (
      err?.error_code === 403 ||
      msg.includes('blocked by the user') ||
      msg.includes('user is deactivated')
    ) {
      return res.status(200).send('OK');
    }
    
    console.error('❌ Ошибка вебхука:', msg);
    res.status(200).send('OK'); // Telegram всегда должен получать 200 OK
  }
}
