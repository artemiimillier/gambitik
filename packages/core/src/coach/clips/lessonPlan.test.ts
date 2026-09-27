/**
 * «Дозапись голоса»: a lesson utterance played from recorded units by their exact keys — whole or nothing, what is
 * heard is exactly the bubble, stale takes are silent, a shifted wording number is found by its text, a `cont` lead
 * only before its tail, the measured gaps (blitz, jitter), recent takes avoided, no caps; a silent plan lists the
 * sentences that may be requested, and never one that can never be recorded. Also the text functions the server's
 * request renderer shares, and the sentences of an event without `saySentences`. Real words of @gambit/content; synthetic takes.
 */
import { describe, expect, it } from 'vitest';
import type { LessonSay, LessonSaySentence } from '@gambit/shared';
import { lessonLine } from '@gambit/content';
import { lessonUnitKey } from '../lesson/book.ts';
import { joinSentence } from '../lesson/render.ts';
import { expandWording } from './catalog.ts';
import { buildClipIndex, lessonQuizKey, mergeClipIndexes } from './keys.ts';
import type { ClipIndexEntry } from './keys.ts';
import {
  LESSON_GAPS_MS,
  LESSON_LONG_MS,
  expectedPartText,
  expectedQuizText,
  expectedSentenceText,
  lessonSentencesOf,
  planLessonClips,
  requestSentenceOf,
} from './lessonPlan.ts';
import type { LessonPlanEvent } from './lessonPlan.ts';
import { createClipRecency } from './plan.ts';

/** The first wording of a pool whose template matches `test` (content may grow; the tests follow it). */
function wording(pool: string, test: (t: string) => boolean): { n: number; t: string } {
  const line = lessonLine(pool);
  if (!line) throw new Error(`no pool ${pool}`);
  const i = line.wordings.findIndex((w) => test(w.t));
  if (i < 0) throw new Error(`no fitting wording in ${pool}`);
  return { n: i + 1, t: (line.wordings[i] as { t: string }).t };
}

const PIECE_RE = /\{(?!g:)[^}]+\}/;
const plainText = (t: string): boolean => !t.includes('{');
const lead = wording('v3.lead.advice', (t) => PIECE_RE.test(t) && !t.includes('{g:'));
const tail = wording('v3.idea.mate', plainText);
const genderWhole = wording('v3.self.develop', (t) => t.includes('{g:') && !PIECE_RE.test(t));
const question = wording('v3.quiz.q.oppIdea', (t) => plainText(t) && t.endsWith('?'));
const right = wording('v3.quiz.right', (t) => plainText(t) && t.endsWith('!'));

// ───────────────────────── a synthetic utterance and its takes ─────────────────────────

/** say: 0 lead (knight), 1 tail, 2 question, 3 quiz button, 4 a whole «Верно!» */
const SAY: LessonSay[] = [
  { pool: 'v3.lead.advice', n: lead.n, piece: 'n' },
  { pool: 'v3.idea.mate', n: tail.n },
  { pool: 'v3.quiz.q.oppIdea', n: question.n },
  { pool: 'v3.quiz.cat.attack', n: 1 },
  { pool: 'v3.quiz.right', n: right.n },
];
const LEAD_TEXT = expectedPartText(SAY[0] as LessonSay) as string;
const QUIZ = { kind: 'oppIdea' as const, options: [{ say: 3 }, { piece: 'n' as const }, { piece: 'b' as const }] };
const QUIZ_TEXT = expectedQuizText({ kind: 'oppIdea', options: [{ say: SAY[3] as LessonSay }, { piece: 'n' }, { piece: 'b' }] }) as string;

/** Four sentences (the clip twins' cap is two): lead + tail, the question, the options, a whole. */
function utterance(over: Partial<{ sentences: LessonSaySentence[]; say: LessonSay[] }> = {}): LessonPlanEvent {
  const say = over.say ?? SAY;
  const sentences = over.sentences ?? [
    { text: joinSentence([LEAD_TEXT, tail.t]), parts: [0, 1] },
    { text: question.t, parts: [2] },
    { text: QUIZ_TEXT, parts: [], quiz: QUIZ },
    { text: right.t, parts: [4] },
  ];
  return { text: sentences.map((s) => s.text).join(' '), say, saySentences: sentences };
}

