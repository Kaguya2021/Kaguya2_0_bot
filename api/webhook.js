import { bot } from '../bot.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('🤖 Kaguya Bot is active!');
  }

  if (req.method === 'POST') {
    try {
      if (!bot.isInited || !bot.isInited()) {
        await bot.init();
      }

      // Гарантируем, что body — это объект
      const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      
      await bot.handleUpdate(update);
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('❌ Ошибка при обработке апдейта:', error);
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(405).send('Method Not Allowed');
}
