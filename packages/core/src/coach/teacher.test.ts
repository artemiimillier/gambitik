/**
 * Teacher brain (docs/TEACHER-MODE.md) — the scenario checks T1–T12 of §8.2 that live in @gambit/core, with a SCRIPTED
 * engine: the MultiPV lines of §8.1 (Stockfish 19 lite, depth 16). The repertoire, the main-line table, the
 * opening book and the concept cards are the real sibling packages (test-only relative imports — @gambit/core does not
 * depend on them at runtime; the game passes them in through TeachContext).
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, CoachEvent, Color, EngineLine, MoveJudgement, StudentProfile, Threat } from '@gambit/shared';
import { getConceptCard } from '../../../content/src/conceptCards.ts';
import { getRepertoirePlan, mainLineMoves } from '../../../content/src/openings.ts';
import { lookupOpening } from '../../../openings/src/index.ts';
import { winPct } from '../analysis/eval.ts';
import { MAX_BRIEF_CHARS, MAX_TEACH_BRIEF_CHARS } from './brief.ts';
import { buildTakebackOffer } from './events.ts';
import { decideIntervention } from './policy.ts';
import { countSentences, countWords } from './phrase.ts';
import {
  OPP_SENTENCE_WORDS,
  TEACH_TOLERANCE_CP,
  bookMovesToVerify,
  buildCompareMoveAnswerRu,
  buildTeachReaction,
  buildTeachRepeat,
  buildTeachReveal,
  buildTeachTurn,
  initialTeachMemory,
  middlegamePlan,
  openingPlanFacts,
  pickAdvice,
  planTeachTurn,
  queenChase,
  reactionVerdict,
  teachModeOf,
  treasureRevealMs,
} from './teacher.ts';
import type { AdviceCandidate, MoveIdeasApi, ReactionVerdict, TeachContext, TeachMemory, TeachPlan } from './teacher.ts';
import { computePositionFacts } from '../analysis/facts.ts';
import { constRng, judgement, profile, seededRng } from './test-fixtures.ts';
import { isEarlyQueenMove } from './moveIdeas.ts';
import { threatFromNullMoveLine } from './threats.ts';

// ───────────────────────── the scripted engine (§8.1) ─────────────────────────

type Score = number | { mate: number };
/** [SAN of the move, score from the side to move, …continuation SANs] */
type LineSpec = [string, Score, ...string[]];

function uciLine(fen: string, sans: readonly string[]): string[] {
  const chess = new Chess(fen);
  return sans.map((san) => {
    const m = chess.move(san);
    return `${m.from}${m.to}${m.promotion ?? ''}`;
  });
}

function line(fen: string, spec: LineSpec, multipv: number, depth: number): EngineLine {
  const [san, score, ...cont] = spec;
  return {
    multipv,
    depth,
    pvUci: uciLine(fen, [san, ...cont]),
    cp: typeof score === 'number' ? score : null,
    mate: typeof score === 'number' ? null : score.mate,
  };
}

function scripted(fen: string, specs: readonly LineSpec[], depth = 16): AnalysisResult {
  const lines = specs.map((sp, i) => line(fen, sp, i + 1, depth));
  return { fen, lines, bestmove: lines[0]?.pvUci[0] ?? '', depth, timeMs: 300 };
}

const START = new Chess().fen();

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

/** A teacher context after `sans` (the last move — the bot's), with the real content / openings wiring. */
function ctxAfter(sans: readonly string[], childColor: Color, over: Partial<TeachContext> & { specs?: readonly LineSpec[]; depth?: number } = {}): TeachContext {
  const fen = fenOf(sans);
  const { specs, depth, ...rest } = over;
  let lastBotMove: TeachContext['lastBotMove'] = null;
  if (sans.length > 0) {
    const before = fenOf(sans.slice(0, -1));
    const chess = new Chess(before);
    const m = chess.move(sans[sans.length - 1] as string);
    lastBotMove = { uci: `${m.from}${m.to}${m.promotion ?? ''}`, san: m.san, fenBefore: before };
  }
  return {
    fen,
    ply: sans.length + 1,
    childColor,
    profile: profile({ stage: 1 }),
    analysis: specs ? scripted(fen, specs, depth) : null,
    lastBotMove,
    historySan: sans,
    repertoire: getRepertoirePlan(sans, childColor) ?? null,
    mainLineSans: mainLineMoves(fen),
    openingNameRu: (f) => lookupOpening(f)?.nameRu,
    conceptCard: getConceptCard,
    conceptsIntroduced: [],
    ...rest,
  };
}

function turn(ctx: TeachContext, rng: () => number = constRng(0)): { plan: TeachPlan; ev: CoachEvent } {
  const plan = planTeachTurn(ctx, rng);
  return { plan, ev: buildTeachTurn(plan, rng) };
}

function briefLine(brief: string | undefined, name: string): string {
  return (brief ?? '').split('\n').find((l) => l.startsWith(`${name}:`)) ?? '';
}

/** The brief without its «Нельзя» line (which quotes forbidden words on purpose), lower-cased. */
function claims(brief: string | undefined): string {
  return (brief ?? '').split('\n').filter((l) => !l.startsWith('Нельзя:')).join('\n').toLowerCase();
}

/** A judgement of the child's move with the engine numbers given (child's point of view). */
function judged(sans: readonly string[], played: string, best: string, o: { before: number; after: number | { mate: number }; refutation?: string[]; loss?: number; motif?: MoveJudgement['allowedMotif'] }): MoveJudgement {
  const after = typeof o.after === 'number' ? { cp: o.after, mate: null } : { cp: null, mate: o.after.mate };
  const wb = winPct({ cp: o.before, mate: null });
  const wa = winPct(after);
  return judgement({
    setup: [...sans],
    played,
    best,
    refutation: o.refutation ?? [],
    over: {
      ply: sans.length + 1,
      evalBefore: { cp: o.before, mate: null },
      evalAfter: after,
      winPctBefore: wb,
      winPctAfter: wa,
      winPctLoss: Math.max(0, wb - wa),
      classification: wb - wa < 1 ? 'best' : wb - wa < 2 ? 'excellent' : wb - wa < 5 ? 'good' : wb - wa < 10 ? 'inaccuracy' : wb - wa < 20 ? 'mistake' : 'blunder',
      materialLossPawns: o.loss ?? 0,
      allowedMotif: o.motif,
    },
  });
}

const E1: LineSpec[] = [['e4', 28], ['Nf3', 20], ['d4', 20]];
const E2: LineSpec[] = [['Nf3', 19], ['Nc3', 8], ['Bc4', 8]];
const E3: LineSpec[] = [['Nc6', 30], ['d6', 24], ['Qe7', 24]];
const E4: LineSpec[] = [['g6', 28], ['Qe7', 11], ['Qf6', -11]];
const E5: LineSpec[] = [['d4', 33], ['Bb5', 32], ['Bc4', 20]];
const E7: LineSpec[] = [['Qxd4', 553], ['f4', -44], ['Be3', -47]];
const E8: LineSpec[] = [['d4', 65], ['O-O', 53], ['c3', 35]];
const E9_FEN = 'r1bqr1k1/bpp2pp1/p1np1n1p/4p3/2B1P3/2PP1NN1/PP3PPP/R1BQR1K1 w - - 2 11';
const E9: LineSpec[] = [['b4', 19], ['a4', 14], ['Bb3', 10]];
const E10_FEN = '8/8/5k2/8/8/4K3/4P3/8 w - - 0 1';
const E10: LineSpec[] = [['Kd4', 631], ['Ke4', 631], ['Kf4', 631]];
/** Black after 1.e4 — not in the §8.1 table; plausible numbers only to reach T3 through the real first turn. */
const B1: LineSpec[] = [['e5', -25], ['c5', -30], ['e6', -38]];

const LATIN = /[A-Za-z]/;

function checkFormat(ev: CoachEvent): void {
  const brief = ev.brief ?? '';
  expect(ev.text, ev.text).not.toMatch(LATIN);
  expect(brief, brief).not.toMatch(LATIN);
  expect(brief).toMatch(/^Момент: [А-ЯЁ]/);
  expect(brief).toMatch(/\nМожно назвать: /);
  expect(brief).toMatch(/\nЦель: [А-ЯЁ]/);
  expect(brief).toMatch(/\nНельзя: [А-ЯЁ]/);
  expect(brief, brief).not.toMatch(/undefined|null|NaN|\s{2,}|\s[,.!?;:]|;\s*;|\.\./);
  expect(brief, brief).not.toMatch(/%|сантипеш|движ|\d/);
  const style = ev.teach?.style ?? 'full';
  expect(brief.length, brief).toBeLessThanOrEqual(style === 'concept' ? MAX_BRIEF_CHARS : style === 'short' ? 600 : MAX_TEACH_BRIEF_CHARS);
  // the model never hears «лучший ход» as a claim; the forbid line may quote the word to ban it
  const said = brief.split('\n').filter((l) => !l.startsWith('Нельзя:')).join('\n');
  // («куда лучше поставить слона» of the knights-first principle is fine; «лучший ход» is not)
  expect(said, said).not.toMatch(/(?<![а-яё])лучш(ий|его|ему|им|ем)(?![а-яё])/i);
  expect(ev.text, ev.text).not.toMatch(/лучший ход|\d/);
  const maxWords = style === 'short' ? 15 : style === 'concept' ? 60 : 40;
  expect(countWords(ev.text), `${style}: ${ev.text}`).toBeLessThanOrEqual(maxWords);
  if (style === 'short') expect(countSentences(ev.text), ev.text).toBe(1);
  // «Можно назвать»: at most two moves of the child (an opponent's move is marked)
  const nameable = briefLine(brief, 'Можно назвать').replace(/^Можно назвать: /, '').replace(/\.$/, '').split('; ');
  expect(nameable.filter((x) => !/ход соперника|не называй/.test(x)).length).toBeLessThanOrEqual(2);
  expect(ev.text).toMatch(/^[А-ЯЁ«]/);
  expect(ev.text).toMatch(/[.!?»]$/);
  // «Можно и пешка на дэ четыре» is not Russian (the move is a nominative noun phrase)
  expect(ev.text, ev.text).not.toMatch(/Можно и (пешка|конь|слон|ладья|ферзь|король|короткая|длинная)/);
  // one colon per advice sentence («Пешка бьёт на цэ шесть: выгодно бьёшь …: даже после …»)
  for (const sentence of ev.text.split(/(?<=[.!?])\s+/)) {
    if (/^(Смотри на зелёную стрелку|Мой совет|Хороший ход)/.test(sentence)) expect((sentence.match(/:/g) ?? []).length, sentence).toBeLessThanOrEqual(1);
  }
}

// ───────────────────────── T1 ─────────────────────────