const ID = { lead: 'c00000000000a1', tail: 'c00000000000a2', question: 'c00000000000a3', quiz: 'c00000000000a4', right: 'c00000000000a5' } as const;

/** One take per unit: ms 1000 in the file, audible 100..900 (800 ms). */
function entries(over: Partial<Record<keyof typeof ID, Partial<ClipIndexEntry> | null>> = {}): ClipIndexEntry[] {
  const base: Record<keyof typeof ID, ClipIndexEntry> = {
    lead: { id: ID.lead, key: lessonUnitKey(SAY[0] as LessonSay), text: LEAD_TEXT, ms: 1000, on: 100, off: 900 },
    tail: { id: ID.tail, key: lessonUnitKey(SAY[1] as LessonSay), text: tail.t, ms: 1000, on: 100, off: 900 },
    question: { id: ID.question, key: lessonUnitKey(SAY[2] as LessonSay), text: question.t, ms: 1000, on: 100, off: 900 },
    quiz: { id: ID.quiz, key: lessonQuizKey(QUIZ_TEXT), text: QUIZ_TEXT, ms: 1000, on: 100, off: 900 },
    right: { id: ID.right, key: lessonUnitKey(SAY[4] as LessonSay), text: right.t, ms: 1000, on: 100, off: 900 },
  };
  return (Object.keys(base) as (keyof typeof ID)[]).flatMap((k) => (over[k] === null ? [] : [{ ...base[k], ...(over[k] ?? {}) }]));
}

const EXACT = { jitter: false } as const;

describe('expectedPartText', () => {
  it('is the wording expanded for its piece / gender', () => {
    expect(expectedPartText({ pool: 'v3.lead.advice', n: lead.n, piece: 'n' })).toBe(expandWording(lead.t, { piece: 'n' }));
    expect(expectedPartText({ pool: 'v3.self.develop', n: genderWhole.n, g: 'f' })).toBe(expandWording(genderWhole.t, { g: 'f' }));
    expect(expectedPartText({ pool: 'v3.idea.mate', n: tail.n })).toBe(tail.t);
  });

  it('renders nothing for impossible ids', () => {
    expect(expectedPartText({ pool: 'v3.lead.advice', n: lead.n })).toBeNull(); // the piece is missing
    expect(expectedPartText({ pool: 'v3.idea.mate', n: tail.n, piece: 'n' })).toBeNull(); // no piece placeholder
    expect(expectedPartText({ pool: 'v3.self.develop', n: genderWhole.n })).toBeNull(); // the gender is missing
    expect(expectedPartText({ pool: 'v3.idea.mate', n: tail.n, g: 'm' })).toBeNull(); // no {g:}
    expect(expectedPartText({ pool: 'v3.nope', n: 1 })).toBeNull();
    expect(expectedPartText({ pool: 'v3.idea.mate', n: 0 })).toBeNull();
    expect(expectedPartText({ pool: 'v3.idea.mate', n: 9999 })).toBeNull();
  });
});

describe('expectedSentenceText / expectedQuizText', () => {
  it('joins a lead and its tail exactly as the bubble', () => {
    const parts: LessonSay[] = [
      { pool: 'v3.lead.advice', n: lead.n, piece: 'n' },
      { pool: 'v3.idea.mate', n: tail.n },
    ];
    expect(expectedSentenceText(parts)).toBe(joinSentence([expandWording(lead.t, { piece: 'n' }) as string, tail.t]));
    expect(expectedSentenceText([parts[0] as LessonSay])).toMatch(/\.$/);
    expect(expectedSentenceText([])).toBeNull();
    expect(expectedSentenceText([{ pool: 'v3.nope', n: 1 }])).toBeNull();
  });

  it('builds the options sentence from button wordings and piece types', () => {
    const cat = lessonLine('v3.quiz.cat.attack')?.wordings[0]?.t as string;
    expect(expectedQuizText({ kind: 'whichPiece', options: [{ piece: 'n' }, { piece: 'b' }, { piece: 'r' }] })).toBe('Конём, слоном или ладьёй?');
    expect(expectedQuizText({ kind: 'danger', options: [{ piece: 'n' }, { piece: 'q' }, { piece: 'p' }] })).toBe('Коня, ферзя или пешку?');
    const text = expectedQuizText({ kind: 'oppIdea', options: [{ say: { pool: 'v3.quiz.cat.attack', n: 1 } }, { piece: 'n' }, { piece: 'b' }] });
    expect(text?.startsWith(cat.replace(/[.!?…]+$/u, ''))).toBe(true);
    // a non-button pool, a piece on a button, two options: refused
    expect(expectedQuizText({ kind: 'oppIdea', options: [{ say: { pool: 'v3.idea.mate', n: tail.n } }, { piece: 'n' }, { piece: 'b' }] })).toBeNull();
    expect(expectedQuizText({ kind: 'oppIdea', options: [{ say: { pool: 'v3.quiz.cat.attack', n: 1, piece: 'n' } }, { piece: 'n' }, { piece: 'b' }] })).toBeNull();
    expect(expectedQuizText({ kind: 'oppIdea', options: [{ piece: 'n' }, { piece: 'b' }] })).toBeNull();
  });
});

