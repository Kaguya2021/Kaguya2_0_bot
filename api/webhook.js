import { webhookCallback } from 'grammy';
import { bot } from '../bot.js';

const handleUpdate = webhookCallback(bot, 'std/http');

export default async function handler(req, res) {
  // Если заходим через обычный браузер
  if (req.method === 'GET') {
    return res.status(200).send('🤖 Kaguya Bot is running successfully!');
  }

  // Если запрос пришел от Telegram (POST)
  try {
    if (req.method === 'POST') {
      await handleUpdate(req, res);
    } else {
      res.status(200).send('OK');
    }
  } catch (error) {
    console.error('Webhook error:', error);
    // Всегда отдаем 200, чтобы Telegram не переотправлял сообщения по 100 раз
    res.status(200).json({ ok: true });
  }
}
