// Генераторы inline-клавиатур главного меню и настроек.
import { InlineKeyboard } from 'grammy';
import { config, isAdmin } from '../config.js';
import { isAutoReplyActive } from '../services/schedule.js';
import { getChannelUrl } from '../services/subscription.js';

// Главное меню (уровень 1): компактные inline-кнопки, детали автоответчика — в подменю.
export function getMainInlineKeyboard(userId, settings, cfg = config) {
  const isActive = isAutoReplyActive(settings);
  const kb = new InlineKeyboard()
    .text('💬 Автоответчик', 'open_autoreply_menu').text('⚡ .команды', 'show_dot_commands').row()
    .text(isActive ? '🔕 Пауза 5 мин' : '🔔 Включить автоответ', 'toggle_autoreply')
    .text('⚙️ Настройки', 'settings_menu').row()
    .text('🔌 Подключение', 'open_onboarding');
  const channelUrl = getChannelUrl(cfg);
  if (channelUrl) kb.url('📢 Канал', channelUrl);

  if (isAdmin(userId, cfg.adminIds || config.adminIds)) {
    kb.row().text('🔒 ADMINPPA', 'admin_panel');
  }
  return kb;
}

// Подменю «Автоответчик» (уровень 2): все прежние callback_data без изменений.
export function getAutoReplyInlineKeyboard(settings) {
  const timerOn = settings?.timer_mode === true;
  return new InlineKeyboard()
    .text('✍️ Текст', 'set_text').text('🎤 Голос', 'set_voice').row()
    .text('🖼 Комбо', 'set_combo').text('🔍 Мой ответ', 'my_reply').row()
    .text('⏰ Расписание', 'set_time').text(`⏱ Таймер 15м: ${timerOn ? 'ВКЛ' : 'ОТКЛ'}`, 'toggle_timer_mode').row()
    .text('🗑 Сбросить ответ', 'reset_reply').row()
    .text('⬅️ Назад в меню', 'open_main_menu');
}

export function getSettingsInlineKeyboard(settings) {
  const antiDeleteOn = settings?.anti_delete_enabled !== false;
  return new InlineKeyboard()
    .text('➕ Добавить аккаунт', 'settings_add_account').row()
    .text(`👁 Анти-удаление: ${antiDeleteOn ? 'ВКЛ' : 'ВЫКЛ'}`, 'toggle_antidelete').row()
    .text('⬅️ Назад в меню', 'settings_back');
}

// Кнопки приветствия /start (канал + инструкция по подключению).
export function getWelcomeInlineKeyboard() {
  return new InlineKeyboard()
    .url('📢 Подписаться на канал', 'https://t.me/kaguya_2_0_bots')
    .row()
    .url('🔗 КАК ПОДКЛЮЧИТЬ', 'https://kaguya-gospoja.onrender.com');
}
