/**
 * node tools/rebuild-db.ts --data-dir <DATA_DIR> --out <new.sqlite>
 *
 * Rebuilds the database of Гамбитик (list of games, reviews, «играл взрослый» flags, the child's thoughts, the profile)
 * from the files in DATA_DIR into a NEW file (see lib/rebuild-db.ts). Reads DATA_DIR only; never touches the working
 * app.sqlite and never overwrites an existing file. To use the result: stop the server, keep the old app.sqlite aside,
 * put the new file in its place (named app.sqlite), start the server again.
 */
import { displayPath, errorMessage, parseCli, UsageError } from './lib/cli.ts';
import { RebuildRefused, rebuildDb } from './lib/rebuild-db.ts';

const TAG = '[rebuild-db]';
const HELP = 'Usage: node tools/rebuild-db.ts --data-dir <папка data> --out <новый файл .sqlite>';

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), {
    'data-dir': { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (args.help === true) {
    console.log(HELP);
    return;
  }
  const dataDir = args['data-dir'];
  const out = args.out;
  if (dataDir === undefined || dataDir === '' || out === undefined || out === '') throw new UsageError('нужны оба флага: --data-dir и --out');

  const summary = await rebuildDb({ dataDir, out });
  console.log(`${TAG} готово: ${displayPath(out)}`);
  console.log(`${TAG} партий: ${summary.games} (точно, из .json: ${summary.exact}; по журналу .md без оценок ходов: ${summary.fromJournal.length})`);
  console.log(`${TAG} разборов: ${summary.reviews} · мыслей ребёнка: ${summary.thoughts} · не в прогрессе (взрослый / архив): ${summary.excluded}`);
  console.log(`${TAG} профиль: ${summary.profileRestored ? 'из data/student/progress.json' : 'новый (progress.json не найден или повреждён)'} · точек рейтинга задач: ${summary.ratingPoints}`);
  for (const base of summary.fromJournal) console.log(`${TAG}   по журналу: ${base}`);
  for (const skipped of summary.skipped) console.log(`${TAG}   пропущено: ${skipped.file} — ${skipped.reason}`);
  console.log(`${TAG} чтобы начать с неё: остановите сервер, отложите старый app.sqlite, положите новый файл на его место под именем app.sqlite и запустите сервер.`);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) console.error(`${TAG} usage error: ${err.message}\n${HELP}`);
  else if (err instanceof RebuildRefused) console.error(`${TAG} отказ: ${err.message}`);
  else console.error(`${TAG} FAILED: ${errorMessage(err)} (новый файл не создан)`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
});
