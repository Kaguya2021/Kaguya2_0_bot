// Генераторы inline-клавиатур главного меню и настроек.
import { InlineKeyboard } from 'grammy';
import { isAdmin } from '../config.js';
import { isAutoReplyActive, getAutoOffMinutesLeft } from '../services/schedule.js';

// Главное меню строится как inline-кнопки (под сообщением), а не обычная клавиатура
export function getMainInlineKeyboard(userId, settings) {
  const isActive = isAutoReplyActive(settings);
  const timerOn = settings?.timer_mode === true;
  const statusButtonText = isActive
    ? '🔕 Выключить автоответ (5 мин)'
    : `🔔 Включить автоответ (осталось ${getAutoOffMinutesLeft(settings)} мин)`;

  const timerButtonText = timerOn
    ? '⛔ Таймер откл (сейчас: 1 автоответ / 15 мин)'
    : '⏱ Таймер 15 мин (сейчас: откл)';

  const kb = new InlineKeyboard()
    .text(statusButtonText, 'toggle_autoreply').row()
    .text('✍️ Установить текст', 'set_text').text('🎤 Голосовой автоответ', 'set_voice').row()
    .text('🖼️ Комбо (Текст + Стикер)', 'set_combo').text('🔍 Мой автоответ', 'my_reply').row()
    .text('⏰ Настроить время', 'set_time').text('🗑️ Сбросить', 'reset_reply').row()
    .text(timerButtonText, 'toggle_timer_mode').row()
    .text('⚙️ Настройки', 'settings_menu').row();

  if (isAdmin(userId)) {
    kb.text('🔒 ADMINPPA', 'admin_panel').row();
  }

  return kb;
}

export function getSettingsInlineKeyboard() {
  return new InlineKeyboard()
    .text('➕ Добавить аккаунт', 'settings_add_account').row()
    .text('⬅️ Назад в меню', 'settings_back');
}

// Кнопки приветствия /start (канал + инструкция по подключению).
export function getWelcomeInlineKeyboard() {
  return new InlineKeyboard()
    .url('📢 Подписаться на канал', 'https://t.me/kaguya_2_0_bots')
    .row()
    .url('🔗 КАК ПОДКЛЮЧИТЬ', 'https://kaguya-gospoja.onrender.com');
}
