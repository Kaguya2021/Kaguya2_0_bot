import { webhookCallback } from 'grammy';
import { bot } from '../bot.js';

// Используем адаптер 'express' для Vercel
const handleUpdate = webhookCallback(bot, 'express');

export default async function handler(req, res) {
  // Для проверки через обычный браузер
  if (req.method === 'GET') {
    return res.status(200).send('🤖 Kaguya Bot is active!');
  }

  try {
    if (req.method === 'POST') {
      await handleUpdate(req, res);
    } else {
      res.status(200).send('OK');
    }
  } catch (error) {
    console.error('❌ Ошибка вебхука:', error);
    // Отдаем 200, чтобы Vercel не падал со статусом 500
    res.status(200).json({ ok: true });
  }
}