describe('T1 — White, stage 1, the first move (E1)', () => {
  const ctx = ctxAfter([], 'w', { specs: E1 });
  const { plan, ev } = turn(ctx);

  it('one teachTurn with moment openingPlan for ply 1', () => {
    expect(ev.kind).toBe('teachTurn');
    expect(ev.teach?.moment).toBe('openingPlan');
    expect(ev.teach?.ply).toBe(1);
    expect(ev.pauseClock).toBe(true);
    expect(plan.style).toBe('concept');
  });

  it('advice e4 green (repertoire / main line), d4 blue (main line) — both within 30 cp of the first line', () => {
    expect(ev.teach?.advice.map((a) => [a.san, a.arrow])).toEqual([
      ['e4', 'green'],
      ['d4', 'blue'],
    ]);
    expect(['repertoire', 'mainLine']).toContain(ev.teach?.advice[0]?.source);
    expect(ev.teach?.advice[1]?.source).toBe('mainLine');
    for (const a of plan.advice) expect(28 - a.scoreCp).toBeLessThanOrEqual(TEACH_TOLERANCE_CP);
    expect(plan.advice.every((a) => a.verifiedBy === 'multipv')).toBe(true);
  });

  it('the brief names the green pawn move only (the blue one is a silent arrow off choice turns), ONE reason (the centre) and the plan, never the knight', () => {
    // (with the blue move in the brief a voice model may advise it)
    const brief = ev.brief ?? '';
    expect(plan.choice).toBe(false);
    expect(brief).toContain('пешка на е четыре');
    expect(brief).not.toContain('пешка на дэ четыре');
    // (nothing extra: the move + ONE reason; the first turn's one extra is the plan)
    expect(briefLine(brief, 'Факты')).toMatch(/^Факты: Пешка на е четыре \(зелёная стрелка\): ставит пешку в центр\. План: /);
    expect(plan.extra).toBe('openingPlan');
    const nameable = briefLine(brief, 'Можно назвать');
    expect(nameable).toBe('Можно назвать: пешка на е четыре (зелёная стрелка).');
    expect(nameable).not.toContain('конь на эф три');
    // no «how common» claim next to an engine-checked move (it would be one more clause)
    expect(claims(brief)).not.toMatch(/так часто начинают|самый популярный|все так играют|ход проверен/);
    checkFormat(ev);
  });

  it('green arrow e2→e4, blue arrow d2→d4', () => {
    expect(ev.board?.arrows).toEqual([
      { from: 'e2', to: 'e4', color: 'green' },
      { from: 'd2', to: 'd4', color: 'blue' },
    ]);
  });

  it('«первый ход» only on the first move: a game whose first turn was cut (no memory at ply 3) is not told so', () => {
    expect(briefLine(ev.brief, 'Момент')).toMatch(/это его первый ход/);
    const late = turn(ctxAfter(['e4', 'e5'], 'w', { specs: E2 }));
    expect(late.ev.teach?.moment).toBe('openingPlan');
    expect(late.ev.brief ?? '').not.toMatch(/первый ход/);
    checkFormat(late.ev);
  });
});

// ───────────────────────── T2 ─────────────────────────

describe('T2 — White, stage 1: the bot answers 1…e5 (E2)', () => {
  const first = turn(ctxAfter([], 'w', { specs: E1 }));
  const e4 = judged([], 'e4', 'e4', { before: 28, after: 28 });
  const reaction = reactionVerdict({ judgement: e4, advice: first.ev.teach?.advice ?? [] });
  const ctx = ctxAfter(['e4', 'e5'], 'w', { specs: E2, memory: first.plan.memory, reaction });
  const { plan, ev } = turn(ctx);

  it('the child followed the advice', () => {
    expect(reaction.kind).toBe('followed');
    expect(reaction.followed).toBe('primary');
    expect(reaction.speakNow).toBe(false);
  });

  it('primary Кf3 with develop + attack on e5, «выводит коня и нападает на пешку на е пять»', () => {
    const primary = plan.advice[0];
    expect(primary?.san).toBe('Nf3');
    expect(primary?.ideas.map((i) => i.id).sort()).toEqual(['attack', 'develop']);
    expect(primary?.ideas.find((i) => i.id === 'attack')?.squares).toContain('e5');
    // the bubble keeps both ideas; the brief gives the voice ONE reason — this turn explained by its topic
    expect(ev.text).toContain('выводишь коня и нападаешь на пешку на е пять');
    // (a topic turn: the topic is the reason — «одной фразой … объясни его новой темой»)
    expect(briefLine(ev.brief, 'Факты')).toBe('Факты: Конь на эф три (зелёная стрелка). Новая тема «разбуди фигуры»: каждым ходом — новая фигура в игру.');
    expect(ev.teach?.moment).toBe('turn');
    expect(plan.extra).toBe('topic');
    expect(plan.style).toBe('concept');
    expect(briefLine(ev.brief, 'Цель')).toMatch(/новой темой «разбуди фигуры»/);
    checkFormat(ev);
  });

  it('the alternative is Кc3 or Сc4', () => {
    expect(['Nc3', 'Bc4']).toContain(plan.advice[1]?.san);
    expect(ev.board?.arrows.map((a) => a.color)).toEqual(['green', 'blue']);
  });

  it('the repertoire plan names the bishop to c4 and castling', () => {
    const op = openingPlanFacts({ fen: ctx.fen, childColor: 'w', stage: 1, repertoire: ctx.repertoire });
    expect(op.source).toBe('repertoire');
    expect(op.factsRu.join(' ')).toContain('слон на цэ четыре');
    expect(op.factsRu.join(' ')).toMatch(/рокировка/);
    expect(op.factsRu.join(' ')).toMatch(/если соперник не помешает/);
    expect(op.textRu).not.toMatch(LATIN);
  });

  it('the opponent\'s move is understood (centre pawn) but not narrated: a plain centre pawn is no news', () => {
    expect(plan.opponent?.ideas[0]?.id).toBe('centerPawn');
    expect(briefLine(ev.brief, 'Момент')).not.toContain('Ход соперника');
    expect(claims(ev.brief)).not.toContain('соперник ставит пешку в центр');
    expect(briefLine(ev.brief, 'Нельзя')).toMatch(/ничего не добавляй от себя: ни хода соперника/);
  });
});

// ───────────────────────── T3 / T4 ─────────────────────────

describe('T3 / T4 — Black, stage 2, 10 minutes: 1.e4 e5 2.Фh5 Кc6 3.Сc4', () => {
  const stage2 = profile({ stage: 2 });
  const t0 = turn(ctxAfter(['e4'], 'b', { specs: B1, profile: stage2, timed: true }));
  const e5 = judged(['e4'], 'e5', 'e5', { before: -25, after: -25 });
  const r1 = reactionVerdict({ judgement: e5, advice: t0.ev.teach?.advice ?? [] });
  const t3ctx = ctxAfter(['e4', 'e5', 'Qh5'], 'b', { specs: E3, profile: stage2, timed: true, memory: t0.plan.memory, reaction: r1 });
  const t3 = turn(t3ctx);
  const nc6 = judged(['e4', 'e5', 'Qh5'], 'Nc6', 'Nc6', { before: 30, after: 30 });
  const r2 = reactionVerdict({ judgement: nc6, advice: t3.ev.teach?.advice ?? [] });
  const t4ctx = ctxAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4'], 'b', { specs: E4, profile: stage2, timed: true, memory: t3.plan.memory, reaction: r2 });
  const t4 = turn(t4ctx);

  it('the first Black turn is the opening plan with e5 advised', () => {
    expect(t0.ev.teach?.moment).toBe('openingPlan');
    expect(t0.ev.teach?.ply).toBe(2);
    expect(t0.plan.advice[0]?.san).toBe('e5');
    checkFormat(t0.ev);
  });

  it('T3 (1): the queen attacks e5 and the brief says the queen came out early (the rule)', () => {
    expect(t3.plan.opponent?.ideas[0]?.id).toBe('attack');
    expect(t3.plan.opponent?.ideas[0]?.squares).toContain('e5');
    expect(t3.plan.opponent?.earlyQueen).toBe(true);
    expect(claims(t3.ev.brief)).toMatch(/соперник рано вывел ферзя/);
  });

  it('T3 (2): one extra a turn — the early queen is the news of T3, so the name «Ранний выход ферзя» waits (T4 is a danger)', () => {
    expect(t3.plan.extra).toBe('opponent');
    expect(t3.plan.openingName).toBeNull();
    expect(t3.ev.brief).not.toContain('Ранний выход ферзя');
    expect(briefLine(t3.ev.brief, 'Момент')).toContain('Ход соперника: ферзь на аш пять');
    expect(t4.plan.openingName).toBeNull();
    expect(t4.ev.brief).not.toContain('Ранний выход ферзя');
  });

  it('T3 (3)–(4): primary Кc6 from the repertoire; the alternative is d6, never the early queen Фe7 (kid filter)', () => {
    expect(t3.plan.advice[0]).toMatchObject({ san: 'Nc6', source: 'repertoire', arrow: 'green' });
    expect(t3.plan.advice[0]?.ideas.map((i) => i.id)).toContain('develop');
    expect(t3.plan.advice[1]?.san).toBe('d6');
    const all = pickAdvice({ ...t3ctx, memory: t3ctx.memory });
    expect(all.map((a) => a.san)).not.toContain('Qe7');
    checkFormat(t3.ev);
  });

  it('T3 (5): the clock stands — the event pauses it, and the brief never mentions the clock', () => {
    expect(t3.ev.pauseClock).toBe(true);
    expect(t3.ev.brief ?? '').not.toMatch(/часы|минут|секунд|время/i);
    expect(t3.ev.text).not.toMatch(/часы|минут|секунд|время/i);
  });

  it('T4 (1): the mate threat Фxf7# — red highlight f7, red arrow h5→f7', () => {
    expect(t4.plan.danger?.kind).toBe('mate');
    expect(t4.ev.board?.highlights).toContainEqual({ square: 'f7', color: 'red' });
    expect(t4.ev.board?.arrows).toContainEqual({ from: 'h5', to: 'f7', color: 'red' });
    expect(briefLine(t4.ev.brief, 'Можно назвать')).toContain('ферзь бьёт на эф семь, мат (ход соперника, только как угрозу)');
  });

  it('T4 (2): g6 green (closes the mate, attacks the queen), Фe7 blue (closes the mate); never Фf6 (−39)', () => {
    expect(t4.plan.advice.map((a) => [a.san, a.arrow])).toEqual([
      ['g6', 'green'],
      ['Qe7', 'blue'],
    ]);
    expect(t4.plan.advice[0]?.allIdeas.map((i) => i.id)).toEqual(expect.arrayContaining(['defendMate', 'attack']));
    expect(t4.plan.advice[1]?.allIdeas.map((i) => i.id)).toContain('defendMate');
    expect(t4.plan.advice.map((a) => a.san)).not.toContain('Qf6');
  });

  it('T4 (3)–(4): the new topic «детский мат», concept style, ≤ 1100 characters, priority 2 (never filtered as chatter)', () => {
    expect(t4.ev.teach?.conceptId).toBe('scholars-mate');
    expect(t4.ev.teach?.style).toBe('concept');
    expect((t4.ev.brief ?? '').length).toBeLessThanOrEqual(1100);
    expect(t4.ev.priority).toBe(2);
    expect(briefLine(t4.ev.brief, 'Цель')).toMatch(/назови опасность — это «детский мат»/);
    expect(t4.plan.extra).toBe('danger');
    expect(claims(t4.ev.brief)).toMatch(/соперник грозит матом: ферзь бьёт на эф семь, мат/);
    // the spare defence is the blue arrow on the board; in the words only on a choice turn (short)
    expect(t4.plan.choice).toBe(false);
    expect(claims(t4.ev.brief)).not.toMatch(/ферзь на е семь/);
    expect(t4.ev.board?.arrows.some((a) => a.color === 'blue')).toBe(true);
    expect(claims(t4.ev.brief)).toMatch(/защищает только король/);
    checkFormat(t4.ev);
    // even «Тихо» keeps the full danger turn (the controller lets every teachTurn through)
    const quiet = turn({ ...t4ctx, talkativeness: 'quiet' });
    expect(quiet.ev.priority).toBe(2);
    expect(quiet.ev.teach?.style).toBe('full');
    expect(quiet.ev.teach?.conceptId).toBeUndefined();
  });
});

// ───────────────────────── T5 ─────────────────────────

