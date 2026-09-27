/**
 * The corpus of the event builders (docs/TEACHING.md §7 «корпус»): every builder of ../events.ts —
 * the helper («Подсказчик») and the lines every coach style shares — over seeded rngs × stages 1–5 × address m/f on
 * real positions (the fixture blunders, real openings of @gambit/content, the repertoire's own words, the real
 * personas). In `text` AND in `bubbleText`: no spoken square, no Latin, no «молодец / умница / так держать».
 *
 * Deliberately outside: a Latin nickname or persona name typed by a parent (the bubble shows a name as it was typed —
 * events.test covers that it never reaches the speech), and the teacher's strategy intro of `buildGameStart`
 * (coachStyle 'teacher' WITH a strategy: the words of ./strategy.ts, «Начни пешкой на е четыре»; the lesson starts a
 * teacher game with `lessonGameStart` instead) — its current wording is pinned below so a change is noticed.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { OPENING_REPERTOIRE, PERSONAS } from '@gambit/content';
import type { AnalysisResult, CoachEvent, EngineLine, HintLevel, MoveJudgement, Persona, PositionFacts, StudentProfile, TeachAdvice, Threat } from '@gambit/shared';
import { TIME_CONTROLS } from '@gambit/shared';
import { computePositionFacts } from '../../analysis/facts.ts';
import { hasSpokenSquare } from '../clips/lint.ts';
import * as events from '../events.ts';
import { TAKEBACK_DECLINE_REASONS } from '../events.ts';
import {
  ALL_MOTIFS,
  BACK_RANK_FEN,
  FORK_FEN,
  PERSONA,
  RNG_SWEEP,
  analysisOf,
  backRankBlunder,
  bestMoveJudgement,
  constRng,
  counts,
  facts,
  forkBlunder,
  hanging,
  judgement,
  profile,
  queenBlunder,
  seededRng,
  summary,
} from '../test-fixtures.ts';
import { mateInOneThreat, threatFromNullMoveLine } from '../threats.ts';

const LATIN = /[A-Za-z]/;
const BANNED_PRAISE = /молод(ец|цы|чина)|умниц|так держать/i;
const STAGES = [1, 2, 3, 4, 5] as const;
const ADDRESSES = ['m', 'f'] as const;
const SEEDS = [1, 7, 42, 2026] as const;

type Rng = () => number;

// ───────────────────────── real positions ─────────────────────────

function fenAfter(...sans: string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

/** The child's moves that lose something, from real openings / endgames (the fixture ones and a few more). */
const BLUNDERS: readonly MoveJudgement[] = [
  queenBlunder(),
  forkBlunder(),
  backRankBlunder(),
  // 1.e4 e5 2.Фh5 Кc6 3.Сc4 Кf6?? 4.Фxf7# — the scholar's mate
  judgement({ setup: ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4'], played: 'Nf6', best: 'g6', refutation: ['Qxf7#'], over: { allowedMotif: 'mateIn1', evalAfter: { cp: null, mate: -1 }, winPctAfter: 0 } }),
  // 3.Кg5?? — the knight simply hangs to the queen
  judgement({ setup: ['e4', 'e5', 'Nf3', 'Nc6'], played: 'Ng5', best: 'Bc4', refutation: ['Qxg5', 'd4'], over: { allowedMotif: 'hangingPiece', materialLossPawns: 3 } }),
  // the Légal trap: 4…g6?? 5.Кxe5 — Black's queen is lost after 5…Сxd1 6.Сxf7+ Крe7 7.Кd5#
  judgement({ setup: ['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3'], played: 'g6', best: 'Nc6', refutation: ['Nxe5', 'Bxd1', 'Bxf7+', 'Ke7', 'Nd5#'], over: { allowedMotif: 'mateIn3', evalAfter: { cp: null, mate: -3 } } }),
  // a rook endgame: the child lets the pawn run
  judgement({ fen: '8/P5k1/8/8/8/8/6K1/r7 w - - 0 50', played: 'Kf3', best: 'a8=Q', refutation: ['Rxa7'], over: { allowedMotif: 'promotion', materialLossPawns: 1 } }),
];

/** Positions with the engine's best move for the hint ladder: mate, castle, rescue, capture, promotion, development. */
const HINTS: readonly { fen: string; best: AnalysisResult; facts: PositionFacts }[] = (() => {
  const out: { fen: string; best: AnalysisResult; facts: PositionFacts }[] = [];
  const add = (fen: string, san: string, over: { mate?: number | null } = {}, f?: PositionFacts): void => {
    out.push({ fen, best: analysisOf(fen, san, over), facts: f ?? computePositionFacts(fen) });
  };
  add('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'Qxf7#', { mate: 1 });
  add(FORK_FEN, 'O-O-O');
  add(FORK_FEN, 'Rd1', {}, facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4'])] }));
  add(BACK_RANK_FEN, 'h3');
  add(BACK_RANK_FEN, 'Ra8');
  add('4k3/8/8/3p4/8/8/3R4/4K3 w - - 0 1', 'Rxd5');
  add('8/P5k1/8/8/8/8/6K1/r7 w - - 0 50', 'a8=Q');
  add(fenAfter('e4', 'e5'), 'Nf3');
  add(fenAfter('e4', 'e5', 'Nf3', 'Nc6'), 'Bb5');
  add(fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'), 'O-O');
  add(fenAfter('e4', 'e5', 'Qh5', 'Nf6'), 'Qxe5+');
  add(fenAfter('d4', 'd5', 'c4', 'dxc4'), 'e3');
  // no best move known: the generic question
  out.push({ fen: FORK_FEN, best: { fen: FORK_FEN, lines: [], bestmove: '(none)', depth: 0, timeMs: 0 }, facts: facts(FORK_FEN) });
  return out;
})();

/** Threat warnings: real facts (a hanging piece or none) with engine-like threats (a mate, a fork) and without. */
const THREATS: readonly { fen: string; facts: PositionFacts; threat?: Threat | null; lastMove?: { san: string; fenBefore: string } | null }[] = (() => {
  const forkLine: Pick<EngineLine, 'cp' | 'mate' | 'pvUci'> = { cp: -500, mate: null, pvUci: ['d4c2', 'e1d1', 'c2a1'] };
  const fork = threatFromNullMoveLine(FORK_FEN, forkLine) ?? { uci: 'd4c2', san: 'Nxc2+', motif: 'fork' as const, targetSquares: ['e1', 'a1'], gainCp: 500 };
  const backRank = mateInOneThreat(BACK_RANK_FEN);
  const legal = fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4', 'Nxe5', 'Qg5');
  const out = [
    { fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4', 'c2'])] }) },
    { fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('f2', 'n', 'w', 300, ['d4'])] }) },
    { fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('d1', 'q', 'w', 900, ['d4'])] }) },
    { fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('c4', 'b', 'w', 300, ['d4'])] }) },
    { fen: FORK_FEN, facts: facts(FORK_FEN), threat: fork, lastMove: { san: 'Nd4', fenBefore: 'r3k2r/ppp2ppp/8/4n3/8/8/PPP2PPP/R3K2R b KQkq - 0 11' } },
    { fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4'])] }), threat: fork },
    { fen: BACK_RANK_FEN, facts: computePositionFacts(BACK_RANK_FEN), threat: backRank },
    // 1.e4 e5 2.Кf3 Кc6 3.Сc4 Кd4 4.Кxe5 Фg5 — real facts: the knight on e5 and g2 are under fire
    { fen: legal, facts: computePositionFacts(legal), threat: mateInOneThreat(legal), lastMove: { san: 'Qg5', fenBefore: fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4', 'Nxe5') } },
  ];
  return out;
})();

