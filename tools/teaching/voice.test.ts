/**
 * «Дозапись голоса» — the voice simulation of the report (./voice.ts): the voice spec, an utterance's recordable units
 * (the options sentence as one unit), the server's request under the pack recipe and the daily cap, the per-game numbers
 * (voiced units / sentences / utterances, the share naming a piece), the shared cache paying once, and the
 * prefetch plan and its jobs file.
 */
import { describe, expect, it } from 'vitest';
import type { LessonQuiz, LessonSay } from '../../packages/shared/src/index.ts';
import { lessonUnitKey } from '../../packages/core/src/index.ts';
import { lessonQuizKey } from '../../packages/core/src/coach/clips/keys.ts';
import { PACK_TAG } from '../../packages/core/src/coach/clips/tts.ts';
import { jobMilli } from '../voice-clips/cost.ts';
import { DEFAULT_VOICE_MONEY, parseVoiceMoney, parseVoiceSpec, voiceSpecName } from './config.ts';
import type { EvRecord, GameRecord, VoiceMoney } from './config.ts';
import { parseRun } from './report.ts';
import { dayOfGame, namesPiece, prefetchCost, prefetchJobsFile, prefetchPlan, recordAfter, requestJobs, unitChars, unitCredits, voiceReport, voiceUnitsOf } from './voice.ts';

const END: LessonSay = { pool: 'v3.end.win', n: 2 };
const TAKE: LessonSay = { pool: 'v3.takeaway.found.tactic', n: 2, g: 'm' };
const LEAD: LessonSay = { pool: 'v3.lead.subject', n: 1, piece: 'n' };
const TAIL: LessonSay = { pool: 'v3.idea.promotion', n: 1, piece: 'p' };
const QUESTION: LessonSay = { pool: 'v3.quiz.q.oppIdea', n: 2 };
const OPTIONS: LessonSay[] = [
  { pool: 'v3.quiz.cat.develop', n: 1 },
  { pool: 'v3.quiz.cat.capture', n: 2 },
  { pool: 'v3.quiz.cat.attack', n: 1 },
];
const QUIZ: LessonQuiz = {
  id: 'q1',
  kind: 'oppIdea',
  ply: 3,
  question: 'Что задумал соперник этим ходом?',
  options: [
    { id: 'a', label: 'Выводит фигуру' },
    { id: 'b', label: 'Забирает фигуру' },
    { id: 'c', label: 'Нападает' },
  ],
  correctId: 'a',
};
const QUIZ_TEXT = 'Что задумал соперник этим ходом? Выводит фигуру, забирает фигуру или нападает?';

function ev(game: string, n: number, say: LessonSay[], voiced: boolean[], extra: Partial<EvRecord> = {}): EvRecord {
  return { t: 'ev', game, n, afterPly: 0, ply: 1, atMs: 0, source: 'end', moment: 'end', kind: 'teachTurn', priority: 1, text: 'Победа. Так и дальше.', bubble: '', say, cues: [], voiced, ...extra };
}

function game(child: number, gameNo: number): GameRecord {
  return {
    t: 'game',
    game: `c${child}g${String(gameNo).padStart(2, '0')}`,
    child,
    stage: child,
    gameNo,
    seed: 1,
    name: '',
    address: 'm',
    childColor: 'w',
    tc: 'rapid10',
    persona: 'petya',
    strategyId: null,
    strategyTitle: null,
    family: null,
    plies: [],
    turns: [],
    result: '1-0',
    termination: 'checkmate',
    takeaway: '',
    takeawayKey: '',
    events: 1,
    bookBytes: 0,
  };
}

const UNIT: VoiceMoney = { ...DEFAULT_VOICE_MONEY, pricing: 'unit' };

describe('voice spec', () => {
  it('parses lazy and k<K>[c] (the last-game rule is gone)', () => {
    expect(parseVoiceSpec('lazy')).toEqual({ mode: 'lazy' });
    expect(parseVoiceSpec('k4')).toEqual({ mode: 'k', k: 4, growCheap: false });
    expect(parseVoiceSpec('k3c')).toEqual({ mode: 'k', k: 3, growCheap: true });
    expect(parseVoiceSpec('k3p')).toBeNull();
    expect(parseVoiceSpec('k3pc')).toBeNull();
    expect(parseVoiceSpec('k0')).toBeNull();
    expect(parseVoiceSpec('p4')).toBeNull();
    expect(voiceSpecName({ mode: 'k', k: 6, growCheap: true })).toBe('k6c');
  });

  it('the money rules: pack pricing, no cap and 3 games a day by default', () => {
    expect(parseVoiceMoney({})).toEqual({ pricing: 'pack', dailyCapMilli: null, gamesPerDay: 3 });
    expect(parseVoiceMoney({ pricing: 'unit', dailyCap: '10', gamesPerDay: '1' })).toEqual({ pricing: 'unit', dailyCapMilli: 10_000, gamesPerDay: 1 });
    expect(() => parseVoiceMoney({ pricing: 'bulk' })).toThrow(/--voice-pricing/);
    expect(() => parseVoiceMoney({ dailyCap: '0' })).toThrow(/--daily-cap/);
    expect(() => parseVoiceMoney({ gamesPerDay: '2.5' })).toThrow(/--games-per-day/);
  });
});

