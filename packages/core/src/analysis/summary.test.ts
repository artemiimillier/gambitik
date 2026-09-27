import { describe, expect, it } from 'vitest';
import type { EvalScore, GameEvent, MoveClass, MoveJudgement } from '@gambit/shared';
import { gameAccuracy, moveAccuracy, winPct } from './eval.ts';
import { summarizeGame, takebackOutcomes } from './summary.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const cp = (value: number): EvalScore => ({ cp: value, mate: null });

function judgement(ply: number, classification: MoveClass, before: EvalScore, after: EvalScore, extra: Partial<MoveJudgement> = {}): MoveJudgement {
  const winPctBefore = winPct(before);
  const winPctAfter = winPct(after);
  return {
    ply,
    color: 'w',
    san: 'e4',
    uci: 'e2e4',
    fenBefore: START,
    fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    evalBefore: before,
    evalAfter: after,
    winPctBefore,
    winPctAfter,
    winPctLoss: Math.max(0, winPctBefore - winPctAfter),
    classification,
    accuracy: moveAccuracy(winPctBefore, winPctAfter),
    bestUci: 'e2e4',
    bestSan: 'e4',
    bestPvSan: ['e4'],
    refutationPvSan: [],
    refutationPvUci: [],
    materialLossPawns: 0,
    confidence: 'quick',
    ...extra,
  };
}

/** 3.Qg5?? — the queen is simply taken. */
const queenHang = judgement(5, 'blunder', cp(40), cp(-900), {
  san: 'Qg5',
  uci: 'h5g5',
  fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3',
  fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p1Q1/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 3 3',
  bestUci: 'g1f3',
  bestSan: 'Nf3',
  refutationPvUci: ['d8g5', 'g1f3', 'g5g6'],
  refutationPvSan: ['Qxg5', 'Nf3', 'Qg6'],
  allowedMotif: 'hangingPiece',
  materialLossPawns: 9,
  confidence: 'confirmed',
});

/** A knight fork that the child found (best move). */
const foundFork = judgement(21, 'best', cp(300), cp(300), {
  san: 'Nc7+',
  uci: 'd5c7',
  fenBefore: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 11',
  fenAfter: 'r3k3/2N5/8/8/8/8/8/4K3 b - - 1 11',
  bestUci: 'd5c7',
  bestSan: 'Nc7+',
  refutationPvUci: ['e8d7', 'c7a8'],
  refutationPvSan: ['Kd7', 'Nxa8'],
});

const events: GameEvent[] = [
  { t: 0, type: 'gameStart', data: {} },
  { t: 9000, type: 'takebackOffered', ply: 5, data: {} },
  { t: 12000, type: 'hintRequested', ply: 5, data: {} },
  { t: 12500, type: 'hintGiven', ply: 5, data: { level: 1 } },
  { t: 15000, type: 'takebackAccepted', ply: 5, data: {} },
  { t: 40000, type: 'takebackOffered', ply: 13, data: {} },
  { t: 41000, type: 'takebackDeclined', ply: 13, data: {} },
  { t: 90000, type: 'gameEnd', data: {} },
];

