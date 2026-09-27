/**
 * Test-only fixtures for the coach module (imported by *.test.ts files, never by production code).
 * Judgements are derived from real positions with chess.js so that FEN / SAN / UCI stay consistent.
 */
import { Chess } from 'chess.js';
import type {
  AnalysisResult,
  Color,
  GameRecord,
  GameSummary,
  HangingPiece,
  MotifId,
  MoveClass,
  MoveJudgement,
  Persona,
  PositionFacts,
  StudentProfile,
} from '@gambit/shared';

export function profile(over: Partial<StudentProfile> = {}): StudentProfile {
  return {
    nickname: 'Миша',
    address: 'm',
    stage: 2,
    totals: { games: 5, wins: 2, losses: 2, draws: 1, puzzlesAttempted: 20, puzzlesSolved: 12, minutesPlayed: 90 },
    puzzleRating: { rating: 650, rd: 200, vol: 0.06, attempts: 20, solved: 12, lastSeen: null },
    themeSkills: {},
    recentAccuracy: [60, 70],
    weaknesses: [],
    strengths: [],
    bestWin: null,
    updatedAt: '2026-09-21T10:00:00.000Z',
    ...over,
  };
}

export const PERSONA: Persona = {
  id: 'petya',
  name: 'Петя',
  age: 6,
  nominalElo: 300,
  tagline: 'Только научился ходить фигурами',
  style: 'Часто зевает фигуры',
  avatar: { bg: '#FFE08A', skin: '#F6C7A0', hair: '#7A4B2A', hairStyle: 'short' },
  lines: { intro: ['Привет!'], onWin: ['Ура!'], onLose: ['Эх!'], onDraw: ['Ничья!'], onGoodMoveByChild: ['Ого!'] },
  recommendedFromStage: 1,
};