/** The advice a teacher showed before the blunder (the teacher variant of the take-back offer). */
function adviceOf(j: MoveJudgement): TeachAdvice[] {
  const chess = new Chess(j.fenBefore);
  const moves = chess.moves({ verbose: true });
  const best = moves.find((m) => `${m.from}${m.to}${m.promotion ?? ''}` === j.bestUci);
  const other = moves.find((m) => m.san !== best?.san && m.san !== j.san && (m.captured || m.san.startsWith('O-O') || m.piece !== best?.piece));
  const out: TeachAdvice[] = [];
  if (best) out.push({ uci: j.bestUci, san: best.san, source: 'engine', arrow: 'green' });
  if (other) out.push({ uci: `${other.from}${other.to}${other.promotion ?? ''}`, san: other.san, source: 'engine', arrow: 'blue' });
  return out;
}

const PERSONA_LIST: readonly Persona[] = Object.values(PERSONAS);

// ───────────────────────── the sweep ─────────────────────────

/** The builders the sweep calls (a new exported `build*` must be added here — the test below checks it). */
const SWEPT = new Set<string>();

type Swept = { name: string; e: CoachEvent };

function collector(): { out: { name: string; e: CoachEvent | null }[]; add: (name: string, e: CoachEvent | null) => void; done: () => Swept[] } {
  const out: { name: string; e: CoachEvent | null }[] = [];
  return {
    out,
    add: (name, e) => {
      SWEPT.add(name);
      out.push({ name, e });
    },
    done: () => out.filter((x): x is Swept => x.e !== null),
  };
}

