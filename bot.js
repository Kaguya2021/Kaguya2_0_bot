const { Telegraf, Markup } = require('telegraf');

// Сюда вставь токен своего бота
const bot = new Telegraf('ТВОЙ_ТОКЕН_БОТА');

// 1. Создаем постоянную нижнюю клавиатуру (Главное меню)
const mainMenu = Markup.keyboard([
  ['🤖 Автоответчик', '⚙️ Настройки'],
  ['👤 Профиль', 'ℹ️ Помощь']
]).resize();

// 2. Команда /start
bot.start(async (ctx) => {
  // Тут можно добавить запрос в БД на регистрацию нового юзера
  // await db.createUser(ctx.from.id, ctx.from.first_name);
  
  await ctx.reply('Привет! Добро пожаловать. Выбери нужное действие:', mainMenu);
});

// 3. Обработчик для Профиля (срабатывает на текст кнопки или команды)
bot.hears(['👤 Профиль', '/profile', '/my'], async (ctx) => {
  try {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Не указано';
    const username = ctx.from.username ? `@${ctx.from.username}` : 'Отсутствует';

    // 💡 МЕСТО ДЛЯ БАЗЫ ДАННЫХ
    // Здесь ты делаешь SELECT запрос к своей БД Neon, чтобы достать настройки юзера:
    // const userDb = await query('SELECT * FROM users WHERE id = $1', [userId]);
    
    // Пока БД не подключена, используем заглушки для теста:
    const joinedAt = '02.08.2026'; 
    const isAutoReplyOn = true; 
    const autoReplyText = 'Привет! Я сейчас занят, отвечу позже.';
    const repliesCount = 15;

    const autoReplyStatus = isAutoReplyOn ? '🟢 Включен' : '🔴 Выключен';

    // Формируем текст сообщения
    const profileMessage = `
<b>👤 Ваш Профиль</b>
───────────────
<b>🆔 ID:</b> <code>${userId}</code>
<b>👤 Имя:</b> ${firstName}
<b>Никнейм:</b> ${username}
<b>📅 В боте с:</b> ${joinedAt}

<b>🤖 Автоответчик:</b>
• <b>Статус:</b> ${autoReplyStatus}
• <b>Отправлено:</b> ${repliesCount} шт.
• <b>Текст автоответа:</b>
<i>«${autoReplyText}»</i>
───────────────
    `;

    // Создаем inline-кнопки под сообщением
    const profileKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✏️ Изменить текст', 'edit_autoreply'),
        Markup.button.callback('🔄 Вкл/Выкл', 'toggle_autoreply')
      ],
      [
        Markup.button.callback('📊 Статистика', 'stats_more')
      ]
    ]);

    // Отправляем профиль
    await ctx.replyWithHTML(profileMessage, profileKeyboard);

  } catch (error) {
    console.error('Ошибка в профиле:', error);
    await ctx.reply('⚠️ Произошла ошибка при загрузке профиля.');
  }
});

// 4. Обработчики нажатий на inline-кнопки

// Кнопка: Вкл/Выкл автоответ
bot.action('toggle_autoreply', async (ctx) => {
  try {
    // Обязательно отвечаем телеграму, что кнопка нажата, чтобы часики не крутились
    await ctx.answerCbQuery();
    const userId = ctx.from.id;

    // 💡 МЕСТО ДЛЯ БАЗЫ ДАННЫХ
    // Делаем UPDATE в базе, меняя статус автоответчика на противоположный
    // await query('UPDATE users SET is_active = NOT is_active WHERE id = $1', [userId]);

    await ctx.reply('🔄 Статус автоответчика успешно изменен!');
  } catch (error) {
    console.error(error);
  }
});

// Кнопка: Изменить текст автоответа
bot.action('edit_autoreply', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    
    // Здесь обычно включают Scene или State, чтобы бот ждал следующее сообщение как новый текст
    await ctx.reply('Отправьте новым сообщением текст, который будет использоваться для автоответа:');
  } catch (error) {
    console.error(error);
  }
});

// Кнопка: Статистика
bot.action('stats_more', async (ctx) => {
  try {
    await ctx.answerCbQuery('Тут будет подробная статистика!', { show_alert: true });
  } catch (error) {
    console.error(error);
  }
});

// Запуск бота
bot.launch().then(() => {
  console.log('✅ Бот успешно запущен!');
});

// Плавная остановка (Graceful stop)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