describe('request ids of a sentence', () => {
  it('resolves `say` indexes into ids', () => {
    expect(requestSentenceOf({ say: SAY }, { text: 'x', parts: [0, 1] })).toEqual({ parts: [SAY[0], SAY[1]] });
    expect(requestSentenceOf({ say: SAY }, { text: 'x', parts: [0] })).toEqual({ parts: [SAY[0]] });
    expect(requestSentenceOf({ say: SAY }, { text: 'x', parts: [], quiz: QUIZ })).toEqual({
      quiz: { kind: 'oppIdea', options: [{ say: SAY[3] }, { piece: 'n' }, { piece: 'b' }] },
    });
  });

  it('gives null for a sentence that can never be recorded', () => {
    expect(requestSentenceOf({ say: SAY }, { text: 'x', parts: [] })).toBeNull();
    expect(requestSentenceOf({ say: SAY }, { text: 'x', parts: [0, 1, 2] })).toBeNull();
    expect(requestSentenceOf({ say: SAY }, { text: 'x', parts: [7] })).toBeNull();
    expect(requestSentenceOf({}, { text: 'x', parts: [0] })).toBeNull();
    expect(requestSentenceOf({ say: SAY }, { text: 'x', parts: [], quiz: { kind: 'oppIdea', options: [{ say: 9 }, { piece: 'n' }, { piece: 'b' }] } })).toBeNull();
  });
});