describe('T5 — White, stage 1: advice Сc4 + d4 (E5), the child plays 3.Кg5?? (E6)', () => {
  const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
  const ctx = ctxAfter(sans, 'w', { specs: E5, memory: { ...initialTeachMemory(), turns: 2 } });
  const { plan, ev } = turn(ctx);
  const j = judged(sans, 'Ng5', 'd4', { before: 33, after: -611, refutation: ['Qxg5'], loss: 3, motif: 'hangingPiece' });
  const decision = decideIntervention(j, { coachMode: 'full', stage: 1, offersMade: 0, remainingMs: null, examMode: false, pliesSinceLastOffer: 99 });
  const offer = buildTakebackOffer(j, profile({ stage: 1 }), constRng(0), { advice: ev.teach?.advice ?? [] });

  it('the advice before the move: Сc4 green (repertoire), d4 blue (main line)', () => {
    expect(ev.teach?.advice).toEqual([
      { uci: 'f1c4', san: 'Bc4', source: 'repertoire', arrow: 'green' },
      { uci: 'd2d4', san: 'd4', source: 'mainLine', arrow: 'blue' },
    ]);
    checkFormat(ev);
  });

  it('(1) the policy offers a take-back; the offer carries the earlier advice', () => {
    expect(decision.action).toBe('offerTakeback');
    expect(reactionVerdict({ judgement: j, advice: ev.teach?.advice ?? [], decision }).kind).toBe('takeback');
    expect(offer.kind).toBe('takebackOffer');
    expect(offer.priority).toBe(2);
    expect(offer.pauseClock).toBe(true);
    expect(offer.teach?.advice.map((a) => a.san)).toEqual(['Bc4', 'd4']);
  });

  it('(2) a concrete brief: the queen takes on g5, the knight is lost, the advice is reminded; nothing else nameable', () => {
    const brief = offer.brief ?? '';
    expect(brief).toContain('ферзь бьёт на же пять');
    expect(brief).toContain('коня');
    expect(brief).toContain('слон на цэ четыре');
    expect(brief).toMatch(/никто не защищает/);
    expect(briefLine(brief, 'Можно назвать')).toBe('Можно назвать: слон на цэ четыре; пешка на дэ четыре; ферзь бьёт на же пять (ход соперника).');
    expect(brief).not.toMatch(LATIN);
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(offer.text).not.toMatch(LATIN);
    expect(countWords(offer.text)).toBeLessThanOrEqual(25);
    expect(countSentences(offer.text)).toBeLessThanOrEqual(2);
    expect(offer.text).not.toMatch(/зевок|ошибк|плох/i);
  });

  it('(3) after «Верну ход»: the arrows of the advice again and a short repeat turn', () => {
    const repeat = buildTeachRepeat(plan, constRng(0));
    expect(repeat.kind).toBe('teachTurn');
    expect(repeat.teach?.moment).toBe('repeat');
    expect(repeat.teach?.style).toBe('short');
    expect(repeat.board?.arrows).toEqual([
      { from: 'f1', to: 'c4', color: 'green' },
      { from: 'd2', to: 'd4', color: 'blue' },
    ]);
    expect(repeat.priority).toBe(2);
    expect(briefLine(repeat.brief, 'Можно назвать')).toBe('Можно назвать: слон на цэ четыре (зелёная стрелка); пешка на дэ четыре (синяя стрелка).');
    checkFormat(repeat);
  });

  it('the helper variant of the offer is unchanged: no teach summary, no advice named', () => {
    const helper = buildTakebackOffer(j, profile({ stage: 1 }), constRng(0));
    expect(helper.teach).toBeUndefined();
    expect(helper.brief).not.toContain('Можно назвать');
    expect(helper.brief).not.toContain('пешка на дэ четыре');
  });
});

// ───────────────────────── T6 ─────────────────────────

describe('T6 — White, stage 1: 1.e4 Кc6 2.d4 Кxd4 — the bot gave the knight away (E7)', () => {
  const sans = ['e4', 'Nc6', 'd4', 'Nxd4'];
  const ctx = ctxAfter(sans, 'w', { specs: E7, memory: { ...initialTeachMemory(), turns: 2 } });
  const { plan, ev } = turn(ctx);

  it('(1) a treasure: reveal later, blue d1, yellow d4, no arrow; the brief names the gift, not the move', () => {
    expect(ev.teach?.reveal).toBe('later');
    expect(ev.teach?.advice).toEqual([]);
    expect(ev.board?.arrows ?? []).toEqual([]);
    expect(ev.board?.highlights).toEqual([
      { square: 'd1', color: 'blue' },
      { square: 'd4', color: 'yellow' },
    ]);
    const brief = claims(ev.brief);
    expect(brief).toContain('конь соперника на дэ четыре стоит без защиты');
    expect(brief).not.toContain('ферзь бьёт на дэ четыре');
    expect(plan.advice).toHaveLength(1);
    checkFormat(ev);
  });

  it('(2) the reveal after 10 s on stage 1: a green arrow d1→d4', () => {
    expect(treasureRevealMs(1)).toBe(10_000);
    expect(treasureRevealMs(3)).toBe(15_000);
    const reveal = buildTeachReveal(plan, constRng(0));
    expect(reveal.teach?.moment).toBe('reveal');
    expect(reveal.board?.arrows).toEqual([{ from: 'd1', to: 'd4', color: 'green' }]);
    expect(reveal.brief).toContain('ферзь бьёт на дэ четыре');
    checkFormat(reveal);
    // «Совет» before the reveal reveals it
    expect(buildTeachRepeat(plan, constRng(0)).teach?.moment).toBe('reveal');
    expect(buildTeachRepeat(plan, constRng(0), { revealed: true }).teach?.moment).toBe('repeat');
  });

  it('(3) found alone before the reveal → praise (tactic), not «followed»', () => {
    const j = judged(sans, 'Qxd4', 'Qxd4', { before: 553, after: 553 });
    expect(plan.memory.advice.map((a) => a.san)).toEqual(['Qxd4']); // the hidden move is remembered, not drawn
    const v = reactionVerdict({ judgement: j, advice: plan.memory.advice, treasureHidden: true });
    expect(v.kind).toBe('tactic');
    expect(v.foundMotif).toBe('freeCapture');
    expect(buildTeachReaction(v, { profile: profile({ stage: 1 }) }, constRng(0))).toBeNull();
  });
});

// ───────────────────────── T7 ─────────────────────────

describe('T7 — White: 3…h6 — the bot left the repertoire (E8)', () => {
  const memory: TeachMemory = { ...initialTeachMemory(), turns: 3, repertoireInBook: true, repertoireNextSan: 'Bc4', lastPlanKey: 'rep:italian-quiet', lastPlanPly: 1 };
  const ctx = ctxAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6'], 'w', { specs: E8, memory });
  const { plan, ev } = turn(ctx);

  it('(1) the brief says the opponent did not play our plan', () => {
    expect(claims(ev.brief)).toMatch(/соперник сыграл не так, как в нашем плане/);
    expect(ctx.repertoire?.inBook).toBe(false);
  });

  it('(2)–(3) advice only from d4 / 0-0 / c3 within 30 cp, no repertoire source, no popularity words', () => {
    const sans = plan.advice.map((a) => a.san);
    expect(sans.length).toBeGreaterThan(0);
    for (const san of sans) expect(['d4', 'O-O', 'c3']).toContain(san);
    for (const a of plan.advice) expect(65 - a.scoreCp).toBeLessThanOrEqual(TEACH_TOLERANCE_CP);
    expect(plan.advice.some((a) => a.source === 'repertoire')).toBe(false);
    expect(claims(ev.brief)).not.toMatch(/так обычно играют|часто|популярн/);
  });

  it('(4) the rule «центр, фигуры, рокировка» is in the facts', () => {
    expect(briefLine(ev.brief, 'Факты')).toMatch(/центр, фигуры, рокировка/);
    checkFormat(ev);
  });
});

// ───────────────────────── T8 ─────────────────────────

describe('T8 — a calm middlegame (E9): the short style', () => {
  const quietMemory: TeachMemory = { ...initialTeachMemory(), turns: 9, calmStreak: 2, lastPlanKey: 'improveWorstPiece', lastPlanPly: 17, lastShape: 'adviceFirst', lastApprovalPly: 19 };
  const prev = judged([], 'e4', 'e4', { before: 20, after: 20 });
  const followed: ReactionVerdict = { ...reactionVerdict({ judgement: prev, advice: [{ uci: 'e2e4', san: 'e4', source: 'engine', arrow: 'green' }] }) };
  const base = (memory: TeachMemory, ply: number): TeachContext => ({
    fen: E9_FEN,
    ply,
    childColor: 'w',
    profile: profile({ stage: 3 }),
    analysis: scripted(E9_FEN, E9),
    lastBotMove: { uci: 'a8e8', san: 'Re8', fenBefore: 'r1bq1rk1/bpp2pp1/p1np1n1p/4p3/2B1P3/2PP1NN1/PP3PPP/R1BQR1K1 b - - 1 10' },
    memory,
    reaction: followed,
    conceptCard: getConceptCard,
    openingNameRu: (f) => lookupOpening(f)?.nameRu,
  });

  it('(1)–(3) after two calm turns: short, exactly one green advice, ≤ 15 words in one sentence, no opponent facts', () => {
    expect(followed.kind).toBe('followed');
    const { plan, ev } = turn(base(quietMemory, 21), constRng(0.9));
    expect(plan.style).toBe('short');
    expect(ev.teach?.style).toBe('short');
    expect(ev.teach?.advice).toEqual([{ uci: 'b2b4', san: 'b4', source: 'engine', arrow: 'green' }]);
    expect(ev.board?.arrows).toEqual([{ from: 'b2', to: 'b4', color: 'green' }]);
    expect(countWords(ev.text)).toBeLessThanOrEqual(15);
    expect(countSentences(ev.text)).toBe(1);
    expect(briefLine(ev.brief, 'Факты')).not.toMatch(/соперник/);
    expect(briefLine(ev.brief, 'Цель')).toMatch(/Одно короткое предложение/);
    checkFormat(ev);
  });

  it('(4) three calm turns in a row with a random rng: at least one short (100 runs)', () => {
    // the real explainer is slow-ish (~8 ms a move); calm-ness only needs «no A/B idea», so a quiet fake is used here
    const quietIdeas: MoveIdeasApi = {
      explainMove: () => [{ id: 'quiet', group: 'F', squares: [], phraseRu: 'спокойный крепкий ход', phraseYouRu: 'спокойный крепкий ход' }],
      pickIdeas: (ideas) => ideas.slice(0, 1),
      explainOpponentMove: () => ({ ideas: [], wants: null }),
    };
    let shorts = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const rng = seededRng(seed);
      let memory: TeachMemory = { ...quietMemory, calmStreak: 0 };
      const styles: string[] = [];
      for (let k = 0; k < 3; k++) {
        const plan = planTeachTurn({ ...base(memory, 21 + 2 * k), ideas: quietIdeas }, rng);
        styles.push(plan.style);
        memory = plan.memory;
      }
      expect(styles, `seed ${seed}`).toContain('short');
      shorts += styles.filter((x) => x === 'short').length;
    }
    // not every calm turn is short (variety): the coin decides the first two
    expect(shorts).toBeGreaterThan(100);
    expect(shorts).toBeLessThan(300);
  });

  it('chatty keeps the full style in calm positions; quiet is always short', () => {
    expect(planTeachTurn({ ...base(quietMemory, 21), talkativeness: 'chatty' }, constRng(0)).style).toBe('full');
    expect(planTeachTurn({ ...base({ ...quietMemory, calmStreak: 0 }, 21), talkativeness: 'quiet' }, constRng(0.9)).style).toBe('short');
  });
});

// ───────────────────────── T9 ─────────────────────────

describe('T9 — endgame (E10): the king goes forward', () => {
  const ctx: TeachContext = { fen: E10_FEN, ply: 61, childColor: 'w', profile: profile({ stage: 2 }), analysis: scripted(E10_FEN, E10), memory: { ...initialTeachMemory(), turns: 20 } };
  const { plan, ev } = turn(ctx);

  it('(1) advice among Крd4 / Крe4 / Крf4 with the idea kingActivity; (3) no pawn move', () => {
    expect(plan.advice.length).toBeGreaterThan(0);
    for (const a of plan.advice) expect(['Kd4', 'Ke4', 'Kf4']).toContain(a.san);
    expect(plan.advice[0]?.ideas[0]?.id).toBe('kingActivity');
    expect(plan.advice.some((a) => a.san.startsWith('e'))).toBe(false);
    checkFormat(ev);
  });

  it('(2) the plan kingToCenter', () => {
    const facts = computePositionFacts(E10_FEN);
    expect(facts.phase).toBe('endgame');
    expect(middlegamePlan(facts, E10_FEN, 'w')?.id).toBe('kingToCenter');
    expect(plan.plan?.key).toBe('kingToCenter');
    expect(ev.brief).toMatch(/король — боец/);
  });
});

