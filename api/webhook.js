import { webhookCallback } from 'grammy';
import { bot } from '../bot.js';

let isInitialized = false;

export default async function handler(req, res) {
  // Проверка для обычного браузера
  if (req.method === 'GET') {
    return res.status(200).send('🤖 Kaguya Bot is active!');
  }

  try {
    // ОБЯЗАТЕЛЬНО для grammY на Vercel:
    if (!isInitialized) {
      await bot.init();
      isInitialized = true;
    }

    const handleUpdate = webhookCallback(bot, 'std/http');
    await handleUpdate(req, res);
  } catch (error) {
    console.error('❌ Ошибка выполнения бота:', error);
    res.status(200).json({ ok: true });
  }
}