const MOTIFS_ALL = [undefined, ...ALL_MOTIFS] as const;
const ADVICE = new Map<MoveJudgement, TeachAdvice[]>(BLUNDERS.map((j) => [j, adviceOf(j)]));

/**
 * The blunder families (take-back offer: helper / teacher / the second try, «Почему так?», the post-mortem): the costly
 * ones — each call replays the refutation — so one corpus takes a third of the motif labels (`slice`); the sweep
 * rotates the slices over stages, addresses and rngs.
 */
function blunderCorpus(p: StudentProfile, rng: Rng, slice: number): Swept[] {
  const { add, done } = collector();
  for (const j of BLUNDERS) {
    const advice = ADVICE.get(j) ?? [];
    MOTIFS_ALL.forEach((motif, i) => {
      if (i % 3 !== slice % 3) return;
      const jm: MoveJudgement = { ...j, ...(motif ? { allowedMotif: motif, missedMotif: motif } : {}) };
      add('buildTakebackOffer', events.buildTakebackOffer(jm, p, rng));
      add('buildTakebackOffer', events.buildTakebackOffer(jm, p, rng, { again: true }));
      add('buildTakebackOffer', events.buildTakebackOffer(jm, p, rng, { advice }));
      add('buildTakebackOffer', events.buildTakebackOffer(jm, p, rng, { advice, again: true }));
      add('buildTakebackQuestion', events.buildTakebackQuestion(jm, p, rng));
      add('buildExplainBest', events.buildExplainBest(jm, p, rng));
    });
    add('buildExplainBest', events.buildExplainBest({ ...j, refutationPvUci: [], refutationPvSan: [] }, p, rng));
  }
  return done();
}