// ───────────────────────── T10 ─────────────────────────

describe('T10 — «а почему не ферзём?» after 1.e4 e5 (advice Кf3 / Кc3, E11)', () => {
  const sans = ['e4', 'e5'];
  const fen = fenOf(sans);
  const j = judged(sans, 'Qh5', 'Nf3', { before: 19, after: -24, refutation: ['Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6'] });
  const answer = buildCompareMoveAnswerRu({
    fen,
    query: { piece: 'q' },
    move: { uci: 'd1h5', san: 'Qh5' },
    judgement: j,
    moveScoreCp: -24,
    advice: [
      { uci: 'g1f3', san: 'Nf3', source: 'mainLine', arrow: 'green', scoreCp: 19 },
      { uci: 'b1c3', san: 'Nc3', source: 'book', arrow: 'blue', scoreCp: 8 },
    ],
    profile: profile(),
    phase: 'opening',
    conceptCard: getConceptCard,
  });

  it('(3) facts: the queen move, «немного слабее», the chase by the g6 pawn, the rule of the card', () => {
    expect(answer).toContain('ферзь на аш пять');
    expect(answer).toContain('немного слабее');
    expect(answer).toContain('пешка на же шесть нападает на ферзя');
    expect(answer).toContain('соперник тем временем выводит фигуры');
    expect(answer).toContain('Ферзь — самая дорогая фигура.');
  });

  it('(4) every move named is from the E11 line or the advice; no Latin', () => {
    expect(answer).not.toMatch(LATIN);
    const allowed = ['ферзь на аш пять', 'конь на эф три', 'конь на цэ три', 'конь на цэ шесть', 'слон на цэ четыре', 'пешка на же шесть', 'ферзь на эф три'];
    const named = [...answer.matchAll(/(пешка|конь|слон|ладья|ферзь|король)( бьёт)? на (а|бэ|цэ|дэ|е|эф|же|аш) (один|два|три|четыре|пять|шесть|семь|восемь)/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(3);
    for (const n of named) expect(allowed, n).toContain(n);
  });

  it('the queen chase is counted on the real E11 line', () => {
    const c = queenChase(j.fenAfter, j.refutationPvUci);
    expect(c.count).toBe(1);
    expect(c.chasersRu).toEqual(['пешка на же шесть']);
  });

  it('gaps: ≤ 30 same, a lost piece → what is lost; no piece move → «ходить некуда»', () => {
    const same = buildCompareMoveAnswerRu({ fen, query: { move: 'конь на цэ три' }, move: { uci: 'b1c3', san: 'Nc3' }, judgement: null, moveScoreCp: 8, advice: [{ uci: 'g1f3', san: 'Nf3', source: 'mainLine', arrow: 'green', scoreCp: 19 }] });
    expect(same).toContain('примерно так же хорошо');
    const none = buildCompareMoveAnswerRu({ fen: START, query: { piece: 'r' }, move: null, judgement: null, advice: [] });
    expect(none).toContain('Сейчас ладьёй ходить некуда');
    const ng5 = judged(['e4', 'e5', 'Nf3', 'Nc6'], 'Ng5', 'd4', { before: 33, after: -611, refutation: ['Qxg5'], loss: 3 });
    const lost = buildCompareMoveAnswerRu({ fen: ng5.fenBefore, query: { move: 'конь на же пять' }, move: { uci: ng5.uci, san: ng5.san }, judgement: ng5, advice: [{ uci: 'f1c4', san: 'Bc4', source: 'repertoire', arrow: 'green', scoreCp: 20 }] });
    expect(lost).toContain('соперник забирает коня');
    expect(lost).toContain('три пешки');
    for (const t of [same, none, lost]) expect(t).not.toMatch(LATIN);
  });

  it('the helper mode (no advice): no comparison with an advice, but the chase and the rule still come', () => {
    const helper = buildCompareMoveAnswerRu({ fen, query: { piece: 'q' }, move: { uci: 'd1h5', san: 'Qh5' }, judgement: j, advice: [], phase: 'opening', conceptCard: getConceptCard });
    expect(helper).not.toMatch(/совет/);
    expect(helper).toMatch(/Ход безопасный/);
    expect(helper).toContain('пешка на же шесть нападает на ферзя');
    expect(helper).toContain('Ферзь — самая дорогая фигура.');
    expect(helper).not.toMatch(LATIN);
  });
});

// ───────────────────────── §2.4 details ─────────────────────────

describe('pickAdvice — §2.4 rules', () => {
  it('a real win is never hidden behind a «proper» move', () => {
    const ctx = ctxAfter(['e4', 'Nc6', 'd4', 'Nxd4'], 'w', { specs: [['Qxd4', 553], ['Be3', 540], ['Nf3', 535]], profile: profile({ stage: 5 }) });
    const advice = pickAdvice(ctx);
    expect(advice[0]?.san).toBe('Qxd4');
    // stage 5 (the lesson model §2.7, TREASURE_MAX_STAGE = 5): the gift is a task on stage 5 too — no arrow yet, the move kept
    const { ev, plan } = turn({ ...ctx, memory: { ...initialTeachMemory(), turns: 2 } });
    expect(ev.teach?.reveal).toBe('later');
    expect(ev.board?.arrows ?? []).toEqual([]);
    expect(plan.memory.advice[0]).toMatchObject({ uci: 'd1d4', san: 'Qxd4' });
  });

  it('only mates of the same length when the first line mates within three', () => {
    const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const ctx: TeachContext = { fen, ply: 7, childColor: 'w', profile: profile({ stage: 5 }), analysis: scripted(fen, [['Qxf7#', { mate: 1 }], ['Qxe5+', 400], ['d3', 50]]) };
    const advice = pickAdvice(ctx);
    expect(advice.map((a) => a.san)).toEqual(['Qxf7#']);
    expect(advice[0]?.allIdeas[0]?.id).toBe('mate');
  });

  it('a shallow analysis gives one advice with a 20 cp tolerance; no engine gives only curated moves in the first ten moves', () => {
    const fen = fenOf(['e4', 'e5']);
    const partial: TeachContext = { ...ctxAfter(['e4', 'e5'], 'w'), analysis: scripted(fen, E2, 10) };
    expect(teachModeOf(partial.analysis)).toBe('partial');
    expect(pickAdvice(partial).map((a) => a.san)).toEqual(['Nf3']);
    const none = ctxAfter(['e4', 'e5'], 'w', { analysis: null });
    expect(teachModeOf(null)).toBe('rules');
    const curated = pickAdvice(none);
    expect(curated.map((a) => a.san)).toEqual(['Nf3']);
    expect(curated[0]?.verifiedBy).toBe('curated');
    const { ev } = turn({ ...none, memory: { ...initialTeachMemory(), turns: 1 } });
    expect(claims(ev.brief)).toMatch(/точной проверки ходов сейчас нет/);
    checkFormat(ev);
    // beyond the tenth move without an engine: no move, only the rule — never an empty reply
    const late = turn({ fen: E9_FEN, ply: 21, childColor: 'w', profile: profile(), analysis: null, memory: { ...initialTeachMemory(), turns: 9 } });
    expect(late.plan.advice).toEqual([]);
    expect(late.ev.brief).toMatch(/шахи, взятия и угрозы/);
    checkFormat(late.ev);
  });

  it('book moves outside the MultiPV lines are verified by searchmoves (≤ 2) and then accepted by the same tolerance', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
    const fen = fenOf(sans);
    const ctx = ctxAfter(sans, 'w', { specs: [['d4', 33], ['Nc3', 30], ['Bb5', 32]] });
    const verify = bookMovesToVerify(ctx);
    expect(verify).toEqual(['f1c4']);
    const verified = [line(fen, ['Bc4', 20], 1, 14)];
    const advice = pickAdvice({ ...ctx, verified });
    expect(advice[0]).toMatchObject({ san: 'Bc4', verifiedBy: 'searchmoves', source: 'repertoire' });
    // a verified move that is too weak is not advised
    const weak = pickAdvice({ ...ctx, verified: [line(fen, ['Bc4', -10], 1, 14)] });
    expect(weak.map((a) => a.san)).not.toContain('Bc4');
    expect(bookMovesToVerify({ ...ctx, ply: 41, facts: computePositionFacts(E9_FEN) })).toEqual([]);
  });

  it('the honest source: book name, engine; never a popularity claim without a table', () => {
    const ctx = ctxAfter(['e4', 'e5'], 'w', { specs: E2, repertoire: null, mainLineSans: [] });
    const advice = pickAdvice(ctx);
    expect(advice[0]).toMatchObject({ san: 'Nf3', source: 'engine' }); // «Дебют королевского коня» is too general a name
    const alt = advice[1];
    expect(alt?.source).toBe('book');
    expect(alt?.openingNameRu).toMatch(/Венская партия|Дебют слона/);
    // a choice turn (the fourth turn after the last choice) names the blue arrow — without its source or a reason: the
    // brief carries no «how common» / «проверен» words at all (nothing extra)
    // (the plan of the principles was told before and a topic was told a ply ago: a new plan or a new topic would be the
    // one extra of the turn, and no choice then)
    const planKey = openingPlanFacts({ fen: ctx.fen, childColor: 'w', stage: 1, repertoire: null }).key;
    // (the last turn led with the opponent's move: this one does not — the choice stands alone)
    const { ev, plan } = turn({ ...ctx, memory: { ...initialTeachMemory(), turns: 5, lastChoiceTurn: 1, lastPlanKey: planKey, lastPlanPly: 1, lastConceptPly: 2, openers: ['opp'] } });
    expect(plan.choice).toBe(true);
    expect(plan.extra).toBeNull();
    expect(briefLine(ev.brief, 'Факты')).toMatch(/\(синяя стрелка\)\.$/);
    expect(claims(ev.brief)).not.toMatch(/известный ход|есть имя|ход проверен|часто|популярн/);
    expect(briefLine(ev.brief, 'Цель')).toMatch(/вторая и последняя фраза — синяя стрелка и вопрос вместе/);
  });
});

// ───────────────────────── §2.5 reactions ─────────────────────────

describe('reactions (§2.5)', () => {
  const advice = [
    { uci: 'g1f3', san: 'Nf3', source: 'mainLine' as const, arrow: 'green' as const },
    { uci: 'b1c3', san: 'Nc3', source: 'book' as const, arrow: 'blue' as const },
  ];

  it('followed / own good / fine / weaker by the win% loss', () => {
    expect(reactionVerdict({ judgement: judged(['e4', 'e5'], 'Nc3', 'Nf3', { before: 19, after: 8 }), advice }).followed).toBe('alternative');
    const own = reactionVerdict({ judgement: judged(['e4', 'e5'], 'd4', 'Nf3', { before: 19, after: 15 }), advice });
    expect(own.kind).toBe('ownGood');
    expect(own.speakNow).toBe(false);
    const fine = reactionVerdict({ judgement: judged(['e4', 'e5'], 'd3', 'Nf3', { before: 19, after: -5 }), advice });
    expect(fine.kind).toBe('fine');
    const weaker = reactionVerdict({ judgement: judged(['e4', 'e5'], 'f3', 'Nf3', { before: 19, after: -90, refutation: ['Nf6'] }), advice });
    expect(weaker.kind).toBe('weaker');
    expect(weaker.speakNow).toBe(true);
  });

  it('an own good move is praised in the next turn — for being your own', () => {
    const own = reactionVerdict({ judgement: judged(['e4', 'e5'], 'd4', 'Nf3', { before: 19, after: 15 }), advice });
    const ctx = ctxAfter(['e4', 'e5', 'd4', 'exd4'], 'w', { specs: [['Qxd4', 20], ['Nf3', 15], ['c3', 10]], reaction: own, memory: { ...initialTeachMemory(), turns: 2 } });
    const { ev } = turn(ctx);
    expect(briefLine(ev.brief, 'Факты')).toMatch(/Ученик выбрал свой ход — пешка на дэ четыре, и он тоже хороший/);
  });

  it('weaker → a separate teachReaction with honest engine facts, no shame', () => {
    const j = judged(['e4', 'e5'], 'f3', 'Nf3', { before: 19, after: -90, refutation: ['Nf6'] });
    const v = reactionVerdict({ judgement: j, advice });
    const ev = buildTeachReaction(v, { profile: profile() }, constRng(0));
    expect(ev?.kind).toBe('teachReaction');
    expect(ev?.priority).toBe(1);
    expect(ev?.pauseClock).toBe(true);
    expect(ev?.teach?.moment).toBe('reaction');
    expect(ev?.brief).toMatch(/слабее/);
    expect(claims(ev?.brief)).not.toMatch(/зевок|ошибка/);
    expect(briefLine(ev?.brief, 'Можно назвать')).toMatch(/^Можно назвать: конь на эф три; конь на цэ три/);
    checkFormat(ev as CoachEvent);
  });

  it('an early queen of the child: a separate reaction — the feeling first, then the rule and the chase from the line', () => {
    const j = judged(['e4', 'e5'], 'Qh5', 'Nf3', { before: 19, after: -24, refutation: ['Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6'] });
    const v = reactionVerdict({ judgement: j, advice });
    expect(v.kind).toBe('fine');
    expect(v.earlyQueen).toBe(true);
    expect(v.speakNow).toBe(true);
    const ev = buildTeachReaction(v, { profile: profile(), conceptCard: getConceptCard }, constRng(0)) as CoachEvent;
    expect(ev.brief).toMatch(/ферзь сильный — понятно, почему им хочется ходить/i);
    expect(ev.brief).toContain('пешка на же шесть нападает на ферзя');
    expect(ev.text).toMatch(/Ферз/);
    checkFormat(ev);
  });
});

// ───────────────────────── T12: format over scripted games ─────────────────────────

/** A scripted game: the child follows a model line; every child position gets three engine lines around the model move. */
function scriptedGame(movesSan: readonly string[], childColor: Color, p: StudentProfile, rng: () => number, plans: TeachPlan[] = []): CoachEvent[] {
  const events: CoachEvent[] = [];
  let memory: TeachMemory | null = null;
  let reaction: ReactionVerdict | null = null;
  const chess = new Chess();
  for (let i = 0; i < movesSan.length; i++) {
    const san = movesSan[i] as string;
    const sans = movesSan.slice(0, i);
    if (chess.turn() === childColor) {
      const fen = chess.fen();
      const others = chess
        .moves({ verbose: true })
        .filter((m) => m.san !== san && !m.san.startsWith('K') && !/[a-h]x/.test(m.san))
        .slice(0, 2)
        .map((m) => m.san);
      const specs: LineSpec[] = [[san, 25], ...others.map((o, k) => [o, 15 - 10 * k] as LineSpec)];
      const ctx: TeachContext = { ...ctxAfter(sans, childColor, { specs, profile: p, memory, reaction, timed: true }) };
      const plan = planTeachTurn(ctx, rng);
      const ev = buildTeachTurn(plan, rng);
      events.push(ev);
      plans.push(plan);
      for (const a of plan.advice) expect(25 - a.scoreCp, `${san}: ${a.san}`).toBeLessThanOrEqual(TEACH_TOLERANCE_CP);
      expect(ev.teach?.ply).toBe(sans.length + 1);
      memory = plan.memory;
      const j = judged(sans, san, san, { before: 25, after: 25 });
      reaction = reactionVerdict({ judgement: j, advice: ev.teach?.advice ?? [] });
    }
    chess.move(san);
  }
  return events;
}

const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6', 'Nbd2', 'Ba7', 'Nf1', 'h6', 'Ng3', 'Re8', 'h3', 'Be6'];
const BLACK_LINE = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3', 'Bb7', 'd4', 'Re8', 'Nbd2', 'Bf8'];

describe('T12 — format of every teacher utterance over scripted games', () => {
  const games: { name: string; events: CoachEvent[] }[] = [];
  for (const [name, moves, color] of [
    ['italian (white)', ITALIAN, 'w'],
    ['spanish (black)', BLACK_LINE, 'b'],
  ] as const) {
    for (const p of [profile({ stage: 1 }), profile({ stage: 3, address: 'f', nickname: 'Маша' }), profile({ stage: 5 })]) {
      for (const seed of [1, 2]) games.push({ name: `${name} s${p.stage} #${seed}`, events: scriptedGame(moves, color, p, seededRng(seed)) });
    }
  }

  it('produces ~11 teacher turns per game', () => {
    for (const g of games) expect(g.events.length, g.name).toBeGreaterThanOrEqual(10);
  });

  it('(2)–(4), (7): Latin-free, within the budgets, «Можно назвать / Цель / Нельзя», ≤ 2 child moves, no «лучший ход», no numbers', () => {
    for (const g of games) for (const ev of g.events) checkFormat(ev);
  });

  it('the feminine address stays feminine in briefs and texts', () => {
    for (const g of games.filter((x) => x.name.includes('s3'))) {
      for (const ev of g.events) {
        expect(ev.brief ?? '', ev.brief).not.toMatch(/(?<![а-яё])ученик(?:а|у|ом)?(?![а-яё])/);
        expect(ev.text, ev.text).not.toMatch(/(?<![а-яё])(выбрал|свернул|сам)(?![а-яё])/);
      }
    }
  });

  it('the build follows the one extra of the turn; short and full both occur', () => {
    const all = games.flatMap((g) => g.events);
    expect(all.some((e) => e.teach?.style === 'short')).toBe(true);
    expect(all.some((e) => e.teach?.style === 'full')).toBe(true);
    expect(all.filter((e) => e.teach?.moment === 'openingPlan').length).toBe(games.length);
    for (const [name, moves, color] of [
      ['italian', ITALIAN, 'w'],
      ['spanish', BLACK_LINE, 'b'],
    ] as const) {
      const plans: TeachPlan[] = [];
      scriptedGame(moves, color, profile({ stage: 2 }), seededRng(5), plans);
      for (const [i, p] of plans.entries()) {
        // (a short turn may lead with the opponent's move too — «Соперник … — отвечаем …»)
        const want = p.style === 'short' && p.extra !== 'opponent' ? 'adviceFirst' : p.danger && !p.treasure ? 'dangerFirst' : p.extra === 'opponent' ? 'opponentFirst' : 'adviceFirst';
        expect(p.shape, `${name} #${i}`).toBe(want);
        // one extra at most: the other extra fields are empty
        const extras = [p.reaction, p.deviation, p.newPlanRu, p.opponentMentionRu, p.openingName, p.concept && !p.danger ? p.concept : null, p.plan && !p.intro ? p.plan : null].filter((x) => x !== null);
        expect(extras.length, `${name} #${i}`).toBeLessThanOrEqual(1);
      }
      // the opening plan is said when it is new or changes, not on every move (normal talkativeness)
      const said = plans.filter((x) => x.plan !== null).length;
      expect(said, name).toBeGreaterThanOrEqual(1);
      expect(said, name).toBeLessThanOrEqual(4);
      // every opening principle at most once a game
      const rules = plans.flatMap((x) => x.rules);
      expect(new Set(rules).size, name).toBe(rules.length);
    }
  });

  it('(5): only teachTurn events — the teacher never emits threat warnings, opening ideas or thinking routines itself', () => {
    for (const g of games) for (const ev of g.events) expect(ev.kind).toBe('teachTurn');
  });

  it('is deterministic for an injected rng', () => {
    const a = scriptedGame(ITALIAN, 'w', profile({ stage: 2 }), seededRng(9)).map((e) => e.brief);
    const b = scriptedGame(ITALIAN, 'w', profile({ stage: 2 }), seededRng(9)).map((e) => e.brief);
    expect(a).toEqual(b);
  });
});

// ───────────────────────── the explainer seam ─────────────────────────

describe('the explainer is injectable (a scripted fake keeps the brain testable on its own)', () => {
  it('uses the injected ideas for the «why» and never invents one when there is none', () => {
    const fake: MoveIdeasApi = {
      explainMove: () => [],
      pickIdeas: (ideas) => ideas.slice(0, 1),
      explainOpponentMove: () => ({ ideas: [], wants: null as Threat | null }),
    };
    const ctx = ctxAfter(['e4', 'e5'], 'w', { specs: E2, ideas: fake, memory: { ...initialTeachMemory(), turns: 1 } });
    const { plan, ev } = turn(ctx);
    expect(plan.advice[0]?.ideas).toEqual([]);
    expect(plan.opponent?.ideas).toEqual([]);
    expect(ev.brief).toContain('конь на эф три (зелёная стрелка)');
    expect(ev.brief).not.toMatch(/выводит коня/);
    checkFormat(ev);
  });
});

describe('opening principles in words (§3.1)', () => {
  it('«knights before bishops» on stage 2 when the knight goes to its natural square and the alternative is a bishop', () => {
    // (no new card this time — a card takes the room of the principles in the brief)
    // (one principle at a time: «разбуди фигуры» was said on an earlier move)
    // (and the opening plan is not new: one extra a turn — a new plan would come first)
    const base = ctxAfter(['e4', 'e5'], 'w', { specs: [['Nf3', 19], ['Bc4', 15], ['Bb5', 10]], profile: profile({ stage: 2 }), conceptCard: undefined });
    const planKey = openingPlanFacts({ fen: base.fen, childColor: 'w', stage: 2, repertoire: base.repertoire }).key;
    const ctx: TeachContext = { ...base, memory: { ...initialTeachMemory(), turns: 1, rulesSaid: ['develop'], lastPlanKey: planKey, lastPlanPly: 1 } };
    const { plan, ev } = turn(ctx);
    expect(plan.extra).toBe('topic');
    expect(plan.advice.map((a) => a.san)).toEqual(['Nf3', 'Bc4']);
    expect(plan.rules.join(' ')).toMatch(/коню почти всегда хорошо на эф три, а куда лучше поставить слона, видно чуть позже/);
    expect(claims(ev.brief)).toMatch(/коню почти всегда хорошо на эф три/);
    // stage 1: not yet
    expect(turn({ ...ctx, profile: profile({ stage: 1 }) }).plan.rules.join(' ')).not.toMatch(/коню почти всегда/);
  });

  it('a principle that did not fit the brief is not remembered as said', () => {
    const ctx = ctxAfter(['e4', 'e5'], 'w', { specs: [['Nf3', 19], ['Bc4', 15], ['Bb5', 10]], profile: profile({ stage: 2 }), memory: { ...initialTeachMemory(), turns: 1 } });
    const { plan, ev } = turn(ctx);
    for (const r of plan.rules) expect(claims(ev.brief)).toContain(r.slice(0, 30).toLowerCase());
    expect(plan.memory.rulesSaid.length).toBe(plan.rules.length);
  });

  it('a principle is said once a game; the first castling is never squeezed into the short style', () => {
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5';
    const ctx: TeachContext = {
      fen,
      ply: 9,
      childColor: 'w',
      profile: profile({ stage: 2 }),
      analysis: scripted(fen, [['O-O', 25], ['c3', 20], ['Nc3', 15]]),
      lastBotMove: { uci: 'g8f6', san: 'Nf6', fenBefore: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R b KQkq - 0 4' },
      memory: { ...initialTeachMemory(), turns: 4, calmStreak: 2, lastPlanKey: 'principles', lastPlanPly: 7 },
    };
    const first = planTeachTurn(ctx, constRng(0));
    expect(first.style).not.toBe('short');
    expect(first.rules.join(' ')).toMatch(/рокировка прячет короля в домик/);
    const again = planTeachTurn({ ...ctx, memory: first.memory }, constRng(0));
    expect(again.rules).toEqual([]);
    const ev = buildTeachTurn(first, constRng(0));
    expect(ev.text).toMatch(/короткая рокировка(:| —) король прячется в домик/);
    expect(ev.text).not.toMatch(/рокировка — рокировка/);
  });
});

// ───────────────────────── §5.1 plans ─────────────────────────

describe('middlegamePlan (§5.1, P0 rows)', () => {
  it('castle soon, trade when ahead, push the passed pawn, improve the worst piece', () => {
    const castle = 'r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 12';
    const f1 = computePositionFacts(castle);
    expect(f1.phase).toBe('middlegame');
    expect(middlegamePlan(f1, castle, 'w')?.id).toBe('castleSoon');

    const ahead = 'r4rk1/ppp2ppp/8/8/8/8/PPP2PPP/R2Q1RK1 w - - 0 20';
    const f2 = computePositionFacts(ahead);
    const trade = middlegamePlan(f2, ahead, 'w');
    expect(trade?.id).toBe('tradeWhenAhead');
    expect(trade?.factRu).toMatch(/у ученика больше фигур/);
    expect(trade?.factRu).not.toMatch(/тебя|твой/);

    const passed = '6k1/5ppp/8/1P6/8/8/5PPP/6K1 w - - 0 30';
    const f3 = computePositionFacts(passed);
    expect(middlegamePlan(f3, passed, 'w')?.id).toBe('kingToCenter');
    const passed2 = '6k1/5ppp/8/1P6/6K1/8/5PPP/8 w - - 0 30';
    const p2 = middlegamePlan(computePositionFacts(passed2), passed2, 'w');
    expect(p2?.id).toBe('pushPassed');
    expect(p2?.squares).toEqual(['b5']);

    const boxed = 'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 14';
    const f4 = computePositionFacts(boxed);
    expect(middlegamePlan(f4, boxed, 'w')).toBeNull();
    const worst = middlegamePlan(f4, boxed, 'w', { calm: true });
    expect(worst?.id).toBe('improveWorstPiece');
    expect(worst?.factRu).toMatch(/почти не ходит/);
    for (const p of [trade, p2, worst]) {
      expect(p?.factRu).not.toMatch(LATIN);
      expect(p?.textRu).not.toMatch(LATIN);
    }
  });
});

describe('the opening plan without a repertoire (§3.3)', () => {
  it('by the principles: which pieces are still at home, then castling', () => {
    const fen = fenOf(['Nf3', 'd5', 'g3']);
    const op = openingPlanFacts({ fen, childColor: 'b', stage: 2, repertoire: null });
    expect(op.source).toBe('principles');
    expect(op.key).toBe('principles');
    expect(op.factsRu.join(' ')).toMatch(/конь на бэ восемь и слон на цэ восемь ещё дома/);
    expect(op.factsRu.join(' ')).toMatch(/план: вывести коня и слона, потом рокировка/);
    expect(op.textRu).not.toMatch(LATIN);
  });

  it('line titles only from stage 3 (§3.3)', () => {
    const rep = getRepertoirePlan(['e4', 'e5'], 'w');
    const fen = fenOf(['e4', 'e5']);
    expect(openingPlanFacts({ fen, childColor: 'w', stage: 2, repertoire: rep }).factsRu.join(' ')).not.toMatch(/Тихая итальянка/);
    expect(openingPlanFacts({ fen, childColor: 'w', stage: 3, repertoire: rep }).factsRu.join(' ')).toMatch(/«Тихая итальянка»/);
  });
});

// ───────────────────────── real-engine games G01–G13, positions P01–P11 ─────────────────────────
// Numbers: Stockfish 19 lite, depth 12 (the app's teachMinDepth); where depth 20 is quoted it is said in the test
// name.

/** A context from a FEN (the endgame positions P01–P11) — no previous move, no book. */
function ctxFen(fen: string, color: Color, specs: readonly LineSpec[], over: Partial<TeachContext> & { depth?: number } = {}): TeachContext {
  const { depth, ...rest } = over;
  return {
    fen,
    ply: 61,
    childColor: color,
    profile: profile({ stage: 1 }),
    analysis: scripted(fen, specs, depth ?? 16),
    lastBotMove: null,
    historySan: [],
    repertoire: null,
    mainLineSans: [],
    openingNameRu: (f) => lookupOpening(f)?.nameRu,
    conceptCard: getConceptCard,
    conceptsIntroduced: [],
    ...rest,
  };
}

describe('a recapture is a trade, never a gift', () => {
  it('G09 4.bxa3 (the bot takes back the bishop that took a rook) is told as «в ответ», not «бесплатно»', () => {
    const sans = ['a4', 'e5', 'h4', 'd5', 'Ra3', 'Bxa3', 'bxa3'];
    const { plan, ev } = turn(ctxAfter(sans, 'b', { specs: [['Nf6', 472], ['c5', 468], ['Nc6', 460]], depth: 12, memory: { ...initialTeachMemory(), turns: 3 } }));
    expect(plan.opponent?.ideas.map((i) => i.id)).toContain('recapture');
    expect(claims(ev.brief)).not.toMatch(/бесплатно|подарок/);
    expect(ev.text).not.toMatch(/бесплатно/);
    checkFormat(ev);
  });

  it('G08 5.Фxf3 after 4…Сxf3: a plain recapture — no treasure, «забираешь слона … в ответ — это размен»', () => {
    const sans = ['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5', 'Bxf3'];
    const { plan, ev } = turn(ctxAfter(sans, 'w', { profile: profile({ stage: 2 }), specs: [['Qxf3', 207], ['gxf3', 68], ['Qd5', -244]], depth: 12, memory: { ...initialTeachMemory(), turns: 4 } }));
    expect(plan.treasure).toBeNull();
    expect(ev.teach?.reveal).toBe('now');
    expect(plan.advice[0]?.san).toBe('Qxf3');
    expect(plan.advice[0]?.ideas[0]?.id).toBe('recapture');
    expect(ev.text).toMatch(/в ответ — это размен/);
    expect(claims(ev.brief)).not.toMatch(/не заметил/);
    checkFormat(ev);
  });

  it('G13 6…bxc6 after 6.Кxc6 and G12 5…d5 after 5.Кxe4 are no treasures (the net gain against the material before the bot\'s capture is 0)', () => {
    const g13 = turn(ctxAfter(['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3', 'Bb4', 'Nxc6'], 'b', { profile: profile({ stage: 2 }), specs: [['bxc6', -11], ['dxc6', -48], ['Bxc3+', -63]], depth: 12, memory: { ...initialTeachMemory(), turns: 5 } }));
    expect(g13.plan.treasure).toBeNull();
    expect(g13.plan.advice[0]?.ideas[0]?.id).toBe('recapture');
    const g12 = turn(
      ctxAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Nc3', 'Nxe4', 'Nxe4'], 'b', {
        profile: profile({ stage: 3 }),
        specs: [['d5', 2, 'Bd3', 'dxe4', 'Bxe4'], ['Be7', -394], ['Bb4', -409]],
        depth: 12,
        memory: { ...initialTeachMemory(), turns: 4 },
      }),
    );
    expect(g12.plan.treasure).toBeNull();
    // the bot's 5.Кxe4 took back on e4 — never «соперник забирает коня бесплатно»
    expect(g12.plan.opponent?.ideas[0]?.id).toBe('recapture');
    expect(claims(g12.ev.brief)).not.toMatch(/бесплатно|не заметил/);
    checkFormat(g12.ev);
  });

  it('T6 stays a treasure: 3.Фxd4 after 2…Кxd4 wins a knight for a pawn (net +2)', () => {
    const { plan } = turn(ctxAfter(['e4', 'Nc6', 'd4', 'Nxd4'], 'w', { specs: E7, memory: { ...initialTeachMemory(), turns: 2 } }));
    expect(plan.treasure?.san).toBe('Qxd4');
  });
});

