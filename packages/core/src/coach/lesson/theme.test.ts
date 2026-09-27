/**
 * The theme of the game (docs/TEACHING.md §2.1, §2.3, §6.3): the announcement, the name only when the game follows
 * the card (1.e4 c5 is never «Итальянская»), the theme sentence of a turn, the pairs «family + idea» of the link.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { getStrategy } from '../../../../content/src/strategies.ts';
import { explainMove } from '../moveIdeas.ts';
import { emptyLessonHistory } from './book.ts';
import { initialLessonMemory } from './memory.ts';
import { THEME_REMIND_TURNS, familyGoalLive, familyOf, pairHolds, recallKeyOf, themeCardOf, themeLine, themeLink, themeStart } from './theme.ts';
import type { ThemeLineArgs } from './theme.ts';
import { moveFacts } from './truth.ts';

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function uciOf(fen: string, san: string): string {
  const m = new Chess(fen).move(san);
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

const italian = themeCardOf(getStrategy('italian') ?? null);
const london = themeCardOf(getStrategy('london') ?? null);
const sicilian = themeCardOf(getStrategy('sicilian') ?? null);

function lineArgs(sans: readonly string[], over: Partial<ThemeLineArgs> = {}): ThemeLineArgs {
  const chess = new Chess();
  for (const s of sans) chess.move(s);
  return {
    stage: 3,
    childColor: 'w',
    ply: sans.length + 1,
    turnNo: Math.floor(sans.length / 2) + 1,
    historySan: sans,
    fen: chess.fen(),
    phase: 'opening',
    opening: true,
    card: italian,
    lm: { ...initialLessonMemory(), theme: { ...initialLessonMemory().theme, announced: true } },
    ...over,
  };
}

describe('the announcement (§2.1)', () => {
  it('White before move 1: the family only — the Italian cannot be promised before Black answers', () => {
    expect(themeStart({ stage: 4, childColor: 'w', historySan: [], card: italian, history: null })).toMatchObject({ pool: 'v3.theme.family.f7', named: false, family: 'f7' });
    expect(themeStart({ stage: 4, childColor: 'w', historySan: [], card: london, history: null })).toMatchObject({ pool: 'v3.theme.london', named: true });
    expect(themeStart({ stage: 2, childColor: 'w', historySan: [], card: london, history: null })).toMatchObject({ pool: 'v3.theme.family.fortress', named: false });
  });

  it('Black after the first move: the name when the card still holds', () => {
    expect(themeStart({ stage: 3, childColor: 'b', historySan: ['e4'], card: sicilian, history: null })).toMatchObject({ pool: 'v3.theme.sicilian', named: true });
    expect(themeStart({ stage: 3, childColor: 'b', historySan: ['d4'], card: sicilian, history: null })).toMatchObject({ pool: 'v3.theme.family.counterCenter', named: false });
  });

  it('the recall: one of two games, the takeaway of the last game when it is a concept', () => {
    const h = { ...emptyLessonHistory(), gameSeq: 3, takeaways: [{ game: 1, key: 'theme.center' }, { game: 2, key: 'mistake.hanging' }] };
    const got = recallKeyOf(h);
    // (the content may not have the recall line yet — then nothing is recalled)
    expect([null, 'mistake.hanging', 'theme.center']).toContain(got);
    expect(recallKeyOf({ ...h, gameSeq: 4 })).toBeNull();
    expect(recallKeyOf({ ...h, takeaways: [{ game: 2, key: 'quiz.oppIdea' }] })).toBeNull();
  });
});

describe('the theme sentence of a turn', () => {
  it('1.e4 c5 with the Italian card — the name is never said', () => {
    expect(themeLine(lineArgs(['e4', 'c5']))?.kind).not.toBe('named');
    expect(themeLine(lineArgs(['e4', 'c5', 'Nf3', 'd6']))?.pool ?? '').not.toMatch(/^v3\.theme\.named\./);
  });

  it('after 1…e5 the Italian is named (stages 3–5); stages 1–2 name it as a reward after three moves of the line', () => {
    expect(themeLine(lineArgs(['e4', 'e5']))).toEqual({ pool: 'v3.theme.named.italian', kind: 'named' });
    expect(themeLine(lineArgs(['e4', 'e5'], { stage: 2 }))?.kind).not.toBe('named');
    expect(themeLine(lineArgs(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], { stage: 2 }))).toEqual({ pool: 'v3.theme.named.italian', kind: 'named' });
  });

  it('«соперник свернул с дороги» at stages 3–5 only, on the move he left it', () => {
    const named = { ...initialLessonMemory(), theme: { ...initialLessonMemory().theme, announced: true, named: true } };
    expect(themeLine(lineArgs(['e4', 'e5', 'Nf3', 'd6'], { lm: named }))).toEqual({ pool: 'v3.theme.left', kind: 'left' });
    expect(themeLine(lineArgs(['e4', 'e5', 'Nf3', 'd6'], { lm: named, stage: 2 }))?.kind).not.toBe('left');
  });

  it('chapters once; a reminder after 10+ plies of silence in the opening', () => {
    const named = { ...initialLessonMemory(), theme: { ...initialLessonMemory().theme, announced: true, named: true } };
    expect(themeLine(lineArgs(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'], { lm: named, phase: 'middlegame', turnNo: 5 }))).toEqual({ pool: 'v3.phase.middlegame', kind: 'phase' });
    const said = { ...named, phaseSaid: { middlegame: true, endgame: false } };
    expect(themeLine(lineArgs(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'], { lm: said, phase: 'middlegame', turnNo: 5 }))).toEqual({ pool: 'v3.theme.remind.f7', kind: 'remind' });
    expect(themeLine(lineArgs(['e4', 'e5', 'Nf3', 'Nc6'], { lm: named, turnNo: 3 }))).toBeNull();
  });
});

describe('reminders and chapters after the second 50-game run', () => {
  const named = { ...initialLessonMemory(), theme: { ...initialLessonMemory().theme, announced: true, named: true }, phaseSaid: { middlegame: true, endgame: false } };
  const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'];

  it('at most one reminder in 10 plies', () => {
    const lm = { ...named, theme: { ...named.theme, lastRemindTurn: 1 } };
    expect(THEME_REMIND_TURNS).toBe(5);
    expect(themeLine(lineArgs(ITALIAN, { lm, turnNo: 5 }))).toBeNull();
    expect(themeLine(lineArgs(ITALIAN, { lm, turnNo: 6 }))).toEqual({ pool: 'v3.theme.remind.f7', kind: 'remind' });
  });

  it('never a reminder in the endgame, nor once the endgame chapter was said', () => {
    expect(themeLine(lineArgs(ITALIAN, { lm: named, turnNo: 9, phase: 'endgame', opening: false }))).toEqual({ pool: 'v3.phase.endgame', kind: 'phase' });
    const end = { ...named, phaseSaid: { middlegame: true, endgame: true } };
    expect(themeLine(lineArgs(ITALIAN, { lm: end, turnNo: 9, phase: 'endgame', opening: false }))).toBeNull();
    // (the material came back after a promotion: still no reminder)
    expect(themeLine(lineArgs(ITALIAN, { lm: end, turnNo: 9, phase: 'middlegame', opening: true }))).toBeNull();
  });

  it('the middlegame chapter never comes after the endgame chapter', () => {
    const end = { ...named, phaseSaid: { middlegame: false, endgame: true } };
    expect(themeLine(lineArgs(ITALIAN, { lm: end, turnNo: 18, phase: 'middlegame', opening: false }))?.pool ?? null).not.toBe('v3.phase.middlegame');
    const none = { ...named, phaseSaid: { middlegame: false, endgame: false } };
    expect(themeLine(lineArgs(ITALIAN, { lm: none, turnNo: 18, phase: 'middlegame', opening: false }))).toEqual({ pool: 'v3.phase.middlegame', kind: 'phase' });
  });

  it('remind.f7 only while the pawn f7 stands and the king is at home — even in the opening', () => {
    expect(themeLine(lineArgs(ITALIAN, { lm: named, turnNo: 6 }))?.pool).toBe('v3.theme.remind.f7');
    const castled = [...ITALIAN, 'd4', 'O-O'];
    expect(themeLine(lineArgs(castled, { lm: named, turnNo: 6 }))).toBeNull();
    const noF7 = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'f6', 'd3', 'f5'];
    expect(themeLine(lineArgs(noF7, { lm: named, turnNo: 6 }))).toBeNull();
    expect(familyGoalLive('f7', fenOf(ITALIAN), 'w')).toBe(true);
    expect(familyGoalLive('f7', fenOf(castled), 'w')).toBe(false);
    expect(familyGoalLive('f7', fenOf(noF7), 'w')).toBe(false);
  });

  it('the family goals of castle and development: our king at home with a right to castle; a minor piece at home', () => {
    expect(familyGoalLive('castle', fenOf(ITALIAN), 'w')).toBe(true);
    expect(familyGoalLive('castle', fenOf([...ITALIAN, 'O-O', 'O-O']), 'w')).toBe(false);
    expect(familyGoalLive('castle', fenOf(['e4', 'e5', 'Ke2', 'Nc6']), 'w')).toBe(false);
    expect(familyGoalLive('development', fenOf(ITALIAN), 'w')).toBe(true);
    const out = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Nc3', 'Nf6', 'd3', 'd6', 'Bg5', 'Bg4'];
    expect(familyGoalLive('development', fenOf(out), 'w')).toBe(false);
    expect(familyGoalLive('center', fenOf(out), 'w')).toBe(true);
  });
});

describe('the link «family + idea» (§6.3)', () => {
  const at = ['e4', 'e5', 'Nf3', 'Nc6'];
  const fen = fenOf(at);

  it('f7: only a move that hits the pawn f7 while the king is at home; Кc3 is «развитие», not «f7»', () => {
    const bc4 = moveFacts(fen, uciOf(fen, 'Bc4'));
    const nc3 = moveFacts(fen, uciOf(fen, 'Nc3'));
    const develop = { id: 'develop' as const, squares: [], phraseRu: '' };
    expect(bc4 && pairHolds('f7', develop, bc4)).toBe(true);
    expect(nc3 && pairHolds('f7', develop, nc3)).toBe(false);
    expect(nc3 && pairHolds('development', develop, nc3)).toBe(true);
  });

  it('the gambit «отдали пешку» only a pawn down; the kingside attack only near a king on f–h', () => {
    const f = moveFacts(fen, uciOf(fen, 'Nc3'));
    expect(f && pairHolds('gambit', { id: 'develop' as const, squares: [], phraseRu: '' }, f)).toBe(false);
    const castled = 'r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQ - 0 6';
    const g5 = moveFacts(castled, 'c1g5');
    expect(g5 && pairHolds('kingsideAttack', { id: 'attack' as const, squares: ['f6'], phraseRu: '' }, g5)).toBe(true);
    expect(g5 && pairHolds('kingsideAttack', { id: 'attack' as const, squares: ['a7'], phraseRu: '' }, g5)).toBe(false);
  });

  it('the link: a goal the move achieves first, at most once in three advices, the tail in blitz', () => {
    const uci = uciOf(fen, 'Bc4');
    const ideas = explainMove({ fen, uci });
    const idea = ideas.find((i) => i.id === 'develop') ?? ideas[0];
    const lm = initialLessonMemory();
    const base = { card: italian, blitz: false, fen, childColor: 'w' as const, advice: { uci, san: 'Bc4' }, idea, historySan: at, turnNo: 3, lm };
    const link = themeLink(base);
    expect(link?.pool).toMatch(/^v3\.(goal\.aimF7|why\.f7)$/);
    expect(themeLink({ ...base, lm: { ...lm, theme: { ...lm.theme, links: [2] } } })).toBeNull();
    expect(themeLink({ ...base, lm: { ...lm, theme: { ...lm.theme, links: [2] } }, force: true })).not.toBeNull();
    expect(themeLink({ ...base, blitz: true })).toEqual({ pool: 'v3.themeTail.f7', kind: 'tail', family: 'f7' });
    expect(familyOf(italian)).toBe('f7');
  });
});
