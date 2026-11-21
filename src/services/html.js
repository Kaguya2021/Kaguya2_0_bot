// Текстовые утилиты для сообщений с parse_mode: 'HTML'.

// Экранирование HTML-тегов (кавычки не трогаем — как в исходной реализации).
export function escapeHTML(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