describe('«известный ход, у него есть имя» only for a move that brings the name', () => {
  it('1.e4 Кc6: neither 2.d4 nor 2.Кf3 is «Дебют Нимцовича» (the name belongs to 1…Кc6)', () => {
    const { plan, ev } = turn(ctxAfter(['e4', 'Nc6'], 'w', { specs: [['Nf3', 37], ['d4', 35], ['Nc3', 22]], depth: 12, memory: { ...initialTeachMemory(), turns: 1 } }));
    expect(plan.advice.map((a) => a.san).sort()).toEqual(['Nf3', 'd4']);
    for (const a of plan.advice) expect(a.source, a.san).toBe('engine');
    expect(claims(ev.brief)).not.toMatch(/есть имя/);
  });

  it('1.e4 e5: 2.Кc3 still brings «Венская партия»', () => {
    const { plan } = turn(ctxAfter(['e4', 'e5'], 'w', { specs: E2, memory: { ...initialTeachMemory(), turns: 1 } }));
    const nc3 = plan.advice.find((a) => a.san === 'Nc3');
    if (nc3) expect(nc3.source).toBe('book');
  });
});

describe('the queen in the opening', () => {
  it('G02 1.e4 a5 2.Фf3 e5: a second queen move is never an arrow (kid filter: any queen move while two minors sleep)', () => {
    const { plan } = turn(ctxAfter(['e4', 'a5', 'Qf3', 'e5'], 'w', { specs: [['Bc4', 0], ['Qg3', -5], ['Nc3', -16]], depth: 12, memory: { ...initialTeachMemory(), turns: 2 } }));
    expect(plan.advice.map((a) => a.san)).not.toContain('Qg3');
    for (const a of plan.advice) expect(['Bc4', 'Nc3']).toContain(a.san);
  });

  it('G02: Сc4 is «выводит слона и грозит матом» on stage 1, not only the mate', () => {
    const { plan } = turn(ctxAfter(['e4', 'a5', 'Qf3', 'e5'], 'w', { specs: [['Bc4', 0], ['Nc3', -16], ['Ne2', -16]], depth: 12, memory: { ...initialTeachMemory(), turns: 2 } }));
    const bc4 = plan.advice.find((a) => a.san === 'Bc4');
    expect(bc4?.ideas.map((i) => i.id)).toEqual(['develop', 'threatMate']);
  });

  it('G08 6.Фb3 vs 6.Сc4 at the same score (depth 20): the bishop develops, the queen waits', () => {
    const sans = ['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5', 'Bxf3', 'Qxf3', 'dxe5'];
    const { plan } = turn(ctxAfter(sans, 'w', { profile: profile({ stage: 2 }), specs: [['Qb3', 149], ['Bc4', 149], ['Be3', 105]], depth: 20, memory: { ...initialTeachMemory(), turns: 5 } }));
    expect(plan.advice[0]?.san).toBe('Bc4');
    expect(plan.advice.map((a) => a.san)).not.toContain('Qb3');
  });

  it('G08 8.Фxb7 as the only move in the tolerance: never next to the card «не выводи ферзя рано»', () => {
    const sans = ['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5', 'Bxf3', 'Qxf3', 'dxe5', 'Bc4', 'Nf6', 'Qb3', 'Qe7'];
    const { plan, ev } = turn(ctxAfter(sans, 'w', { profile: profile({ stage: 2 }), specs: [['Qxb7', 303], ['Nc3', 206], ['O-O', 169]], depth: 12, memory: { ...initialTeachMemory(), turns: 7 } }));
    expect(plan.advice[0]?.san).toBe('Qxb7');
    expect(ev.teach?.conceptId).not.toBe('opening-early-queen');
    // the bot's 7…Фe7 guards f7: not «соперник рано вывел ферзя»
    expect(plan.opponent?.earlyQueen).toBe(false);
    expect(claims(ev.brief)).not.toMatch(/рано вывел ферзя/);
  });

  it('G03 5…Фe7 (guarding f7) is no early-queen mistake; the reaction says what the advice 5…Кd4 did', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3'];
    expect(isEarlyQueenMove(fenOf(sans), 'd8e7')).toBe(false);
    const j = judged(sans, 'Qe7', 'Nd4', { before: 507, after: 189, refutation: ['Nf3'] });
    const v = reactionVerdict({ judgement: j, advice: [{ uci: 'c6d4', san: 'Nd4', source: 'engine', arrow: 'green' }] });
    expect(v.earlyQueen).toBe(false);
    expect(v.kind).toBe('weaker');
    const ev = buildTeachReaction(v, { profile: profile({ stage: 2 }) }, constRng(0)) as CoachEvent;
    expect(ev.brief).toMatch(/конь на дэ четыре, нападает на ферзя на бэ три/);
    // two facts at most: the verdict and what the advice did (the reply Кf3 only develops) — and the goal asks for
    // exactly that, never «что теперь может соперник» with his reply left out
    expect(briefLine(ev.brief, 'Факты')).not.toMatch(/соперник может ответить/);
    expect(briefLine(ev.brief, 'Цель')).toMatch(/что делал совет/);
    expect(briefLine(ev.brief, 'Можно назвать')).not.toMatch(/ход соперника/);
    expect(ev.text).not.toMatch(/Ферзь сильный/);
    // Кf3 only develops: no red «danger» arrow for it
    expect(ev.board?.arrows ?? []).toEqual([]);
  });

  it('a queen move the teacher advised is never scolded as «early»', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4'];
    const j = judged(sans, 'Qe7', 'g6', { before: 28, after: 11 });
    const v = reactionVerdict({ judgement: j, advice: [{ uci: 'g7g6', san: 'g6', source: 'engine', arrow: 'green' }, { uci: 'd8e7', san: 'Qe7', source: 'engine', arrow: 'blue' }] });
    expect(v.earlyQueen).toBe(false);
    expect(v.kind).toBe('followed');
  });

  it('the child\'s early queen: «не выводит коня или слона», no red arrow for a harmless reply', () => {
    const j = judged(['e4', 'a5'], 'Qf3', 'Nc3', { before: 78, after: 20, refutation: ['Nc6'] });
    const v = reactionVerdict({ judgement: j, advice: [{ uci: 'b1c3', san: 'Nc3', source: 'engine', arrow: 'green' }] });
    expect(v.earlyQueen).toBe(true);
    const ev = buildTeachReaction(v, { profile: profile({ stage: 1 }) }, constRng(0)) as CoachEvent;
    expect(ev.brief).not.toMatch(/не выводит фигуру/);
    expect(ev.board?.arrows ?? []).toEqual([]);
    expect(ev.text).not.toMatch(/нападать конями/);
  });
});