/** Everything else: cheap, so every rng of the sweep runs all of it. */
function corpus(p: StudentProfile, rng: Rng): Swept[] {
  const { add, done } = collector();
  for (const hour of [7, 13, 19, 23]) {
    add('buildGreeting', events.buildGreeting({ profile: p, hour }, rng));
    add('buildGreeting', events.buildGreeting({ profile: p, hour, lastGame: { id: 'g', startedAt: '', personaId: 'petya', timeControlId: 'rapid10', childColor: 'w', result: '1-0', accuracy: 80, blunders: 0, reviewStatus: 'ready' } }, rng));
    add('buildGreeting', events.buildGreeting({ profile: { ...p, totals: { ...p.totals, games: 0 } }, hour }, rng));
  }
  for (const persona of PERSONA_LIST) {
    for (const tc of Object.values(TIME_CONTROLS)) {
      for (const coachStyle of [undefined, 'helper', 'exam'] as const) {
        add('buildGameStart', events.buildGameStart({ persona, timeControl: tc, childColor: 'w', profile: p, ...(coachStyle ? { coachStyle } : {}), greet: rng() < 0.5 }, rng));
      }
      // the teacher without a strategy (the strategist and the library failed) — one plain line
      add('buildGameStart', events.buildGameStart({ persona, timeControl: tc, childColor: 'b', profile: p, coachStyle: 'teacher', strategy: null }, rng));
    }
  }
  add('buildGameStart', events.buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: p, examMode: true }, rng));
  add('buildGameHello', events.buildGameHello(p, rng));
  add('buildGameResumed', events.buildGameResumed({ childToMove: true, profile: p }, rng));
  for (const entry of OPENING_REPERTOIRE) {
    for (const line of entry.lines) add('buildOpeningIdea', events.buildOpeningIdea({ title: line.title, idea: line.idea, ...(line.warning ? { warning: true } : {}), profile: p }, rng));
  }
  for (const motif of MOTIFS_ALL) {
    add('buildExplainBest', events.buildExplainBest(bestMoveJudgement(motif), p, rng));
    add('buildPraise', events.buildPraise(bestMoveJudgement(motif), p, rng));
    add('buildPraise', events.buildPraise(bestMoveJudgement(motif, { classification: 'excellent', bestUci: 'a2a3' }), p, rng, undefined, { onlyMove: true }));
    add('buildPraise', events.buildPraise(bestMoveJudgement(undefined, { san: 'Qxf7#' }), p, rng, motif));
    add('buildGameEnd', events.buildGameEnd({ result: '1-0', childColor: 'w', termination: 'checkmate', summary: summary({ motifsAllowed: motif ? [motif] : [] }), persona: PERSONA, profile: p }, rng));
    add('buildGameEnd', events.buildGameEnd({ result: '0-1', childColor: 'w', termination: 'resign', summary: summary({ motifsAllowed: [], motifsMissed: motif ? [motif] : [] }), persona: PERSONA, profile: p, takebacksImproved: 1 }, rng));
  }
  add('buildTakebackDeclined', events.buildTakebackDeclined(p, rng));
  add('buildTakebackAccepted', events.buildTakebackAccepted(p, rng));
  for (const reason of TAKEBACK_DECLINE_REASONS) add('buildDeclineReasonReply', events.buildDeclineReasonReply(reason, p, rng));
  add('buildVoluntaryTakeback', events.buildVoluntaryTakeback(p, rng));
  for (const h of HINTS) {
    for (const level of [1, 2, 3, 4] as HintLevel[]) add('buildHint', events.buildHint(level, { fen: h.fen, best: h.best, facts: h.facts, profile: p }, rng));
  }
  for (const t of THREATS) {
    add('buildThreatWarning', events.buildThreatWarning({ fen: t.fen, facts: t.facts, profile: p, ...(t.threat !== undefined ? { threat: t.threat } : {}), ...(t.lastMove !== undefined ? { lastMove: t.lastMove } : {}) }, rng));
  }
  add('buildThinkingRoutine', events.buildThinkingRoutine(p, rng));
  add('buildSilenceNudge', events.buildSilenceNudge(p, rng));
  for (const persona of PERSONA_LIST) {
    for (const [result, termination] of [
      ['1-0', 'checkmate'],
      ['1-0', 'timeout'],
      ['0-1', 'checkmate'],
      ['0-1', 'timeout'],
      ['0-1', 'resign'],
      ['1/2-1/2', 'stalemate'],
      ['1/2-1/2', 'draw'],
      ['*', 'abandoned'],
    ] as const) {
      add('buildGameEnd', events.buildGameEnd({ result, childColor: 'w', termination, summary: summary(), persona, profile: p }, rng));
      add('buildGameEnd', events.buildGameEnd({ result, childColor: 'b', termination, summary: summary({ takebacksAccepted: 0, hintsUsed: 0, takebacksOffered: 0, accuracy: 90, counts: counts({ blunder: 0, best: 7 }) }), persona, profile: p }, rng));
    }
  }
  return done();
}

