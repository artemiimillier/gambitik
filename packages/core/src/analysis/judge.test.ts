import { describe, expect, it } from 'vitest';
import type { AnalysisResult, AnalyzeOptions, EngineLine, IJudgeEngine } from '@gambit/shared';
import { judgeMove } from './judge.ts';
import { winPct } from './eval.ts';

// ───────────────────────── scripted fake engine ─────────────────────────

interface Call {
  fen: string;
  opts: AnalyzeOptions;
}

type Script = (fen: string, opts: AnalyzeOptions) => EngineLine[] | Error;

function line(multipv: number, depth: number, score: { cp?: number; mate?: number }, pvUci: string[]): EngineLine {
  return { multipv, depth, cp: score.mate === undefined ? (score.cp ?? 0) : null, mate: score.mate ?? null, pvUci };
}

function result(fen: string, lines: EngineLine[]): AnalysisResult {
  return { fen, lines, bestmove: lines[0]?.pvUci[0] ?? '(none)', depth: lines[0]?.depth ?? 0, timeMs: 5 };
}

function fakeEngine(script: Script): IJudgeEngine & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ready: async () => undefined,
    analyze: async (fen, opts) => {
      calls.push({ fen, opts });
      const out = script(fen, opts);
      if (out instanceof Error) throw out;
      return result(fen, out);
    },
    stop: () => undefined,
    dispose: () => undefined,
  };
}

// ───────────────────────── fixtures ─────────────────────────

/** 1.e4 e5 2.Qh5 Nc6 — White to move. 3.Qg5?? hangs the queen to ...Qxg5. */
const FEN_BEFORE = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3';
const FEN_AFTER_QG5 = 'r1bqkbnr/pppp1ppp/2n5/4p1Q1/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 3 3';

const beforeLines = (depth: number, cpShift = 0): EngineLine[] => [
  line(1, depth, { cp: 40 + cpShift }, ['g1f3', 'g8f6', 'h5h4']),
  line(2, depth, { cp: 25 + cpShift }, ['b1c3', 'g8f6', 'h5h4']),
  line(3, depth, { cp: 10 + cpShift }, ['f1c4', 'g7g6', 'h5f3']),
];

const queenBlunderScript: Script = (fen, opts) => {
  const depth = opts.depth ?? 0;
  if (fen === FEN_BEFORE) return opts.multipv === 3 ? beforeLines(depth) : [line(1, depth, { cp: 45 }, ['g1f3', 'g8f6', 'h5h4'])];
  if (fen === FEN_AFTER_QG5) return [line(1, depth, { cp: depth >= 16 ? 905 : 880 }, ['d8g5', 'g1f3', 'g5g6'])];
  return new Error(`unexpected fen ${fen}`);
};