describe('G07 1.e4 Кc6 2.d4 Кxd4 3.Фxd4 e5', () => {
  const sans = ['e4', 'Nc6', 'd4', 'Nxd4', 'Qxd4', 'e5'];

  it('4.Фxe5+ keeps «забирает пешку» even after a queen capture last time (a real gain is never demoted)', () => {
    const memory: TeachMemory = { ...initialTeachMemory(), turns: 3, lastMainIdea: { id: 'freeCapture', piece: 'q' } };
    const { plan } = turn(ctxAfter(sans, 'w', { specs: [['Qxe5+', 640], ['Qd3', 514], ['Qd1', 467]], depth: 12, memory }));
    expect(plan.advice[0]?.san).toBe('Qxe5+');
    expect(plan.advice[0]?.ideas[0]?.id).toBe('freeCapture');
  });

  it('4.Фd1 (the queen had to move) is not «та же фигура второй раз»', () => {
    const j = judged(sans, 'Qd1', 'Qxe5+', { before: 640, after: 467, refutation: ['Nf6'] });
    const v = reactionVerdict({ judgement: j, advice: [{ uci: 'd4e5', san: 'Qxe5+', source: 'engine', arrow: 'green' }] });
    const ev = buildTeachReaction(v, { profile: profile({ stage: 1 }), lastChildMoveTo: 'd4' }, constRng(0));
    expect(ev?.brief ?? '').not.toMatch(/второй раз подряд/);
  });
});