describe('planLessonClips — voiced', () => {
  const index = mergeClipIndexes(buildClipIndex(entries()), null);

  it('plays every sentence by its exact keys, in order, and hears exactly the bubble (no caps: four sentences)', () => {
    const event = utterance();
    const plan = planLessonClips(event, index, EXACT);
    expect(plan.src).toBe('lesson');
    expect(plan.level).toBe(1);
    expect(plan.lessonMissing).toEqual([]);
    expect(plan.misses).toEqual([]);
    expect(plan.clips.map((c) => c.id)).toEqual([ID.lead, ID.tail, ID.question, ID.quiz, ID.right]);
    expect(plan.clips.map((c) => c.role)).toEqual(['head', 'tail', 'whole', 'frag', 'whole']);
    expect(plan.clips.map((c) => c.sentence)).toEqual([0, 0, 1, 2, 3]);
    expect(plan.heard).toBe(event.text);
    expect(plan.sentences.map((s) => s.text)).toEqual(event.saySentences?.map((s) => s.text));
    expect(plan.stats).toEqual({ units: 5, slots: 0, split: 0, generic: 0, dropped: 0 });
    expect(plan.bark).toBe(false);
  });

  it('gaps: lead → «—» tail 280, after «.» / «!» 450, after «?» 500; audible durations (off − on)', () => {
    const plan = planLessonClips(utterance(), index, EXACT);
    expect(plan.clips.map((c) => c.gapBeforeMs)).toEqual([0, LESSON_GAPS_MS.dash, LESSON_GAPS_MS.sentence, LESSON_GAPS_MS.question, LESSON_GAPS_MS.question]);
    expect(plan.clips.map((c) => c.ms)).toEqual([800, 800, 800, 800, 800]);
    expect(plan.clips.map((c) => c.atMs)).toEqual([0, 1080, 2330, 3630, 4930]);
    expect(plan.ms).toBe(5730);
    expect(plan.sentences.map((s) => [s.fromMs, s.toMs])).toEqual([
      [0, 1880],
      [2330, 3130],
      [3630, 4430],
      [4930, 5730],
    ]);
    expect(plan.long).toBe(false);
  });

  it('blitz: every gap × 0.75', () => {
    const plan = planLessonClips(utterance(), index, { ...EXACT, blitz: true });
    expect(plan.clips.map((c) => c.gapBeforeMs)).toEqual([0, 210, 338, 375, 375]);
  });

  it('jitter: ±30 ms from the injected rng (never Math.random)', () => {
    const low = planLessonClips(utterance(), index, { rng: () => 0 });
    expect(low.clips.map((c) => c.gapBeforeMs)).toEqual([0, 250, 420, 470, 470]);
    const high = planLessonClips(utterance(), index, { rng: () => 0.999999 });
    expect(high.clips.map((c) => c.gapBeforeMs)).toEqual([0, 310, 480, 530, 530]);
    const mid = planLessonClips(utterance(), index, { rng: () => 0.5 });
    expect(mid.clips.map((c) => c.gapBeforeMs)).toEqual([0, 280, 450, 500, 500]);
  });

  it('a `cont` lead goes on into its tail at once (140 ms), and is never played as a lead said alone', () => {
    const cont = mergeClipIndexes(buildClipIndex(entries({ lead: { ctx: 'cont' } })), null);
    expect(planLessonClips(utterance(), cont, EXACT).clips[1]?.gapBeforeMs).toBe(LESSON_GAPS_MS.cont);
    const alone = utterance({ sentences: [{ text: joinSentence([LEAD_TEXT]), parts: [0] }] });
    const plan = planLessonClips(alone, cont, EXACT);
    expect(plan.src).toBe('none');
    expect(plan.lessonMissing).toEqual([0]);
    // a falling take of the same lead serves both uses
    const both = mergeClipIndexes(buildClipIndex(entries()), null);
    expect(planLessonClips(alone, both, EXACT).clips.map((c) => [c.id, c.role])).toEqual([[ID.lead, 'head']]);
  });

  it('finds a take whose wording number shifted by its pool variant and exact text (merged index only)', () => {
    const shifted = entries({ tail: { key: `line:v3.idea.mate#${tail.n + 40}` } });
    expect(planLessonClips(utterance(), mergeClipIndexes(buildClipIndex(shifted), null), EXACT).src).toBe('lesson');
    // a plain index has no text index: the exact key only
    expect(planLessonClips(utterance(), buildClipIndex(shifted), EXACT).lessonMissing).toEqual([0]);
  });

  it('avoids a take heard recently when the unit has another one', () => {
    const second = { ...entries().find((e) => e.id === ID.right), id: 'c00000000000b5' } as ClipIndexEntry;
    const two = mergeClipIndexes(buildClipIndex([...entries(), second]), null);
    const recency = createClipRecency();
    recency.note([ID.right]);
    for (const r of [0, 0.5, 0.99]) expect(planLessonClips(utterance(), two, { ...EXACT, recency, rng: () => r }).clips[4]?.id).toBe('c00000000000b5');
    recency.note(['c00000000000b5']);
    // both heard: the least recently heard one
    expect(planLessonClips(utterance(), two, { ...EXACT, recency }).clips[4]?.id).toBe(ID.right);
  });

  it('flags a very long plan (a diag only: nothing is dropped)', () => {
    const long = mergeClipIndexes(buildClipIndex(entries({ question: { ms: LESSON_LONG_MS, on: 0, off: LESSON_LONG_MS } })), null);
    const plan = planLessonClips(utterance(), long, EXACT);
    expect(plan.long).toBe(true);
    expect(plan.clips).toHaveLength(5);
  });
});

