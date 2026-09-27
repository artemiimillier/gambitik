/**
 * Test fixtures of «Дозапись голоса» (unit tests only): a lesson event built from real @gambit/content wordings —
 * its `say`, `saySentences` and the exact bubble text — and a recorded overlay of its units, keyed as the server
 * publishes them (`lessonUnitKey`, on-demand takes from 101). For the non-lesson events: a greeting twin of the real clip
 * catalogue and on-demand takes of whole catalogue sentences (`line:<poolKey>#<n>`, the `pilot` tier's keys and pools).
 */
import { CLIP_VOICE_KEY, buildClipIndex, clipId, expectedPartText, expectedSentenceText, lessonUnitKey, resolveClipGenLine } from '@gambit/core';
import type { ClipIndex, ClipIndexEntry } from '@gambit/core';
import type { ClipGenLine, CoachEvent, LessonSay, LessonSaySentence } from '@gambit/shared';
import { makeEvent } from '../testUtils.ts';

/** «Сделаем рокировку и спрячем короля в домик!» — a whole wording */
export const WHOLE: LessonSay = { pool: 'v3.whole.castle', n: 1 };
/** «Нашим фигурам пора в игру» — a lead … */
export const LEAD: LessonSay = { pool: 'v3.aim.develop', n: 1 };
/** … «— и будет двойной удар!» — its tail */
export const TAIL: LessonSay = { pool: 'v3.idea.fork', n: 1 };

function partText(say: LessonSay): string {
  const text = expectedPartText(say);
  if (text === null) throw new Error(`fixture wording ${say.pool}#${say.n} does not expand`);
  return text;
}

/**
 * A teacher's turn of sentences made of `say` parts: [[WHOLE], [LEAD, TAIL]] = «Whole. Lead — tail.» with its
 * `saySentences` (indexes into `say`), text = bubble text.
 */
export function lessonEvent(sentences: readonly (readonly LessonSay[])[] = [[WHOLE], [LEAD, TAIL]], patch: Partial<CoachEvent> = {}): CoachEvent {
  const say: LessonSay[] = [];
  const saySentences: LessonSaySentence[] = [];
  for (const parts of sentences) {
    const text = expectedSentenceText(parts);
    if (text === null) throw new Error('fixture sentence does not expand');
    saySentences.push({ text, parts: parts.map((_, k) => say.length + k) });
    say.push(...parts);
  }
  const text = saySentences.map((s) => s.text).join(' ');
  return makeEvent({ kind: 'teachTurn', text, bubbleText: text, pose: 'think', teach: { moment: 'turn', style: 'short', ply: 1, advice: [] }, say, saySentences, ...patch });
}

/** One recorded take of a part, as the overlay publishes it. */
export function recordedUnit(say: LessonSay, take = 101, extra: Partial<ClipIndexEntry> = {}): ClipIndexEntry {
  const key = lessonUnitKey(say);
  const text = partText(say);
  const audible = [...text].length * 70;
  return { id: clipId(CLIP_VOICE_KEY, `${key}\n${text}`, 0, take), key, text, take, ms: audible + 100, on: 30, off: audible + 30, ...extra };
}

/** An overlay that has recorded exactly these parts. */
export function recordedOverlay(parts: readonly LessonSay[]): ClipIndex {
  return buildClipIndex(parts.map((p) => recordedUnit(p)));
}

/** «Добрый день!» — wording 1 of the real catalogue's `greet.hello.day` */
export const HELLO_DAY: ClipGenLine = { id: 'greet.hello.day', n: 1 };
/** «Привет-привет, добрый день!» — wording 2 of the same line */
export const HELLO_DAY_2: ClipGenLine = { id: 'greet.hello.day', n: 2 };

function lineText(l: ClipGenLine): { key: string; text: string; pools: string[] } {
  const r = resolveClipGenLine(l, { recordable: false });
  if (!r.ok) throw new Error(`fixture line ${l.id}#${l.n} does not resolve (${r.problem})`);
  return { key: r.unit.unitKey, text: r.unit.text, pools: r.unit.pools };
}

/** The home screen's greeting as a clip twin: one W sentence of `greet.hello.day`, saying wording `n` in its bubble. */
export function greetingEvent(n = 1, patch: Partial<CoachEvent> = {}): CoachEvent {
  const { text } = lineText({ id: 'greet.hello.day', n });
  return makeEvent({
    kind: 'greeting',
    priority: 1,
    pose: 'wave',
    text,
    bubbleText: text,
    clip: { sentences: [{ items: [{ line: 'greet.hello.day' }], prio: 100, end: '!' }], generic: 'generic.greeting.wave' },
    ...patch,
  });
}

/** One on-demand take of a whole catalogue sentence, as the overlay publishes it (its key, words and pools). */
export function recordedLine(l: ClipGenLine, take = 101): ClipIndexEntry {
  const { key, text, pools } = lineText(l);
  const audible = [...text].length * 70;
  return { id: clipId(CLIP_VOICE_KEY, `${key}\n${text}`, 0, take), key, text, take, ms: audible + 100, on: 30, off: audible + 30, pools };
}

/** An overlay that has recorded exactly these whole sentences. */
export function recordedLines(lines: readonly ClipGenLine[]): ClipIndex {
  return buildClipIndex(lines.map((l) => recordedLine(l)));
}