describe('endgames and treasures carry one task', () => {
  it('P06 Ф+Кр против Кр: no «меняйся фигурами» — the box mate plan', () => {
    const fen = '8/8/8/4k3/8/8/8/3QK3 w - - 1 61';
    const plan = middlegamePlan(computePositionFacts(fen), fen, 'w');
    expect(plan?.id).toBe('mateTechnique');
    const rook = '8/8/8/3k4/8/8/8/R3K3 w - - 1 61';
    expect(middlegamePlan(computePositionFacts(rook), rook, 'w')?.id).toBe('mateTechnique');
    const { ev } = turn(ctxFen(fen, 'w', [['Kf2', 1063], ['Ke2', 759], ['Qd8', 639]], { depth: 12 }));
    expect(claims(ev.brief)).not.toMatch(/меняться|меняйся/);
    expect(ev.text).not.toMatch(/меняйся/);
  });

  it('P11 mate in one: the treasure alone — no plan, no rule, no card; «поставить мат может ферзь»', () => {
    const fen = '1k6/8/1K6/8/8/8/8/6Q1 w - - 1 61';
    const { plan, ev } = turn(ctxFen(fen, 'w', [['Qg8#', { mate: 1 }], ['Qh2+', { mate: 2 }], ['Qc5', { mate: 2 }]]));
    expect(plan.treasure?.kind).toBe('mate');
    expect(plan.plan).toBeNull();
    expect(plan.conceptId).toBeNull();
    const brief = claims(ev.brief);
    expect(brief).toContain('поставить мат может ферзь');
    expect(brief).not.toMatch(/его начинает|план|меняться/);
  });

  it('G02 4.Фxf7#: no «разбуди фигуры» card next to «найди мат сам»', () => {
    const { plan, ev } = turn(ctxAfter(['e4', 'a5', 'Qf3', 'e5', 'Bc4', 'Nc6'], 'w', { specs: [['Qxf7#', { mate: 1 }], ['Bxf7+', 199], ['Ne2', 4]], depth: 12, memory: { ...initialTeachMemory(), turns: 3 } }));
    expect(plan.treasure).not.toBeNull();
    expect(ev.teach?.conceptId).toBeUndefined();
    expect(claims(ev.brief)).not.toMatch(/спроси ученика|план:/);
  });

  it('tactics without a gendered pronoun; the trapped piece is «можно поймать фигуру соперника»', () => {
    const fen = '8/1q6/8/8/4k3/8/8/5BK1 w - - 1 41';
    const { plan } = turn(ctxFen(fen, 'w', [['Bg2+', 10, 'Ke3', 'Bxb7'], ['Bd3+', -814], ['Bh3', -819]], { profile: profile({ stage: 3 }), depth: 12 }));
    expect(plan.treasure?.factRu).toMatch(/есть сквозной удар: так выигрывается материал; это может сделать слон/);
    expect(plan.treasure?.factRu).not.toMatch(/её начинает/);
  });
});

describe('dangers are always said', () => {
  it('G03: two danger turns in a row — the second text still names the mate threat, whatever the shape', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3'];
    for (let seed = 1; seed <= 12; seed++) {
      const memory: TeachMemory = { ...initialTeachMemory(), turns: 3, lastShape: 'dangerFirst' };
      const { plan, ev } = turn(ctxAfter(sans, 'b', { profile: profile({ stage: 2 }), specs: [['Nf6', 26], ['f5', 13], ['Qe7', 11]], depth: 12, memory }), seededRng(seed));
      expect(plan.danger?.kind).toBe('mate');
      expect(ev.text, `${plan.shape}: ${ev.text}`).toMatch(/матом/);
      expect(ev.text).not.toMatch(/Он уводит ферзя/);
    }
  });

  it('G06 4.Кg5: the threat is the fork on f7 — targets ферзь d8 and ладья h8, capitalised; the move is told by its attack', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5'];
    const fen = fenOf(sans);
    const threat = threatFromNullMoveLine(fen, { cp: 350, mate: null, pvUci: ['g5f7', 'd8e7', 'f7h8'] }) as Threat;
    expect(threat.motif).toBe('fork');
    expect(threat.targetSquares).toEqual(['d8', 'h8']);
    const { plan, ev } = turn(ctxAfter(sans, 'b', { profile: profile({ stage: 2 }), threat, specs: [['d5', -1], ['Bc5', -96], ['Nxe4', -145]], depth: 12, memory: { ...initialTeachMemory(), turns: 3 } }));
    expect(plan.opponent?.ideas[0]?.id).toBe('attack');
    expect(ev.brief).toMatch(/\. Под прицелом: ферзь на дэ восемь, ладья на аш восемь/);
    expect(ev.brief).not.toMatch(/\. под прицелом/);
  });

  it('G06 6.Сb5+: the advice says how it answers the check; G04 …Кxc2+: the treasure text starts with the check', () => {
    const g06 = turn(ctxAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Na5', 'Bb5+'], 'b', { profile: profile({ stage: 2 }), specs: [['c6', -1], ['Bd7', -34], ['Nd7', -123]], depth: 12, memory: { ...initialTeachMemory(), turns: 5 } }));
    expect(g06.plan.advice[0]?.ideas[0]?.id).toBe('answerCheck');
    expect(g06.ev.text).toMatch(/закрываешься от шаха/);
    const g04 = turn(ctxAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4', 'Qa4', 'Nxc2+'], 'w', { specs: [['Qxc2', 390], ['Kd1', -551], ['Ke2', -671]], depth: 12, memory: { ...initialTeachMemory(), turns: 6 } }));
    expect(g04.plan.treasure).not.toBeNull();
    expect(g04.ev.text).toMatch(/^Шах!/);
  });

  it('G04 5…Кd4: stage 1 saves the queen first; stage 3 may give the check — and says why the queen can wait', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4'];
    const specs: LineSpec[] = [['Bxf7+', -439], ['Qa4', -446], ['Qg3', -452]];
    const s1 = turn(ctxAfter(sans, 'w', { specs, depth: 12, memory: { ...initialTeachMemory(), turns: 5 } }));
    expect(['Qa4', 'Qg3']).toContain(s1.plan.advice[0]?.san);
    const s3 = turn(ctxAfter(sans, 'w', { profile: profile({ stage: 3 }), specs, depth: 12, memory: { ...initialTeachMemory(), turns: 5 } }));
    if (s3.plan.advice[0]?.san === 'Bxf7+') expect(s3.plan.danger?.unresolvedRu).toMatch(/это шах, сначала соперник спасает короля/);
  });
});