function toUci(m: { from: string; to: string; promotion?: string }): string {
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

export interface JudgementSpec {
  /** FEN before the child's move (default: start position after `setup` SAN moves) */
  fen?: string;
  setup?: string[];
  played: string;
  best: string;
  /** opponent's punishing line after `played`, SAN */
  refutation?: string[];
  over?: Partial<MoveJudgement>;
}

export function judgement(spec: JudgementSpec): MoveJudgement {
  const chess = spec.fen ? new Chess(spec.fen) : new Chess();
  for (const san of spec.setup ?? []) chess.move(san);
  const fenBefore = chess.fen();
  const color: Color = chess.turn();

  const bestMove = chess.move(spec.best);
  chess.undo();
  const played = chess.move(spec.played);
  const fenAfter = chess.fen();

  const refutationPvSan: string[] = [];
  const refutationPvUci: string[] = [];
  for (const san of spec.refutation ?? []) {
    const mv = chess.move(san);
    refutationPvSan.push(mv.san);
    refutationPvUci.push(toUci(mv));
  }

  return {
    ply: 5,
    color,
    san: played.san,
    uci: toUci(played),
    fenBefore,
    fenAfter,
    evalBefore: { cp: 30, mate: null },
    evalAfter: { cp: -600, mate: null },
    winPctBefore: 53,
    winPctAfter: 10,
    winPctLoss: 43,
    classification: 'blunder',
    accuracy: 12,
    bestUci: toUci(bestMove),
    bestSan: bestMove.san,
    bestPvSan: [bestMove.san],
    refutationPvSan,
    refutationPvUci,
    materialLossPawns: 0,
    confidence: 'confirmed',
    ...spec.over,
  };
}

/** 1.e4 e5 2.Qh5 Nc6 3.Qxe5+?? Nxe5 — the queen is simply lost. */
export function queenBlunder(over: Partial<MoveJudgement> = {}): MoveJudgement {
  return judgement({
    setup: ['e4', 'e5', 'Qh5', 'Nc6'],
    played: 'Qxe5+',
    best: 'Bc4',
    refutation: ['Nxe5'],
    over: { allowedMotif: 'hangingPiece', materialLossPawns: 8, ...over },
  });
}

/** Knight fork: …Nxc2+ wins the rook on a1. */
export const FORK_FEN = 'r3k2r/ppp2ppp/8/8/3n4/8/PPP2PPP/R3K2R w KQkq - 0 12';
export function forkBlunder(over: Partial<MoveJudgement> = {}): MoveJudgement {
  return judgement({
    fen: FORK_FEN,
    played: 'h3',
    best: 'O-O-O',
    refutation: ['Nxc2+', 'Kd2', 'Nxa1'],
    over: { allowedMotif: 'fork', materialLossPawns: 6, ...over },
  });
}

/** Back-rank mate: after Ra7?? comes …Re1#. */
export const BACK_RANK_FEN = '4r1k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 30';
export function backRankBlunder(over: Partial<MoveJudgement> = {}): MoveJudgement {
  return judgement({
    fen: BACK_RANK_FEN,
    played: 'Ra7',
    best: 'h3',
    refutation: ['Re1#'],
    over: {
      allowedMotif: 'backRankMate',
      evalAfter: { cp: null, mate: -1 },
      winPctAfter: 0,
      winPctLoss: 50,
      winPctBefore: 50,
      ...over,
    },
  });
}

/** The child finds the best move (a knight fork). */
export function bestMoveJudgement(motif: MotifId | undefined, over: Partial<MoveJudgement> = {}): MoveJudgement {
  return judgement({
    fen: 'r3k2r/ppp2ppp/8/8/3N4/8/PPP2PPP/R3K2R w KQkq - 0 12',
    played: 'Nb5',
    best: 'Nb5',
    refutation: ['O-O-O'],
    over: {
      classification: 'best',
      winPctBefore: 60,
      winPctAfter: 60,
      winPctLoss: 0,
      accuracy: 100,
      evalAfter: { cp: 80, mate: null },
      missedMotif: motif,
      ...over,
    },
  });
}

export function analysisOf(fen: string, bestSan: string, over: Partial<AnalysisResult> & { mate?: number | null } = {}): AnalysisResult {
  const chess = new Chess(fen);
  const mv = chess.move(bestSan);
  const uci = toUci(mv);
  const { mate = null, ...rest } = over;
  return {
    fen,
    lines: [{ multipv: 1, depth: 14, pvUci: [uci], cp: mate === null ? 50 : null, mate }],
    bestmove: uci,
    depth: 14,
    timeMs: 120,
    ...rest,
  };
}

export function facts(fen: string, over: Partial<PositionFacts> = {}): PositionFacts {
  const chess = new Chess(fen);
  return {
    fen,
    sideToMove: chess.turn(),
    phase: 'middlegame',
    inCheck: chess.isCheck(),
    legalMoveCount: chess.moves().length,
    material: { w: 30, b: 30, diff: 0 },
    hanging: [],
    development: { w: 2, b: 2 },
    castled: { w: false, b: false },
    canStillCastle: { w: true, b: true },
    centerControl: { w: 1, b: 1 },
    ...over,
  };
}

export function hanging(square: string, piece: HangingPiece['piece'], color: Color, seeLossCp: number, attackers: string[] = []): HangingPiece {
  return { square, piece, color, attackers, defenders: [], seeLossCp };
}

export function counts(over: Partial<Record<MoveClass, number>> = {}): Record<MoveClass, number> {
  return { best: 6, excellent: 3, good: 8, inaccuracy: 2, mistake: 1, blunder: 1, missedWin: 0, ...over };
}

export function summary(over: Partial<GameSummary> = {}): GameSummary {
  return {
    accuracy: 71.4,
    acpl: 55,
    counts: counts(),
    takebacksOffered: 1,
    takebacksAccepted: 1,
    hintsUsed: 1,
    motifsMissed: [],
    motifsAllowed: ['fork'],
    keyMoments: [],
    ...over,
  };
}

export function gameRecord(over: Partial<GameRecord> = {}): GameRecord {
  const j = forkBlunder();
  return {
    id: 'g1',
    startedAt: '2026-09-21T09:30:00.000Z',
    endedAt: '2026-09-21T09:45:00.000Z',
    personaId: 'petya',
    timeControlId: 'rapid10',
    childColor: 'w',
    result: '0-1',
    termination: 'checkmate',
    pgn: '1. e4 e5 *',
    events: [],
    judgements: [j],
    summary: summary({
      keyMoments: [
        {
          ply: j.ply,
          fenBefore: j.fenBefore,
          playedSan: j.san,
          bestSan: j.bestSan,
          classification: 'blunder',
          motif: 'fork',
          explanation: '',
        },
      ],
    }),
    examMode: false,
    ...over,
  };
}

/** Deterministic rng values covering every variant of pools up to ~12 entries. */
export const RNG_SWEEP: readonly number[] = Array.from({ length: 24 }, (_, i) => i / 24);

export function constRng(value: number): () => number {
  return () => value;
}

/** A simple deterministic LCG for "many random events" tests. */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export const ALL_MOTIFS: readonly MotifId[] = [
  'hangingPiece',
  'freeCapture',
  'badTrade',
  'fork',
  'pin',
  'skewer',
  'discoveredAttack',
  'doubleCheck',
  'removeDefender',
  'trappedPiece',
  'backRankMate',
  'mateIn1',
  'mateIn2',
  'mateIn3',
  'promotion',
  'kingSafety',
  'development',
  'center',
];