describe('summarizeGame', () => {
  it('summarises an empty game without dividing by zero', () => {
    const s = summarizeGame({ judgements: [], events: [] });
    expect(s).toEqual({
      accuracy: 0,
      acpl: 0,
      counts: { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, missedWin: 0 },
      takebacksOffered: 0,
      takebacksAccepted: 0,
      hintsUsed: 0,
      motifsMissed: [],
      motifsAllowed: [],
      keyMoments: [],
    });
  });

  it('counts classes, accuracy, acpl and journal statistics', () => {
    const judgements = [
      judgement(1, 'best', cp(20), cp(20)),
      judgement(3, 'good', cp(30), cp(0)),
      queenHang,
      judgement(7, 'inaccuracy', cp(-900), cp(-1500)), // capped at −1000 for the ACPL
      foundFork,
    ];
    const s = summarizeGame({ judgements, events, openingName: 'Дебют ферзевой пешки' });
    expect(s.counts).toEqual({ best: 2, excellent: 0, good: 1, inaccuracy: 1, mistake: 0, blunder: 1, missedWin: 0 });
    expect(s.acpl).toBe(Math.round((0 + 30 + 940 + 100 + 0) / 5));
    expect(s.accuracy).toBe(Math.round(gameAccuracy(judgements) * 10) / 10);
    expect(s.accuracy).toBeGreaterThan(0);
    expect(s.accuracy).toBeLessThan(100);
    expect(s.takebacksOffered).toBe(2);
    expect(s.takebacksAccepted).toBe(1);
    expect(s.hintsUsed).toBe(1);
    expect(s.openingName).toBe('Дебют ферзевой пешки');
    expect(s.motifsAllowed).toEqual(['hangingPiece']);
    expect(s.motifsMissed).toEqual([]);
  });

  it('falls back to hintRequested when the journal has no hintGiven events', () => {
    const onlyRequests = events.filter((e) => e.type !== 'hintGiven');
    expect(summarizeGame({ judgements: [], events: onlyRequests }).hintsUsed).toBe(1);
  });

  it('a taken-back attempt does not count as a move but its motif is remembered', () => {
    const retry = judgement(5, 'best', cp(40), cp(40), { san: 'Nf3', uci: 'g1f3' });
    const s = summarizeGame({ judgements: [judgement(1, 'best', cp(20), cp(20)), queenHang, retry], events });
    expect(s.counts.blunder).toBe(0);
    expect(s.counts.best).toBe(2);
    expect(s.accuracy).toBe(100);
    expect(s.keyMoments.filter((m) => m.ply === 5)).toEqual([]);
    expect(s.motifsAllowed).toEqual(['hangingPiece']);
  });

  it('picks at most three instructive errors (concrete ones first) plus one proud moment, in game order', () => {
    const vague = (ply: number, after: number) => judgement(ply, 'mistake', cp(50), cp(after));
    const judgements = [
      judgement(1, 'best', cp(20), cp(20)),
      vague(3, -80),
      queenHang,
      vague(9, -90),
      judgement(11, 'mistake', cp(100), cp(-60), { missedMotif: 'fork', bestSan: 'Nc7+' }),
      vague(13, -70),
      foundFork,
      judgement(23, 'missedWin', { cp: null, mate: 2 }, cp(30), { missedMotif: 'mateIn2', bestSan: 'Qh7+' }),
    ];
    const s = summarizeGame({ judgements, events: [] });
    expect(s.keyMoments.map((m) => m.ply)).toEqual([5, 11, 21, 23]);

    const [hang, fork, proud, missedMate] = s.keyMoments;
    expect(hang).toMatchObject({ playedSan: 'Qg5', bestSan: 'Nf3', classification: 'blunder', motif: 'hangingPiece' });
    expect(hang?.explanation).toBe('Ферзь остался под боем — соперник мог его забрать.');
    expect(fork).toMatchObject({ classification: 'mistake', motif: 'fork' });
    expect(fork?.explanation).toContain('вилка');
    expect(proud).toMatchObject({ playedSan: 'Nc7+', classification: 'best', motif: 'fork' });
    expect(proud?.explanation).toContain('вилка');
    expect(missedMate).toMatchObject({ classification: 'missedWin', motif: 'mateIn2' });
    expect(missedMate?.explanation).toContain('мат в два хода');

    expect(s.motifsMissed.sort()).toEqual(['fork', 'mateIn2']);
  });

  it('explanations are Russian, short, free of notation and never blaming', () => {
    const judgements = [
      queenHang,
      judgement(9, 'mistake', cp(50), cp(-90), { materialLossPawns: 3 }),
      judgement(13, 'inaccuracy', cp(50), cp(-10)),
      judgement(15, 'missedWin', cp(700), cp(50)),
    ];
    const s = summarizeGame({ judgements, events: [], stage: 6 });
    const texts = [
      ...s.keyMoments.map((m) => m.explanation),
      ...summarizeGame({ judgements: judgements.slice(1), events: [], stage: 6 }).keyMoments.map((m) => m.explanation),
    ];
    expect(texts.length).toBeGreaterThanOrEqual(6);
    for (const text of texts) {
      expect(text).toMatch(/[а-яё]/i);
      expect(text).not.toMatch(/[a-h][1-8]|[KQRBN]x?[a-h]/);
      expect(text).not.toMatch(/глуп|плох|ужас|зевнул|опять|снова ошиб/i);
      expect(text.length).toBeLessThanOrEqual(110);
    }
  });

  it('ranks the most frequent motifs first', () => {
    const allowed = (ply: number, motif: MoveJudgement['allowedMotif']) => judgement(ply, 'mistake', cp(50), cp(-100), { allowedMotif: motif });
    const s = summarizeGame({ judgements: [allowed(1, 'pin'), allowed(3, 'fork'), allowed(5, 'fork'), judgement(7, 'good', cp(0), cp(-20), { allowedMotif: 'skewer' })], events: [] });
    expect(s.motifsAllowed).toEqual(['fork', 'pin']); // the motif of a fine move is ignored
  });

  it('an inaccuracy is a key moment only from stage 5 (errors above the level stay silent)', () => {
    const judgements = [judgement(13, 'inaccuracy', cp(50), cp(-10)), judgement(15, 'mistake', cp(50), cp(-150))];
    expect(summarizeGame({ judgements, events: [] }).keyMoments.map((m) => m.ply)).toEqual([15]);
    expect(summarizeGame({ judgements, events: [], stage: 4 }).keyMoments.map((m) => m.ply)).toEqual([15]);
    expect(summarizeGame({ judgements, events: [], stage: 5 }).keyMoments.map((m) => m.ply)).toEqual([13, 15]);
  });

  it('the fallback explanation is a neutral fact that still reads well once the better move was found', () => {
    const s = summarizeGame({ judgements: [judgement(15, 'mistake', cp(50), cp(-150))], events: [] });
    expect(s.keyMoments[0]?.explanation).toBe('Другой ход давал позицию покрепче.');
  });

  it('a take-back the child asked for is not an accepted offer', () => {
    const s = summarizeGame({
      judgements: [],
      events: [
        { t: 1, type: 'takebackAccepted', ply: 3, data: { voluntary: true } },
        { t: 2, type: 'takebackOffered', ply: 5, data: {} },
        { t: 3, type: 'takebackAccepted', ply: 5, data: {} },
      ],
    });
    expect(s.takebacksOffered).toBe(1);
    expect(s.takebacksAccepted).toBe(1);
  });
});

