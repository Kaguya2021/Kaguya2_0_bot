import { bot } from '../bot.js';

export default async function handler(req, res) {
  // Для проверки через браузер
  if (req.method === 'GET') {
    return res.status(200).send('🤖 Kaguya Bot is active!');
  }

  if (req.method === 'POST') {
    try {
      // Инициализируем бота при первом вызове
      if (!bot.isInited || !bot.isInited()) {
        await bot.init();
      }

      // Передаем тело запроса напрямую в grammY
      await bot.handleUpdate(req.body);
      
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('❌ Ошибка обработки апдейта:', error);
      // Отдаем 200, чтобы Telegram не спамил повторами
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(405).send('Method Not Allowed');
}
