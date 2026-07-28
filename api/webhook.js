import { webhookCallback } from 'grammy';
import { bot } from '../bot.js';

const handleUpdate = webhookCallback(bot, 'std/http');

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      await handleUpdate(req, res);
    } else {
      res.status(200).send('Kaguya Bot is active!');
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).json({ ok: true });
  }
}
