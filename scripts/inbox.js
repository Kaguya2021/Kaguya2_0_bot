// Выгрузка необработанного фидбека (комментарии из группы обсуждений + ошибки бота).
//   npm run inbox                         — Markdown-отчёт в stdout
//   npm run inbox -- --out inbox-report.md — отчёт в файл
//   npm run inbox:ack                     — пометить выгружаемые записи как processed
//   npm run inbox:ack -- --comments-only --ids 1,2,3
// Флаги: --comments-only, --errors-only, --ids, --limit N (по умолчанию 100).
import { writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { db, closeDb } from '../src/db/index.js';
import { parseInboxArgs, formatInboxReport } from '../src/services/inbox.js';

async function main() {
  const opts = parseInboxArgs(process.argv.slice(2));
  if (opts.error) throw new Error(opts.error);
  if (!config.databaseUrl) throw new Error('DATABASE_URL не задан в .env');

  const wantComments = !opts.errorsOnly;
  const wantErrors = !opts.commentsOnly;

  if (opts.ack) {
    // Без --ids помечаем ровно то, что выгрузил бы `npm run inbox` с тем же --limit.
    const commentIds = wantComments ? (opts.ids ?? (await db.getNewComments(opts.limit)).map((r) => r.id)) : [];
    const errorIds = wantErrors ? (opts.ids ?? (await db.getNewErrorLogs(opts.limit)).map((r) => r.id)) : [];
    const c = wantComments ? await db.markCommentsStatus(commentIds, 'processed') : 0;
    const e = wantErrors ? await db.markErrorLogsStatus(errorIds, 'processed') : 0;
    console.log(`✅ Помечено processed: комментариев ${c}, ошибок ${e}`);
    return;
  }

  const comments = wantComments ? await db.getNewComments(opts.limit) : [];
  const errors = wantErrors ? await db.getNewErrorLogs(opts.limit) : [];
  const report = formatInboxReport({ comments, errors });

  if (opts.out) {
    await writeFile(opts.out, report, 'utf8');
    console.log(`📄 Отчёт сохранён в ${opts.out} (комментариев: ${comments.length}, ошибок: ${errors.length})`);
  } else {
    process.stdout.write(report);
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error(`❌ ${e?.message || e}`);
  exitCode = 1;
} finally {
  await closeDb().catch(() => {});
}
process.exitCode = exitCode;