describe('planLessonClips — whole or nothing', () => {
  it('a missing tail silences the whole utterance and asks for its sentence (never a lead without its tail)', () => {
    const plan = planLessonClips(utterance(), mergeClipIndexes(buildClipIndex(entries({ tail: null })), null), EXACT);
    expect(plan).toMatchObject({ clips: [], src: 'none', level: 6, heard: '', lessonMissing: [0] });
    expect(plan.misses).toEqual([{ key: lessonUnitKey(SAY[1] as LessonSay), level: 6 }]);
  });

  it('lists every sentence that misses a unit, the options sentence included', () => {
    const plan = planLessonClips(utterance(), mergeClipIndexes(buildClipIndex(entries({ quiz: null, right: null, lead: null })), null), EXACT);
    expect(plan.lessonMissing).toEqual([0, 2, 3]);
    expect(planLessonClips(utterance(), mergeClipIndexes(null, null)).lessonMissing).toEqual([0, 1, 2, 3]);
  });

  it('a stale take (recorded for other words) is no recording', () => {
    const stale = entries({ lead: { text: `${LEAD_TEXT} вперёд` }, quiz: { text: 'Коня, слона или ладью?' } });
    expect(planLessonClips(utterance(), mergeClipIndexes(buildClipIndex(stale), null), EXACT).lessonMissing).toEqual([0, 2]);
  });

  it('a take the library could not load counts as missing', () => {
    const index = mergeClipIndexes(buildClipIndex(entries()), null);
    expect(planLessonClips(utterance(), index, { ...EXACT, available: (id) => id !== ID.question }).lessonMissing).toEqual([1]);
  });

  it('never voices nor requests an utterance with a sentence that can never be recorded', () => {
    const index = mergeClipIndexes(buildClipIndex(entries({ tail: null })), null);
    const cases: LessonSaySentence[] = [
      { text: 'Тс-с.', parts: [] }, // no parts, no quiz (a sound word)
      { text: tail.t, parts: [1] }, // a tail alone
      { text: question.t, parts: [2, 1] }, // a whole + a tail
      { text: 'Нападает.', parts: [3] }, // a quiz button said as a sentence
      { text: 'Не те слова.', parts: [2] }, // ids that do not make these words
      { text: 'Коня, слона или ладью?', parts: [], quiz: QUIZ }, // options that do not make these words
      { text: question.t, parts: [9] }, // an index out of range
    ];
    for (const bad of cases) {
      const event = utterance({ sentences: [{ text: joinSentence([LEAD_TEXT, tail.t]), parts: [0, 1] }, bad] });
      const plan = planLessonClips(event, index, EXACT);
      expect(plan.src, bad.text).toBe('none');
      expect(plan.lessonMissing, bad.text).toEqual([]);
      expect(plan.misses.length, bad.text).toBe(1);
    }
  });

  it('text that the sentences do not rebuild is never voiced', () => {
    const index = mergeClipIndexes(buildClipIndex(entries()), null);
    const event = { ...utterance(), text: 'Совсем другие слова.' };
    expect(planLessonClips(event, index, EXACT)).toMatchObject({ src: 'none', lessonMissing: [], misses: [{ key: 'text:mismatch', level: 6 }] });
  });

  it('no library: silent, nothing requested; an empty utterance: silent, no miss', () => {
    expect(planLessonClips(utterance(), null)).toMatchObject({ src: 'none', lessonMissing: [], misses: [{ key: 'library', level: 6 }] });
    expect(planLessonClips({ text: '', say: [], saySentences: [] }, mergeClipIndexes(null, null))).toMatchObject({ src: 'none', lessonMissing: [], misses: [] });
  });
});

describe('the sentences of an event without saySentences', () => {
  const s0 = joinSentence([LEAD_TEXT, tail.t]);
  const say = [SAY[0], SAY[1], SAY[4], SAY[0]] as LessonSay[];
  const lone = joinSentence([LEAD_TEXT]);

  it('are derived from the parts` roles: a lead takes its tail, a whole or a lone lead stands alone', () => {
    const text = `${s0} ${right.t} ${lone}`;
    expect(lessonSentencesOf({ text, say })).toEqual([
      { text: s0, parts: [0, 1] },
      { text: right.t, parts: [2] },
      { text: lone, parts: [3] },
    ]);
    const index = mergeClipIndexes(buildClipIndex(entries()), null);
    expect(planLessonClips({ text, say }, index, EXACT).heard).toBe(text);
  });

  it('are none when they do not rebuild the text, or the event has the options sentence, or a tail stands alone', () => {
    expect(lessonSentencesOf({ text: `${s0} Ещё что-то.`, say: [SAY[0], SAY[1]] as LessonSay[] })).toEqual([]);
    expect(lessonSentencesOf({ text: `${question.t} ${QUIZ_TEXT}`, say: [SAY[2], SAY[3]] as LessonSay[] })).toEqual([]);
    expect(lessonSentencesOf({ text: tail.t, say: [SAY[1]] as LessonSay[] })).toEqual([]);
    expect(lessonSentencesOf({ text: 'Раз.' })).toEqual([]);
    // an event that carries them is taken as it is
    const event = utterance();
    expect(lessonSentencesOf(event)).toBe(event.saySentences);
  });
});
