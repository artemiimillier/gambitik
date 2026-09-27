/**
 * `node tools/teaching/expand.ts <pool-prefix …> [--combos N]` — prints every wording of the pools with its piece /
 * gender expansions and, for leads and tails, N random lead + tail sentences as the child would hear them (free,
 * silent, offline; for the writers and editors of the lesson content).
 */
import { LESSON_LINES } from '../../packages/content/src/index.ts';
import { expandLessonWording } from '../../packages/core/src/coach/lesson/lint.ts';
import { joinSentence } from '../../packages/core/src/coach/lesson/render.ts';

const args = process.argv.slice(2);
const ci = args.indexOf('--combos');
const combos = ci >= 0 ? Number(args[ci + 1] ?? 12) : 12;
const prefixes = args.filter((a, i) => !a.startsWith('--') && (ci < 0 || i !== ci + 1));
const lines = LESSON_LINES.filter((l) => prefixes.length === 0 || prefixes.some((p) => l.id.startsWith(p)));
let seed = 7;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (const l of lines) {
  console.log(`\n## ${l.id}  [${l.role}${l.subject ? `, subject ${l.subject}` : ''}${l.cue.length ? `, cue ${l.cue.join('/')}` : ''}${l.variants ? `, variants ${l.variants.join('/')}` : ''}]  ${l.purpose}`);
  for (const w of l.wordings) {
    const tags = [w.stages ? `st ${w.stages.join('–')}` : '', w.when ? `when ${w.when.join(',')}` : ''].filter(Boolean).join('; ');
    const ex = expandLessonWording(l, w).map((x) => x.text).filter((t): t is string => !!t);
    console.log(`- ${w.t}${tags ? `   (${tags})` : ''}`);
    if (ex.length > 1 || (ex[0] && ex[0] !== w.t)) for (const e of ex) console.log(`    · ${e}`);
  }
}
// sample sentences: leads × tails
const leads = LESSON_LINES.filter((l) => l.role === 'lead');
const tails = LESSON_LINES.filter((l) => l.role === 'tail');
const wanted = lines.some((l) => l.role === 'lead' || l.role === 'tail');
if (wanted && leads.length > 0 && tails.length > 0) {
  console.log('\n## sample sentences (a random lead + a random tail; piece = knight)');
  const pickText = (l: (typeof LESSON_LINES)[number]): string | null => {
    const w = l.wordings[Math.floor(rnd() * l.wordings.length)];
    if (!w) return null;
    const ex = expandLessonWording(l, w).find((x) => x.piece === 'n' || x.piece === undefined);
    return ex?.text ?? null;
  };
  for (let i = 0; i < combos; i++) {
    const mine = lines.filter((l) => l.role === 'lead' || l.role === 'tail');
    const own = mine[Math.floor(rnd() * mine.length)]!;
    const other = own.role === 'lead' ? tails : leads;
    const partner = other[Math.floor(rnd() * other.length)]!;
    const a = pickText(own.role === 'lead' ? own : partner);
    const b = pickText(own.role === 'lead' ? partner : own);
    if (a && b) console.log(`- ${joinSentence([a, b])}   [${own.role === 'lead' ? own.id : partner.id} + ${own.role === 'lead' ? partner.id : own.id}]`);
  }
}
