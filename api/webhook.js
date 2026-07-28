import { webhookCallback } from 'grammy';
import { bot } from '../bot.js';

let isInitialized = false;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('🤖 Kaguya Bot is active!');
  }

  try {
    // Инициализируем бота один раз при холодном старте
    if (!isInitialized) {
      await bot.init();
      isInitialized = true;
    }

    const handleUpdate = webhookCallback(bot, 'std/http');
    await handleUpdate(req, res);
  } catch (error) {
    console.error('❌ Ошибка внутри вебхука:', error);
    res.status(200).json({ ok: true });
  }
}