describe('an utterance`s recordable units', () => {
  it('a lead before its tail (no end mark), a whole, one unit per said part', () => {
    const units = voiceUnitsOf({ say: [LEAD, TAIL, END], text: '' });
    expect(units.map((u) => [u.k, u.t, u.s, u.role])).toEqual([
      [lessonUnitKey(LEAD), 'Конь просится в бой', 0, 'lead'],
      [lessonUnitKey(TAIL), '— она дойдёт до края и превратится!', 0, 'tail'],
      [lessonUnitKey(END), 'Победа — я так рад, что прямо подпрыгиваю!', 1, 'whole'],
    ]);
    // a lead said alone gets the «.» its bubble shows
    expect(voiceUnitsOf({ say: [LEAD], text: '' })[0]).toMatchObject({ t: 'Конь просится в бой.', role: 'leadAlone' });
  });

  it('the stage 1–2 options sentence is ONE unit (its button wordings never are), even with no button wording said', () => {
    const units = voiceUnitsOf({ say: [QUESTION, ...OPTIONS], quiz: QUIZ, text: QUIZ_TEXT });
    expect(units.map((u) => u.k)).toEqual([lessonUnitKey(QUESTION), lessonQuizKey('Выводит фигуру, забирает фигуру или нападает?')]);
    expect(units[1]).toMatchObject({ s: 1, role: 'frag', text: 'Выводит фигуру, забирает фигуру или нападает?' });
    // pieces only: no button wording in `say`, the sentence is found in the text
    const pieces: LessonQuiz = { ...QUIZ, options: [{ id: 'r', label: 'Ладью' }, { id: 'n', label: 'Коня' }, { id: 'b', label: 'Слона' }] };
    const only = voiceUnitsOf({ say: [QUESTION], quiz: pieces, text: 'Что задумал соперник этим ходом? Ладью, коня или слона?' });
    expect(only.map((u) => [u.k, u.s])).toEqual([
      [lessonUnitKey(QUESTION), 0],
      ['frag:f:ладью, коня или слона|?', 1],
    ]);
    // a quiz whose options are not said aloud (stage 3+): no frag
    expect(voiceUnitsOf({ say: [QUESTION], quiz: QUIZ, text: 'Что задумал соперник этим ходом?' })).toHaveLength(1);
  });

  it('the server records the missing units of an utterance in one request, packed; the options sentence alone', () => {
    const units = voiceUnitsOf({ say: [LEAD, TAIL, QUESTION, ...OPTIONS], quiz: QUIZ, text: `Конь просится в бой — она дойдёт до края и превратится! ${QUIZ_TEXT}` });
    const jobs = requestJobs(units, 'pack');
    expect(jobs.map((j) => j.keys.length)).toEqual([3, 1]);
    expect(jobs[0]!.milli).toBe(jobMilli(['Конь просится в бой', '— она дойдёт до края и превратится!', 'Что задумал соперник этим ходом?'].join(PACK_TAG)));
    expect(requestJobs(units, 'unit')).toHaveLength(4);
  });

  it('the daily cap: a job that does not fit pauses recording for the rest of the day', () => {
    const units = voiceUnitsOf({ say: [END, TAKE], text: '' });
    const cap: VoiceMoney = { pricing: 'unit', dailyCapMilli: 300, gamesPerDay: 3 };
    const first = recordAfter(units, new Set(), cap, { day: 0, milli: 0, capped: false });
    expect([...first.recorded]).toEqual([lessonUnitKey(END)]);
    expect(first.day).toEqual({ day: 0, milli: 150, capped: true });
    // paused: even a unit that would fit waits for the next day
    const later = recordAfter(voiceUnitsOf({ say: [{ pool: 'v3.quiz.right', n: 1 }], text: '' }), new Set(), cap, first.day);
    expect(later.recorded.size).toBe(0);
    // already recorded units are not requested again; no cap = everything
    expect(recordAfter(units, new Set([lessonUnitKey(END)]), UNIT, { day: 0, milli: 0, capped: false }).recorded).toEqual(new Set([lessonUnitKey(TAKE)]));
    expect(dayOfGame(1, 3)).toBe(0);
    expect(dayOfGame(3, 3)).toBe(0);
    expect(dayOfGame(4, 3)).toBe(1);
  });

  it('names a piece in any case', () => {
    expect(namesPiece('Ходи конём!')).toBe(true);
    expect(namesPiece('Ладью, коня или слона?')).toBe(true);
    expect(namesPiece('Сейчас героем будет ферзь')).toBe(true);
    expect(namesPiece('Победа — я так рад!')).toBe(false);
    expect(namesPiece('Такое бывает.')).toBe(false);
  });
});

