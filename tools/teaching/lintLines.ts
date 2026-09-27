/**
 * `node tools/teaching/lintLines.ts [pool-prefix …]` — the lesson content lint for writers (free, silent, offline):
 * every issue of the pools whose id starts with one of the prefixes (all pools without arguments) and the wording
 * counts per stage. Exit 1 when something is wrong.
 */
import { LESSON_LINES } from '../../packages/content/src/index.ts';
import { lintLessonLine } from '../../packages/core/src/coach/lesson/lint.ts';

const prefixes = process.argv.slice(2);
const lines = LESSON_LINES.filter((l) => prefixes.length === 0 || prefixes.some((p) => l.id.startsWith(p)));
let bad = 0;
for (const l of lines) {
  const issues = lintLessonLine(l);
  const counts = [1, 2, 3, 4, 5].map((s) => l.wordings.filter((w) => { const [a, b] = w.stages ?? l.stages ?? [1, 5]; return s >= a && s <= b; }).length);
  const mark = issues.length === 0 ? 'ok ' : 'BAD';
  console.log(`${mark} ${l.id}  (${l.wordings.length} wordings; per stage ${counts.join('/')}; min ${l.min})`);
  for (const i of issues) console.log(`     [${i.rule}] ${i.detail ?? ''} «${i.text}»`);
  bad += issues.length;
}
console.log(`\n${lines.length} pools, ${bad} issues`);
process.exit(bad === 0 ? 0 : 1);