function rngsFor(stage: number): Rng[] {
  // every template index for a const rng (a pick of ≤ 24 templates), and a few long random streams
  return [...RNG_SWEEP.filter((_, i) => i % 3 === stage % 3).map((r) => constRng(r)), ...SEEDS.map((s) => seededRng(s * 31 + stage))];
}

describe('the builders of ../events.ts: no square, no Latin, no «молодец» — stages 1–5 × m/f', () => {
  const all: { name: string; e: CoachEvent; who: string }[] = [];
  for (const stage of STAGES) {
    for (const address of ADDRESSES) {
      for (const nickname of [address === 'f' ? 'Маша' : 'Миша', '']) {
        const p = profile({ stage, address, nickname });
        const who = `stage ${stage} ${address}${nickname ? '' : ' (no name)'}`;
        for (const rng of rngsFor(stage)) for (const x of corpus(p, rng)) all.push({ ...x, who });
        // the costly families: two long random streams, a third of the motif labels each (all of them over the sweep)
        if (nickname !== '') {
          SEEDS.slice(0, 2).forEach((seed, k) => {
            for (const x of blunderCorpus(p, seededRng(seed * 97 + stage * 5 + (address === 'f' ? 1 : 0)), stage + k + (address === 'f' ? 1 : 0))) all.push({ ...x, who });
          });
        } else {
          for (const x of blunderCorpus(p, constRng((stage * 7 + 3) / 40), stage + 2)) all.push({ ...x, who });
        }
      }
    }
  }

  it('is a large corpus that sweeps every exported builder', () => {
    expect(all.length).toBeGreaterThan(40_000);
    const exported = Object.keys(events).filter((k) => k.startsWith('build'));
    expect(exported.length).toBeGreaterThanOrEqual(17);
    for (const name of exported) expect(SWEPT, `${name} is not swept`).toContain(name);
  });

  it('no spoken square — in the words or in the bubble', () => {
    const bad = all.filter(({ e }) => hasSpokenSquare(e.text) || hasSpokenSquare(e.bubbleText));
    expect(bad.slice(0, 5).map(({ name, e, who }) => `${who} ${name}: ${e.text} | ${e.bubbleText}`)).toEqual([]);
  });

  it('no Latin — no notation in the words, none in the bubble', () => {
    const bad = all.filter(({ e }) => LATIN.test(e.text) || LATIN.test(e.bubbleText));
    expect(bad.slice(0, 5).map(({ name, e, who }) => `${who} ${name}: ${e.text} | ${e.bubbleText}`)).toEqual([]);
  });

  it('no «молодец», «умница», «так держать»', () => {
    const bad = all.filter(({ e }) => BANNED_PRAISE.test(e.text) || BANNED_PRAISE.test(e.bubbleText));
    expect(bad.slice(0, 5).map(({ name, e, who }) => `${who} ${name}: ${e.text}`)).toEqual([]);
  });

  it('the bubble says the same words as the voice (Cyrillic names are spoken as written)', () => {
    const differ = all.filter(({ e }) => e.bubbleText !== e.text);
    expect(differ.slice(0, 5).map(({ name, e }) => `${name}: ${e.text} | ${e.bubbleText}`)).toEqual([]);
  });

  it('a builder event carries no lesson `say` (the clip layer still plans its twin or its text)', () => {
    for (const { e } of all.slice(0, 5000)) expect(e.say).toBeUndefined();
  });
});

describe('outside the sweep, pinned so a change is noticed', () => {
  it('the teacher\'s strategy intro (words of ./strategy.ts) still names the first move\'s square', () => {
    const strategy = { strategyId: 'italian', titleRu: 'Итальянская партия', titleAccRu: 'Итальянскую партию', ideaRu: 'быстро выводим фигуры и целимся в слабую точку', lineSan: ['e4'] };
    const e = events.buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.rapid10, childColor: 'w', profile: profile(), coachStyle: 'teacher', strategy }, constRng(0));
    // the lesson never uses this path (lessonGameStart announces the theme); when ./strategy.ts drops the square, flip this
    expect(hasSpokenSquare(e.text)).toBe(true);
  });
});