describe('takebackOutcomes', () => {
  const accepted = (ply: number, uci: string, data: Record<string, unknown> = {}): GameEvent => ({ t: 1, type: 'takebackAccepted', ply, data: { uci, san: 'Qg5', ...data } });
  const better = judgement(5, 'good', cp(40), cp(10), { san: 'Nf3', uci: 'g1f3' });

  it('improved: a different move with a smaller loss stayed on the board', () => {
    expect(takebackOutcomes([queenHang, better], [accepted(5, 'h5g5')])).toEqual([
      { ply: 5, attemptUci: 'h5g5', attemptSan: 'Qg5', voluntary: false, finalUci: 'g1f3', finalSan: 'Nf3', known: true, changed: true, improved: true },
    ]);
  });

  it('the very same blunder replayed is neither changed nor improved', () => {
    const again = { ...queenHang };
    const [outcome] = takebackOutcomes([queenHang, again], [accepted(5, 'h5g5')]);
    expect(outcome).toMatchObject({ known: true, changed: false, improved: false });
  });

  it('another move that loses even more is changed, not improved', () => {
    const worse = judgement(5, 'blunder', cp(40), cp(-2000), { san: 'Qxf7+', uci: 'h5f7' });
    expect(takebackOutcomes([queenHang, worse], [accepted(5, 'h5g5')])[0]).toMatchObject({ known: true, changed: true, improved: false });
  });

  it('unknown when the retry was never judged (game ended, engine hiccup)', () => {
    expect(takebackOutcomes([queenHang], [accepted(5, 'h5g5', { voluntary: true })])[0]).toMatchObject({ known: false, changed: false, improved: false, voluntary: true });
  });
});