describe('voice report', () => {
  it('prices each new unit alone and counts voiced units, sentences and utterances (a log with per-part flags)', () => {
    const run = parseRun([ev('c1g01', 0, [END, TAKE], [false, false]), game(1, 1), ev('c1g02', 0, [END, TAKE], [true, false]), game(1, 2)]);
    const r = voiceReport(run, { policy: 'k3', shared: false, money: UNIT });
    const cr = unitCredits(unitChars(END)) + unitCredits(unitChars(TAKE));
    expect(r.rows[0]?.newUnits).toBe(2);
    expect(r.rows[0]?.newCredits).toBeCloseTo(cr, 5);
    expect(r.rows[0]?.jobs).toBe(2);
    // game 2: the takeaway was flagged unvoiced but it was paid in game 1 already — no new unit
    expect(r.rows[1]?.newUnits).toBe(0);
    expect(r.rows[1]?.partsPct).toBe(50);
    expect(r.rows[1]?.utterancesPct).toBe(0);
    expect(r.totals.perChild['1']).toBeCloseTo(cr, 5);
  });

  it('the pack recipe records an utterance`s missing units in one job when they fit', () => {
    const run = parseRun([ev('c1g01', 0, [END, TAKE], [false, false]), game(1, 1)]);
    const r = voiceReport(run, { policy: 'k3', shared: false });
    expect(r.money.pricing).toBe('pack');
    expect(r.rows[0]?.jobs).toBe(1);
    const packed = jobMilli(['Победа — я так рад, что прямо подпрыгиваю!', 'Сам заметил сильный ход. Так и дальше: сначала ищи удар, а тихий ход — потом.'].join(PACK_TAG)) / 1000;
    expect(r.rows[0]?.newCredits).toBeCloseTo(packed, 5);
    // never dearer than each unit alone (here 43 + 7 + 80 characters: the same 3 blocks)
    expect(r.rows[0]!.newCredits).toBeLessThanOrEqual(unitCredits(unitChars(END)) + unitCredits(unitChars(TAKE)) + 1e-9);
  });

  it('the worker`s records: units voiced when said, recorded after (or left for another day by the cap), the piece share', () => {
    const vu = (k: string, t: string, s: number, flags: { v?: 1; r?: 1 }) => ({ k, t, s, ...flags });
    const e1 = ev('c1g01', 0, [LEAD, TAIL, END], [], {
      voiced: undefined,
      vu: [vu('a', 'Конь просится в бой', 0, { r: 1 }), vu('b', '— и это мат!', 0, { r: 1 }), vu('c', 'Победа!', 1, {})],
    });
    const e2 = ev('c1g01', 1, [END], [], { voiced: undefined, vu: [vu('a', 'Конь просится в бой', 0, { v: 1 }), vu('b', '— и это мат!', 0, { v: 1 })] });
    const r = voiceReport(parseRun([e1, e2, game(1, 1)]), { policy: 'k3', shared: false, money: { pricing: 'pack', dailyCapMilli: 150, gamesPerDay: 3 } });
    expect(r.rows[0]).toMatchObject({ newUnits: 2, jobs: 1, cappedUnits: 1, utterancesPct: 50 });
    // 3 sentences, 2 name a piece (the knight twice)
    expect(r.rows[0]?.sentencesPct).toBeCloseTo(100 / 3, 5);
    expect(r.rows[0]?.piecePct).toBeCloseTo(200 / 3, 5);
  });

  it('a shared cache pays a unit once for all children', () => {
    const run = parseRun([ev('c1g01', 0, [END], [false]), game(1, 1), ev('c2g01', 0, [END], [false]), game(2, 1)]);
    expect(voiceReport(run, { policy: 'lazy', shared: true }).totals.newUnits).toBe(1);
    expect(voiceReport(run, { policy: 'lazy', shared: false }).totals.newUnits).toBe(2);
  });
});