describe('judgeMove', () => {
  it('blunder that hangs the queen → blunder, confirmed, material loss, hangingPiece', async () => {
    const engine = fakeEngine(queenBlunderScript);
    const j = await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'h5g5', ply: 5 });

    expect(j.classification).toBe('blunder');
    expect(j.confidence).toBe('confirmed');
    expect(j.materialLossPawns).toBeGreaterThanOrEqual(8);
    expect(j.materialLossPawns).toBe(9);
    expect(j.allowedMotif).toBe('hangingPiece');
    expect(j.missedMotif).toBeUndefined();

    expect(j).toMatchObject({
      ply: 5,
      color: 'w',
      san: 'Qg5',
      uci: 'h5g5',
      fenBefore: FEN_BEFORE,
      fenAfter: FEN_AFTER_QG5,
      bestUci: 'g1f3',
      bestSan: 'Nf3',
      bestPvSan: ['Nf3', 'Nf6', 'Qh4'],
      refutationPvUci: ['d8g5', 'g1f3', 'g5g6'],
      refutationPvSan: ['Qxg5', 'Nf3', 'Qg6'],
      // numbers come from the confirmation search, mover POV
      evalBefore: { cp: 45, mate: null },
      evalAfter: { cp: -905, mate: null },
    });
    expect(j.winPctBefore).toBeCloseTo(winPct({ cp: 45, mate: null }), 10);
    expect(j.winPctAfter).toBeCloseTo(winPct({ cp: -905, mate: null }), 10);
    expect(j.winPctLoss).toBeCloseTo(j.winPctBefore - j.winPctAfter, 10);
    expect(j.winPctLoss).toBeGreaterThan(45);
    expect(j.accuracy).toBeLessThan(15);

    expect(engine.calls.map((c) => [c.fen === FEN_BEFORE ? 'before' : 'after', c.opts.depth, c.opts.multipv])).toEqual([
      ['before', 12, 3],
      ['after', 12, 1],
      ['before', 16, 1],
      ['after', 16, 1],
    ]);
  });

  it('best move → best, one engine call, refutation = rest of the best line', async () => {
    const engine = fakeEngine(queenBlunderScript);
    const j = await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'g1f3', ply: 5 });
    expect(j.classification).toBe('best');
    expect(j.confidence).toBe('quick');
    expect(j.winPctLoss).toBe(0);
    expect(j.accuracy).toBe(100);
    expect(j.bestUci).toBe('g1f3');
    expect(j.evalBefore).toEqual({ cp: 40, mate: null });
    expect(j.evalAfter).toEqual({ cp: 40, mate: null });
    expect(j.refutationPvUci).toEqual(['g8f6', 'h5h4']);
    expect(j.refutationPvSan).toEqual(['Nf6', 'Qh4']);
    expect(j.materialLossPawns).toBe(0);
    expect(j.allowedMotif).toBeUndefined();
    expect(engine.calls).toHaveLength(1);
  });

  it('a second-line move is scored from the same MultiPV search', async () => {
    const engine = fakeEngine(queenBlunderScript);
    const j = await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'f1c4', ply: 5 });
    expect(engine.calls).toHaveLength(1);
    expect(j.evalAfter).toEqual({ cp: 10, mate: null });
    expect(j.winPctLoss).toBeCloseTo(winPct({ cp: 40, mate: null }) - winPct({ cp: 10, mate: null }), 10);
    expect(j.classification).toBe('good');
    expect(j.bestSan).toBe('Nf3');
  });

  describe('cachedBefore', () => {
    const cached = (depth: number, lines = beforeLines(depth), fen = FEN_BEFORE): AnalysisResult => result(fen, lines);

    it('is reused when it matches: no engine call at all for a cached move', async () => {
      const engine = fakeEngine(queenBlunderScript);
      const j = await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'g1f3', ply: 5, cachedBefore: cached(14) });
      expect(engine.calls).toHaveLength(0);
      expect(j.classification).toBe('best');
    });

    it('accepts depth ≥ quickDepth − 2 and ignores move counters in the FEN', async () => {
      const engine = fakeEngine(queenBlunderScript);
      const sameButCounters = FEN_BEFORE.replace(' 2 3', ' 0 9');
      await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'b1c3', ply: 5, cachedBefore: cached(10, beforeLines(10), sameButCounters) });
      expect(engine.calls).toHaveLength(0);
    });

    it('is ignored when too shallow, for another position, with a single line, or with an illegal best move', async () => {
      const otherFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const variants: AnalysisResult[] = [
        cached(9),
        cached(14, beforeLines(14), otherFen),
        cached(14, beforeLines(14).slice(0, 1)),
        cached(14, [line(1, 14, { cp: 40 }, ['e2e5']), ...beforeLines(14).slice(1)]),
      ];
      for (const cachedBefore of variants) {
        const engine = fakeEngine(queenBlunderScript);
        await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'g1f3', ply: 5, cachedBefore });
        expect(engine.calls.map((c) => [c.opts.depth, c.opts.multipv])).toEqual([[12, 3]]);
      }
    });

    it('a deep cache makes the "before" confirmation search unnecessary', async () => {
      const engine = fakeEngine(queenBlunderScript);
      const j = await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'h5g5', ply: 5, cachedBefore: cached(18) });
      expect(j.confidence).toBe('confirmed');
      expect(engine.calls.map((c) => [c.fen === FEN_BEFORE ? 'before' : 'after', c.opts.depth])).toEqual([
        ['after', 12],
        ['after', 16],
      ]);
    });
  });

  it('downgrades with the deeper numbers when the confirmation clears the move', async () => {
    const afterH3 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/7P/PPPP1PP1/RNB1KBNR b KQkq - 0 3';
    const engine = fakeEngine((fen, opts) => {
      const depth = opts.depth ?? 0;
      if (fen === FEN_BEFORE) return opts.multipv === 3 ? beforeLines(depth) : [line(1, depth, { cp: 30 }, ['g1f3', 'g8f6'])];
      if (fen === afterH3) return [line(1, depth, { cp: depth >= 16 ? -5 : 260 }, ['g8f6', 'h5f3'])];
      return new Error('unexpected');
    });
    const j = await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'h2h3', ply: 5 });
    expect(engine.calls).toHaveLength(4);
    expect(j.confidence).toBe('quick');
    expect(j.evalBefore).toEqual({ cp: 30, mate: null });
    expect(j.evalAfter).toEqual({ cp: 5, mate: null });
    expect(j.classification).toBe('good');
    expect(j.allowedMotif).toBeUndefined();
  });

  it('when the deeper search prefers the played move it becomes best', async () => {
    const afterH3 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/7P/PPPP1PP1/RNB1KBNR b KQkq - 0 3';
    const engine = fakeEngine((fen, opts) => {
      const depth = opts.depth ?? 0;
      if (fen === FEN_BEFORE) return opts.multipv === 3 ? beforeLines(depth) : [line(1, depth, { cp: 35 }, ['h2h3', 'g8f6', 'h5f3'])];
      if (fen === afterH3) return [line(1, depth, { cp: 300 }, ['g8f6', 'h5f3'])];
      return new Error('unexpected');
    });
    const j = await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'h2h3', ply: 5 });
    expect(j.classification).toBe('best');
    expect(j.bestUci).toBe('h2h3');
    expect(j.winPctLoss).toBe(0);
    expect(j.confidence).toBe('quick');
    expect(j.refutationPvUci).toEqual(['g8f6', 'h5f3']);
  });

  it('keeps the quick verdict (never "confirmed") when the confirmation search fails', async () => {
    const engine = fakeEngine((fen, opts) => ((opts.depth ?? 0) >= 16 ? new Error('superseded by stop()') : queenBlunderScript(fen, opts)));
    const j = await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'h5g5', ply: 5 });
    expect(j.classification).toBe('blunder');
    expect(j.confidence).toBe('quick');
    expect(j.evalAfter).toEqual({ cp: -880, mate: null });
  });

  it('honours custom depths', async () => {
    const engine = fakeEngine(queenBlunderScript);
    await judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'h5g5', ply: 5, quickDepth: 8, confirmDepth: 20 });
    expect(engine.calls.map((c) => c.opts.depth)).toEqual([8, 8, 20, 20]);
  });

  it('delivering checkmate is best and confirmed without asking the engine', async () => {
    const engine = fakeEngine(() => new Error('must not be called'));
    const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'h5f7', ply: 7 });
    expect(engine.calls).toHaveLength(0);
    expect(j).toMatchObject({
      san: 'Qxf7#',
      classification: 'best',
      confidence: 'confirmed',
      evalBefore: { cp: null, mate: 1 },
      evalAfter: { cp: null, mate: 1 },
      winPctLoss: 0,
      accuracy: 100,
      bestUci: 'h5f7',
      bestSan: 'Qxf7#',
      refutationPvUci: [],
      materialLossPawns: 0,
    });
  });

  it('stalemating a won position: eval 0.00 after, missed mate, never analyses the final position', async () => {
    const fen = '7k/5K2/8/6Q1/8/8/8/8 w - - 0 1';
    const engine = fakeEngine((f, opts) => (f === fen ? [line(1, opts.depth ?? 0, { mate: 1 }, ['g5g7'])] : new Error('terminal position analysed')));
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'g5g6', ply: 99 });
    expect(j.evalBefore).toEqual({ cp: null, mate: 1 });
    expect(j.evalAfter).toEqual({ cp: 0, mate: null });
    expect(j.winPctAfter).toBe(50);
    expect(j.classification).toBe('missedWin');
    expect(j.confidence).toBe('confirmed');
    expect(j.missedMotif).toBe('mateIn1');
    expect(j.bestSan).toBe('Qg7#');
    expect(j.refutationPvUci).toEqual([]);
    expect(engine.calls.every((c) => c.fen === fen)).toBe(true);
  });

  it('a single legal move is best by definition (one-line cache accepted)', async () => {
    const fen = '4k3/8/8/8/8/2q5/7r/K7 w - - 0 1';
    const engine = fakeEngine(() => new Error('must not be called'));
    const cachedBefore = result(fen, [line(1, 15, { mate: -4 }, ['a1b1', 'c3b2'])]);
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'a1b1', ply: 60, cachedBefore });
    expect(engine.calls).toHaveLength(0);
    expect(j.classification).toBe('best');
    expect(j.evalBefore).toEqual({ cp: null, mate: -4 });
    expect(j.winPctLoss).toBe(0);
  });

  it('walking into mate: MateCreated → blunder with the mate motif (mover POV mate < 0)', async () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2';
    const after = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';
    const engine = fakeEngine((f, opts) => {
      const depth = opts.depth ?? 0;
      if (f === fen) return [line(1, depth, { cp: -35 }, ['e2e4', 'b8c6']), line(2, depth, { cp: -60 }, ['b1c3', 'b8c6'])];
      if (f === after) return [line(1, depth, { mate: 1 }, ['d8h4'])];
      return new Error('unexpected');
    });
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'g2g4', ply: 3 });
    expect(j.evalAfter).toEqual({ cp: null, mate: -1 });
    expect(j.classification).toBe('blunder');
    expect(j.confidence).toBe('confirmed');
    expect(j.allowedMotif).toBe('mateIn1');
    expect(j.refutationPvSan).toEqual(['Qh4#']);
    expect(j.materialLossPawns).toBe(0);
  });

  it('labels a losing capture with the more valuable piece as badTrade', async () => {
    const fen = '4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1';
    const after = '4k3/8/4p3/3Q4/8/8/8/4K3 b - - 0 1';
    const engine = fakeEngine((f, opts) => {
      const depth = opts.depth ?? 0;
      if (f === fen) return [line(1, depth, { cp: 60 }, ['e1e2', 'e8e7']), line(2, depth, { cp: 50 }, ['d1d4', 'e8e7'])];
      if (f === after) return [line(1, depth, { cp: 300 }, ['e6d5'])];
      return new Error('unexpected');
    });
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'd1d5', ply: 41 });
    expect(j.san).toBe('Qxd5');
    expect(j.allowedMotif).toBe('badTrade');
    // a queen for a pawn: 9 lost, 1 won by the capture itself
    expect(j.materialLossPawns).toBe(8);
    expect(j.classification).toBe('blunder');
  });

  describe('trades: what the played move captured is netted out', () => {
    it('an even queen trade instead of mate in one stays a missedWin: no material lost, no hangingPiece', async () => {
      const fen = '1n3rk1/5ppp/3p4/4q2Q/8/3B4/5PPP/R5K1 w - - 0 1';
      const after = '1n3rk1/5ppp/3p4/4Q3/8/3B4/5PPP/R5K1 b - - 0 1';
      const engine = fakeEngine((f, opts) => {
        const depth = opts.depth ?? 0;
        if (f === fen) return [line(1, depth, { mate: 1 }, ['h5h7'])];
        if (f === after) return [line(1, depth, { cp: -20 }, ['d6e5', 'a1a7', 'b8c6'])];
        return new Error(`unexpected ${f}`);
      });
      const j = await judgeMove(engine, { fenBefore: fen, uci: 'h5e5', ply: 41 });
      expect(j.san).toBe('Qxe5');
      expect(j.refutationPvSan[0]).toBe('dxe5');
      expect(j.classification).toBe('missedWin');
      expect(j.materialLossPawns).toBe(0);
      expect(j.allowedMotif).toBeUndefined();
      expect(j.missedMotif).toBe('mateIn1');
    });

    it('a favourable trade (bishop takes queen, gets recaptured) loses no material even when it is the best move', async () => {
      const fen = '4k3/6p1/5q2/8/3B4/8/8/4K3 w - - 0 1';
      const engine = fakeEngine((f, opts) =>
        f === fen
          ? [line(1, opts.depth ?? 0, { cp: 550 }, ['d4f6', 'g7f6', 'e1e2']), line(2, opts.depth ?? 0, { cp: -800 }, ['e1e2', 'f6d4'])]
          : new Error('unexpected'),
      );
      const j = await judgeMove(engine, { fenBefore: fen, uci: 'd4f6', ply: 41 });
      expect(j.classification).toBe('best');
      expect(j.refutationPvSan[0]).toBe('gxf6');
      expect(j.materialLossPawns).toBe(0);
      expect(j.allowedMotif).toBeUndefined();
    });

    it('an even en-passant trade is not a hanging pawn', async () => {
      const fen = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
      const after = 'rnbqkbnr/ppp1p1pp/5P2/3p4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3';
      const engine = fakeEngine((f, opts) => {
        const depth = opts.depth ?? 0;
        if (f === fen) return [line(1, depth, { cp: 140 }, ['d2d4', 'e7e6']), line(2, depth, { cp: 120 }, ['g1f3', 'e7e6'])];
        if (f === after) return [line(1, depth, { cp: 60 }, ['g8f6', 'd2d4', 'e7e6'])];
        return new Error(`unexpected ${f}`);
      });
      const j = await judgeMove(engine, { fenBefore: fen, uci: 'e5f6', ply: 5 });
      expect(j.san).toBe('exf6');
      expect(j.winPctLoss).toBeGreaterThanOrEqual(5);
      expect(j.refutationPvSan[0]).toBe('Nxf6');
      expect(j.materialLossPawns).toBe(0);
      expect(j.allowedMotif).toBeUndefined();
    });

    it('a promotion that is captured at once costs the pawn, not a queen', async () => {
      const fen = '3r2k1/4P3/8/8/8/8/6K1/8 w - - 0 1';
      const after = '3rQ1k1/8/8/8/8/8/6K1/8 b - - 0 1';
      const engine = fakeEngine((f, opts) => {
        const depth = opts.depth ?? 0;
        if (f === fen) return [line(1, depth, { cp: 300 }, ['e7d8q', 'g8g7']), line(2, depth, { cp: -480 }, ['g2f3', 'd8e8'])];
        if (f === after) return [line(1, depth, { cp: 520 }, ['d8e8'])];
        return new Error(`unexpected ${f}`);
      });
      const j = await judgeMove(engine, { fenBefore: fen, uci: 'e7e8q', ply: 81 });
      expect(j.materialLossPawns).toBe(1);
    });
  });

  it('a pawn grabbed at the start of a mating attack is not labelled "hanging pawn"', async () => {
    const fen = '5rk1/p4ppp/3b4/1p2p1P1/p3B3/1n2P1P1/1PqP1PK1/1N1Q3R b - - 0 21';
    const after = '5rk1/p4ppp/3b4/1p2p1P1/p3B3/1n2P1P1/1P1P1PK1/1NqQ3R w - - 1 22';
    const engine = fakeEngine((f, opts) => {
      const depth = opts.depth ?? 0;
      if (f === fen) return [line(1, depth, { cp: 250 }, ['g7g6', 'c1b2']), line(2, depth, { cp: 200 }, ['f7f5', 'g5f6'])];
      if (f === after) return [line(1, depth, { mate: 5 }, ['e4h7', 'g8h8', 'h7e4', 'h8g8', 'h1h8'])];
      return new Error(`unexpected ${f}`);
    });
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'c2c1', ply: 42 });
    expect(j.refutationPvSan[0]).toBe('Bxh7+');
    expect(j.materialLossPawns).toBe(1);
    expect(j.evalAfter).toEqual({ cp: null, mate: -5 });
    expect(j.classification).toBe('blunder');
    expect(j.allowedMotif).toBeUndefined();
  });

  it('a repetition that ends the game as a draw is judged like stalemate (the FEN alone cannot show it)', async () => {
    const fen = '7k/8/5K2/6Q1/8/8/8/8 w - - 10 40';
    const engine = fakeEngine((f, opts) => (f === fen ? [line(1, opts.depth ?? 0, { mate: 2 }, ['f6f7', 'h8h7', 'g5g7'])] : new Error('final position analysed')));
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'g5g4', ply: 79, drawnByRepetition: true });
    expect(j.evalAfter).toEqual({ cp: 0, mate: null });
    expect(j.classification).toBe('missedWin');
    expect(j.winPctLoss).toBeGreaterThan(40);
    expect(j.refutationPvUci).toEqual([]);
  });

  it('repetition: the engine\'s own first choice may be the repeating move — the best OTHER move is the real best', async () => {
    const fen = '7k/8/5K2/6Q1/8/8/8/8 w - - 10 40';
    // MultiPV search: the repeating check comes first (the engine sees only the FEN), a mate in two second
    const multi = fakeEngine((f, opts) =>
      f === fen ? [line(1, opts.depth ?? 0, { mate: 2 }, ['g5g4', 'h8h7', 'g4g7']), line(2, opts.depth ?? 0, { mate: 2 }, ['f6f7', 'h8h7', 'g5g7'])] : new Error('final position analysed'),
    );
    const j = await judgeMove(multi, { fenBefore: fen, uci: 'g5g4', ply: 79, drawnByRepetition: true });
    expect(j.bestUci).toBe('f6f7');
    expect(j.bestSan).toBe('Kf7');
    expect(j.classification).toBe('missedWin');
    expect(j.winPctLoss).toBeGreaterThan(40);

    // single-line searches: one more search restricted to the other moves finds the alternative
    const single = fakeEngine((f, opts) => {
      if (f !== fen) return new Error('final position analysed');
      if (opts.searchmoves) {
        expect(opts.searchmoves).not.toContain('g5g4');
        return [line(1, opts.depth ?? 0, { mate: 2 }, ['f6f7', 'h8h7', 'g5g7'])];
      }
      return [line(1, opts.depth ?? 0, { mate: 2 }, ['g5g4', 'h8h7', 'g4g7'])];
    });
    const k = await judgeMove(single, { fenBefore: fen, uci: 'g5g4', ply: 79, drawnByRepetition: true });
    expect(k.bestUci).toBe('f6f7');
    expect(k.classification).toBe('missedWin');

    // a repetition that SAVES a lost game is a fine move, not a blunder
    const lost = '3r3k/3r4/8/8/8/8/8/K1Q5 w - - 10 40';
    const saving = fakeEngine((f, opts) => (f === lost ? [line(1, opts.depth ?? 0, { cp: -900 }, ['c1b1']), line(2, opts.depth ?? 0, { cp: -950 }, ['c1c3'])] : new Error('final position analysed')));
    const s = await judgeMove(saving, { fenBefore: lost, uci: 'c1b1', ply: 79, drawnByRepetition: true });
    expect(s.winPctLoss).toBe(0);
    expect(['best', 'excellent']).toContain(s.classification);
  });

  it('a "missed win" that drops material is re-labelled as a blunder; a real one stays missedWin', async () => {
    const fen = '4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1';
    const afterCapture = '4k3/8/4p3/3Q4/8/8/8/4K3 b - - 0 1';
    const afterQuiet = '4k3/8/4p3/3p4/8/8/3Q4/4K3 b - - 1 1';
    const engine = fakeEngine((f, opts) => {
      const depth = opts.depth ?? 0;
      if (f === fen) return [line(1, depth, { cp: 750 }, ['e1e2', 'e8e7']), line(2, depth, { cp: 740 }, ['d1d4', 'e8e7'])];
      if (f === afterCapture) return [line(1, depth, { cp: 120 }, ['e6d5'])];
      if (f === afterQuiet) return [line(1, depth, { cp: -90 }, ['e8e7', 'e1e2'])];
      return new Error('unexpected');
    });
    expect((await judgeMove(engine, { fenBefore: fen, uci: 'd1d5', ply: 41 })).classification).toBe('blunder');
    const quiet = await judgeMove(engine, { fenBefore: fen, uci: 'd1d2', ply: 41 });
    expect(quiet.classification).toBe('missedWin');
    expect(quiet.evalAfter).toEqual({ cp: 90, mate: null });
  });

  it('reports the motif of the best line as missedMotif (attacker wording: freeCapture)', async () => {
    // White could simply take the loose knight on d5 but pushes a pawn instead.
    const fen = '4k3/8/8/3n4/8/8/6BP/4K3 w - - 0 1';
    const after = '4k3/8/8/3n4/8/7P/6B1/4K3 b - - 0 1';
    const engine = fakeEngine((f, opts) => {
      const depth = opts.depth ?? 0;
      if (f === fen) return [line(1, depth, { cp: 420 }, ['g2d5', 'e8e7']), line(2, depth, { cp: 60 }, ['e1e2', 'd5f4']), line(3, depth, { cp: 40 }, ['g2f3', 'd5f4'])];
      if (f === after) return [line(1, depth, { cp: -30 }, ['d5f4', 'g2f3'])];
      return new Error('unexpected');
    });
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'h2h3', ply: 51 });
    expect(j.missedMotif).toBe('freeCapture');
    expect(j.allowedMotif).toBeUndefined();
    expect(j.classification).toBe('blunder');
    expect(j.bestSan).toBe('Bxd5');
  });

  it('works for Black and accepts upper-case UCI', async () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const engine = fakeEngine((f, opts) => [
      line(1, opts.depth ?? 0, { cp: -25 }, ['e7e5', 'g1f3']),
      line(2, opts.depth ?? 0, { cp: -45 }, ['c7c5', 'g1f3']),
    ]);
    const j = await judgeMove(engine, { fenBefore: fen, uci: 'C7C5', ply: 2 });
    expect(j.color).toBe('b');
    expect(j.uci).toBe('c7c5');
    expect(j.san).toBe('c5');
    expect(j.evalBefore).toEqual({ cp: -25, mate: null });
    expect(j.evalAfter).toEqual({ cp: -45, mate: null });
    expect(j.classification).toBe('excellent');
  });

  it('rejects illegal moves, invalid FENs and unusable engine output', async () => {
    const engine = fakeEngine(queenBlunderScript);
    await expect(judgeMove(engine, { fenBefore: FEN_BEFORE, uci: 'h5h8', ply: 5 })).rejects.toThrow(/Illegal move/);
    await expect(judgeMove(engine, { fenBefore: 'garbage', uci: 'e2e4', ply: 1 })).rejects.toThrow();
    expect(engine.calls).toHaveLength(0);

    // WASM Stockfish quirk: after a CRITICAL ERROR it may answer for a different position.
    const confused = fakeEngine(() => [line(1, 12, { cp: 10 }, ['e2e3'])]);
    await expect(judgeMove(confused, { fenBefore: FEN_BEFORE, uci: 'g1f3', ply: 5 })).rejects.toThrow(/unusable/);
    const empty = fakeEngine(() => []);
    await expect(judgeMove(empty, { fenBefore: FEN_BEFORE, uci: 'g1f3', ply: 5 })).rejects.toThrow(/unusable/);
    const failing = fakeEngine(() => new Error('watchdog timeout'));
    await expect(judgeMove(failing, { fenBefore: FEN_BEFORE, uci: 'g1f3', ply: 5 })).rejects.toThrow(/watchdog/);
  });
});