describe('depth-12 noise and the «why»', () => {
  it('G01 4…Кf6: the repertoire 5.d3 (defends e4) beats 5.b4 +20 cp at depth 12 — a flank pawn in the opening', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'];
    const { plan } = turn(ctxAfter(sans, 'w', { specs: [['b4', 38], ['d3', 18], ['d4', 14]], depth: 12, memory: { ...initialTeachMemory(), turns: 4 } }));
    expect(plan.advice[0]?.san).toBe('d3');
    expect(plan.advice.map((a) => a.san)).not.toContain('b4');
  });

  it('stages 1–2 answer the attacked pawn first; when no defence is in the tolerance the brief says why it may wait', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nf6'];
    const defended = turn(ctxAfter(sans, 'w', { specs: [['Nxe5', 40], ['Nc3', 25], ['Bc4', 20]], memory: { ...initialTeachMemory(), turns: 2 } }));
    expect(defended.plan.advice[0]?.san).toBe('Nc3');
    const waits = turn(ctxAfter(sans, 'w', { specs: [['Nxe5', 40], ['Bc4', 20], ['d4', 15]], memory: { ...initialTeachMemory(), turns: 2 } }));
    expect(waits.plan.advice[0]?.san).toBe('Nxe5');
    expect(claims(waits.ev.brief)).toMatch(/можно не защищать пешку на е четыре: ход конь бьёт на е пять сильнее/);
    checkFormat(waits.ev);
  });

  it('G11 5…d6: a rim knight is no arrow in the opening', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Bc5', 'Nc3', 'd6'];
    const { plan } = turn(ctxAfter(sans, 'w', { profile: profile({ stage: 2 }), specs: [['Na4', 24], ['O-O', 9], ['Nd5', 5]], depth: 12, memory: { ...initialTeachMemory(), turns: 5 } }));
    expect(plan.advice.map((a) => a.san)).not.toContain('Na4');
    expect(plan.advice[0]?.san).toBe('O-O');
  });

  it('G12 4.Кc3: an explained 4…Сc5 beats an unexplained 4…Кxe4 on stage 3; no «незащищённая фигура» card from the opponent\'s defence', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Nc3'];
    const { plan, ev } = turn(ctxAfter(sans, 'b', { profile: profile({ stage: 3 }), specs: [['Nxe4', -6], ['Bc5', -22], ['Be7', -29]], depth: 12, memory: { ...initialTeachMemory(), turns: 3 } }));
    expect(plan.advice[0]?.san).toBe('Bc5');
    expect(ev.teach?.conceptId).not.toBe('hanging-piece');
  });
});

describe('words and the plan', () => {
  it('«короткая рокировка» is not followed by «а потом рокировка»', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'];
    const op = openingPlanFacts({ fen: fenOf(sans), childColor: 'w', stage: 2, repertoire: getRepertoirePlan(sans, 'w') ?? null });
    expect(op.textRu).not.toMatch(/рокировка.*рокировка/);
  });

  it('the repertoire line simply ended (G03 …4…Кf6 5.Фb3) — «план закончился», not «соперник сыграл не так»', () => {
    const before = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3'];
    const first = planTeachTurn(ctxAfter(before, 'b', { profile: profile({ stage: 2 }), specs: [['Nf6', 26], ['f5', 13], ['Qe7', 11]], depth: 12, memory: { ...initialTeachMemory(), turns: 3 } }), constRng(0));
    expect(first.memory.repertoireInBook).toBe(true);
    const { ev } = turn(ctxAfter([...before, 'Nf6', 'Qb3'], 'b', { profile: profile({ stage: 2 }), specs: [['Nd4', 507], ['d5', 241], ['Qe7', 189]], depth: 12, memory: first.memory }));
    expect(claims(ev.brief)).not.toMatch(/соперник сыграл не так/);
    expect(claims(ev.brief)).toMatch(/план закончился/);
  });

  it('without an engine in the middlegame — never «спокойно» or the short style; the note comes first', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+', 'Bd2', 'Bxd2+', 'Nbxd2', 'd5', 'exd5', 'Nxd5', 'Qb3', 'Nce7', 'O-O', 'O-O', 'Rfe1', 'c6'];
    const { ev } = turn(ctxAfter(sans, 'w', { memory: { ...initialTeachMemory(), turns: 11, calmStreak: 3 } }));
    expect(ev.teach?.style).not.toBe('short');
    expect(ev.text).not.toMatch(/спокойн/i);
    expect(ev.brief).toMatch(/Факты: Точной проверки ходов сейчас нет/);
    checkFormat(ev);
  });

  it('a quiet Italian — at least a quarter of the turns are short', () => {
    const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6', 'Nbd2', 'Ba7', 'Nf1', 'h6', 'Ng3', 'Re8', 'h3', 'Be6', 'Bb3', 'Qd7', 'Nh2', 'Rad8', 'Qf3', 'Kh8', 'Be3', 'Bxe3', 'Rxe3', 'Na5', 'Bc2', 'c5', 'b3', 'b5', 'a4', 'Qc7', 'Rae1', 'Nc6'];
    const plans: TeachPlan[] = [];
    const events = scriptedGame(moves, 'w', profile({ stage: 2 }), seededRng(7), plans);
    // short = what is heard: the short style, or the ONE sentence «his move — our answer: why» (≤ 20 words) — a calm turn
    // kept full for «Что выбираешь?» that his move leads says only that sentence (the choice waits)
    const oneOppSentence = (i: number): boolean => plans[i]?.opener === 'opp' && countSentences(events[i]?.text ?? '') === 1 && countWords(events[i]?.text ?? '') <= OPP_SENTENCE_WORDS;
    const short = events.filter((e, i) => e.teach?.style === 'short' || oneOppSentence(i)).length;
    expect(events.filter((e) => e.teach?.style === 'short').length).toBeGreaterThanOrEqual(3);
    expect(events.length).toBeGreaterThanOrEqual(18);
    expect(short / events.length, `${short} of ${events.length}`).toBeGreaterThanOrEqual(0.25);
  });

  it('the stage-1 name is the family only; «Дебют …» is announced as «это «Дебют …»»', () => {
    const got = turn(ctxAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], 'w', { specs: [['d3', 12], ['Nc3', 10], ['c3', 8]], memory: { ...initialTeachMemory(), turns: 3 } }));
    if (got.plan.openingName) expect(got.plan.openingName).not.toMatch(/,/);
    expect(claims(got.ev.brief)).not.toMatch(/по дебюту «дебют/);
  });

  it('one advice → no «Какой выберешь?»; the treasure square that is red stays red only', () => {
    const { plan, ev } = turn(ctxAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3'], 'b', { profile: profile({ stage: 2 }), specs: [['Nd4', 507], ['d5', 241], ['Qe7', 189]], depth: 12, memory: { ...initialTeachMemory(), turns: 4 } }));
    expect(plan.advice).toHaveLength(1);
    expect(ev.text).not.toMatch(/Какой выберешь/);
    for (const g of [plan]) {
      const squares = (ev.board?.highlights ?? []).map((h) => h.square);
      expect(new Set(squares).size, JSON.stringify(ev.board?.highlights)).toBe(squares.length);
      void g;
    }
  });

  it('the child left the book — «сыграл слоном на …», never «сыграл слон на …»', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
    const j = judged(sans, 'Bb5', 'Bc4', { before: 32, after: 31 });
    const v = reactionVerdict({ judgement: j, advice: [{ uci: 'f1c4', san: 'Bc4', source: 'repertoire', arrow: 'green' }], repertoireNextSan: 'Bc4' });
    expect(v.kind).toBe('ownGood');
    expect(v.leftBook).toBe(true);
    // (a quiet reply: after 3…a6 the bishop's danger would be the one extra of the turn)
    const { ev, plan } = turn(ctxAfter([...sans, 'Bb5', 'd6'], 'w', { specs: [['O-O', 30], ['d4', 25], ['c3', 20]], reaction: v, memory: { ...initialTeachMemory(), turns: 2 } }));
    expect(plan.extra).toBe('ownGood');
    expect(ev.brief).toMatch(/сыграл слоном на бэ пять/);
    expect(ev.brief).not.toMatch(/сыграл слон на/);
  });
});

describe('the teacher take-back brief names the loss honestly', () => {
  it('a rook for a knight is not «теряет ладью — это четыре пешки»', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4', 'Qa4', 'Nxc2+'];
    const j = judged(sans, 'Kd1', 'Qxc2', { before: 390, after: -551, refutation: ['c2a1'], loss: 4, motif: 'freeCapture' });
    const ev = buildTakebackOffer(j, profile({ stage: 1 }), constRng(0), { advice: [{ uci: 'a4c2', san: 'Qxc2', source: 'engine', arrow: 'green' }] });
    expect(ev.brief).not.toMatch(/ладью — это четыре пешки/);
    expect(ev.brief).toMatch(/теряется примерно четыре пешки материала/);
  });

  it('a quiet refutation says what it does (5.Фb3?? Кd4 attacks the queen)', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6'];
    const j = judged(sans, 'Qb3', 'Ne2', { before: 20, after: -480, refutation: ['c6d4', 'b3a4', 'd4c2', 'e1d1', 'c2a1'], loss: 5 });
    const ev = buildTakebackOffer(j, profile({ stage: 1 }), constRng(0), { advice: [{ uci: 'g1e2', san: 'Ne2', source: 'engine', arrow: 'green' }] });
    expect(ev.brief).toMatch(/конь на дэ четыре — конь нападает на ферзя/);
  });
});

// ───────────────────────── template wording the recorded clips rely on (docs/voice-clips/SPEC.md §3.5) ─────────────────────────

describe('template wording (clips freeze it)', () => {
  it('a treasure won by a trade names its victim in the accusative: «ферзя соперника … можно выгодно забрать»', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Qg5'];
    const ideas: MoveIdeasApi = {
      explainMove: (a) => (a.uci === 'f3g5' ? [{ id: 'winMaterial', group: 'A', squares: ['g5'], phraseRu: 'выгодно бьёт ферзя', phraseYouRu: 'выгодно бьёшь ферзя', gainPawns: 9 }] : []),
      pickIdeas: (list, o) => list.slice(0, o.max),
      explainOpponentMove: () => ({ ideas: [], wants: null }),
    };
    const { plan, ev } = turn(ctxAfter(sans, 'w', { specs: [['Nxg5', 900], ['d4', 20], ['Nc3', 10]], ideas, profile: profile({ stage: 1 }) }));
    expect(plan.treasure?.kind).toBe('capture');
    expect(ev.text).toContain('Смотри, тут подарок: ферзя соперника на же пять можно выгодно забрать!');
    expect(ev.brief).toMatch(/ферзя соперника на же пять можно выгодно забрать/i);
    expect(`${ev.text} ${ev.brief ?? ''}`).not.toMatch(/ферзь соперника на же пять можно/);
  });

  it('the bubble keeps the notation\'s case: «d4 — это по плану», never «D4»', () => {
    const { plan } = turn(ctxAfter([], 'w', { specs: [['d4', 30]] }));
    const a: AdviceCandidate = { ...(plan.advice[0] as AdviceCandidate), planFit: 'line' };
    delete a.planGoal;
    delete a.planStepRu;
    expect(a.san).toBe('d4');
    const strategy = { strategyId: 'london', titleRu: 'Лондонская система', ideaRu: 'строим крепость из пешек' };
    const planned: TeachPlan = { ...plan, strategy, advice: [a], opener: 'planMove', intro: false, treasure: null, danger: null, style: 'full', extra: null, opponentMentionRu: null, reaction: null, plan: null, concept: null, deviation: null, hurry: false, choice: false, openingName: null };
    const ev = buildTeachTurn(planned, constRng(0));
    expect(ev.bubbleText).toMatch(/^d4 — это по плану/);
    expect(ev.text).toMatch(/^Пешка на дэ четыре — это по плану/);
  });

  it('«Смотри:» is followed by the consequence itself — never «Смотри: а мой совет …»', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3'];
    const j = judged(sans, 'Qe7', 'Nd4', { before: 507, after: 189, refutation: ['Nf3'] });
    const v = reactionVerdict({ judgement: j, advice: [{ uci: 'c6d4', san: 'Nd4', source: 'engine', arrow: 'green' }] });
    // (the third template of «weaker» is the «Смотри: …» one)
    const ev = buildTeachReaction(v, { profile: profile({ stage: 2 }) }, constRng(0.99)) as CoachEvent;
    expect(ev.text).toMatch(/^Смотри: мой совет нападает на ферзя/);
    expect(ev.text).not.toMatch(/Смотри: а /);
    // the other templates keep their contrast
    const other = buildTeachReaction(v, { profile: profile({ stage: 2 }) }, constRng(0)) as CoachEvent;
    expect(other.text).toMatch(/: а мой совет нападает на ферзя/);
  });
});