describe('the prefetch plan', () => {
  it('stays in budget (packed), takes the pools every game needs first, never a button wording', () => {
    const run = parseRun([ev('c1g01', 0, [END, TAKE], [false, false]), game(1, 1), ev('c1g02', 0, [END], [false]), game(1, 2)]);
    const plan = prefetchPlan(run, { stage: 1, g: 'm', budget: 0.3 });
    expect(prefetchCost(plan).milli).toBeLessThanOrEqual(300);
    expect(plan[0]?.pool).toBe('v3.end.win');
    // stage 1 is a non-reader, but the end of the game is not a quiz: value 1 (every game said it)
    expect(plan[0]?.value).toBe(1);
    expect(plan.every((u) => u.key === lessonUnitKey(u))).toBe(true);
    const quiz = parseRun([ev('c1g01', 0, [QUESTION, ...OPTIONS], [false, false, false, false], { quiz: QUIZ, text: QUIZ_TEXT }), game(1, 1)]);
    const q = prefetchPlan(quiz, { stage: 1, g: 'm', budget: 5 });
    expect(q.some((u) => u.pool.startsWith('v3.quiz.cat.'))).toBe(false);
    // what a non-reader must hear counts double: the question and the options sentence
    expect(q.find((u) => u.pool === QUESTION.pool)?.value).toBe(2);
    expect(q.find((u) => u.role === 'frag')).toMatchObject({ key: lessonQuizKey('Выводит фигуру, забирает фигуру или нападает?'), value: 2 });
    // what the library already holds is never bought again
    const without = prefetchPlan(quiz, { stage: 1, g: 'm', budget: 5, covered: (key) => key.startsWith(`line:${QUESTION.pool}#`) });
    expect(without.some((u) => u.pool === QUESTION.pool)).toBe(false);
  });

  it('the jobs file: campaign prefetch, take 101, packed with the tag, split at 700 ms, the options sentence alone, valid', () => {
    const quiz = parseRun([ev('c1g01', 0, [QUESTION, ...OPTIONS, END, TAKE], [], { quiz: QUIZ, text: `${QUIZ_TEXT} Победа.` }), game(1, 1)]);
    const plan = prefetchPlan(quiz, { stage: 1, g: 'm', budget: 20 });
    const file = prefetchJobsFile(plan, { stage: 1, g: 'm' });
    expect(file).toMatchObject({ v: 1, voiceKey: 'giselle-mm1', campaign: 'prefetch' });
    expect(file.jobs.every((j) => j.take === 101 && j.tier === 'prefetch' && j.batch === 'prefetch-s1m')).toBe(true);
    const frag = file.jobs.find((j) => j.pieces.some((p) => 'kind' in p && p.kind === 'frag'))!;
    expect(frag.pieces).toHaveLength(1);
    expect(frag.recipe).toBe('single');
    const pack = file.jobs.find((j) => j.pieces.length > 1)!;
    expect(pack).toMatchObject({ recipe: 'pack', split: { mode: 'tags', minSilenceMs: 700 } });
    expect(pack.prompt.split(PACK_TAG)).toHaveLength(pack.pieces.length);
    // a question goes last in its job
    for (const j of file.jobs) {
      const parts = j.prompt.split(PACK_TAG);
      expect(parts.slice(0, -1).some((p) => p.trim().endsWith('?'))).toBe(false);
    }
    const take = file.jobs.flatMap((j) => j.pieces).find((p) => 'key' in p && p.key === lessonUnitKey(TAKE));
    expect(take).toMatchObject({ role: 'whole', critical: ['Сам', 'заметил'], pool: 'v3.takeaway.found.tactic/m' });
    expect(prefetchCost(plan).milli).toBe(file.jobs.reduce((n, j) => n + jobMilli(j.prompt), 0));
  });
});

describe('the prefetch plan command', () => {
  it('needs the overlay: a plan that ignored what the server recorded on demand would buy it again', async () => {
    const { main } = await import('./cli.ts');
    const argv = ['--prefetch-plan', '5', '--prefetch-from', '/nonexistent/ref-run', '--stage', '1', '--gender', 'm'];
    await expect(main(argv)).rejects.toThrow(/--prefetch-plan needs --overlay DIR/);
    await expect(main([...argv, '--overlay', 'off'])).rejects.toThrow(/not off/);
  });
});
