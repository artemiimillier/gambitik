import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { computePositionFacts } from '@gambit/core';
import type { TakebackOutcome } from '@gambit/core';
import { PERSONAS } from '@gambit/content';
import { TIME_CONTROLS } from '@gambit/shared';
import type { GameRecord, GameSummary, MoveJudgement } from '@gambit/shared';
import { capturedFromFen, pieceGlyph } from './captured.ts';
import type { MoveEntry } from './gameTypes.ts';
import { describePositionRu, evalWordsRu } from './positionSummary.ts';
import { buildGamePgn, computeStars, makeGameId, orderJudgements, resultFor } from './record.ts';
import { MemoryStorage } from './testing/fakes.ts';
import { MAX_UNSAVED_GAMES, UNSAVED_GAMES_KEY, flushUnsavedGames, isClientError, readUnsavedGames, removeUnsavedGame, storeUnsavedGame } from './unsavedGames.ts';

function entries(sans: string[], clocks: (number | null)[] = []): MoveEntry[] {
  const chess = new Chess();
  return sans.map((san, index) => {
    const fenBefore = chess.fen();
    const move = chess.move(san);
    return {
      ply: index + 1,
      color: move.color,
      by: index % 2 === 0 ? 'child' : 'bot',
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      from: move.from,
      to: move.to,
      fenBefore,
      fenAfter: chess.fen(),
      clockMs: clocks[index] ?? null,
      spentMs: 1000,
    };
  });
}

const counts = (blunder: number): GameSummary['counts'] => ({ best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder, missedWin: 0 });

describe('makeGameId / resultFor', () => {
  it('is sortable, URL-safe and unique enough', () => {
    let n = 0;
    const id = makeGameId(new Date(2026, 8, 21, 9, 5, 7), () => (n++ % 36) / 36);
    expect(id).toBe('g-20260921-090507-abcdef');
    expect(makeGameId(new Date(), () => 0.999999)).toMatch(/^g-\d{8}-\d{6}-9{6}$/);
    expect(makeGameId(new Date(), () => 1)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('maps the winner to a PGN result', () => {
    expect(resultFor('w')).toBe('1-0');
    expect(resultFor('b')).toBe('0-1');
    expect(resultFor(null)).toBe('1/2-1/2');
  });
});

describe('buildGamePgn', () => {
  const base = {
    config: { personaId: 'sonya', timeControlId: 'blitz5', childColor: 'b', examMode: true } as const,
    persona: PERSONAS.sonya,
    timeControl: TIME_CONTROLS.blitz5,
    startedAt: new Date(2026, 8, 21, 18, 30),
    result: '0-1' as const,
    termination: 'resign' as const,
  };

  it('writes headers, clock comments and re-reads with chess.js', () => {
    const moves = entries(['e4', 'e5', 'Nf3', 'Nc6'], [299_000, 298_500, 290_000, 280_100]);
    const pgn = buildGamePgn({ ...base, nickname: 'Лёва "Конь"', moves, opening: { eco: 'C44', name: "King's Knight Opening", nameRu: 'Дебют королевского коня' } });

    expect(pgn).toContain('[White "Соня (бот)"]');
    expect(pgn).toContain("[Black \"Лёва 'Конь'\"]");
    expect(pgn).toContain('[Date "2026.09.21"]');
    expect(pgn).toContain('[WhiteElo "500"]');
    expect(pgn).toContain('[TimeControl "300+0"]');
    expect(pgn).toContain('[ECO "C44"]');
    expect(pgn).toContain('экзамен');
    expect(pgn).toContain('{[%clk 0:04:59]}');
    expect(pgn).toContain('{[%clk 0:04:40]}');
    expect(pgn.trim().endsWith('0-1')).toBe(true);

    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('handles an empty game and an empty nickname', () => {
    const pgn = buildGamePgn({ ...base, nickname: '  ', moves: [], result: '*', termination: 'abandoned' });
    expect(pgn).toContain('[Black "Ученик"]');
    expect(pgn).toContain('[Termination "abandoned"]');
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual([]);
  });
});

describe('computeStars — effort, not result', () => {
  const clean = { counts: counts(0), takebacksOffered: 0, takebacksAccepted: 0, hintsUsed: 0 };

  it('three stars for a careful game played to the end — also when lost', () => {
    expect(computeStars({ termination: 'checkmate', childMoves: 30, summary: clean, movesShown: 0 }).total).toBe(3);
    expect(computeStars({ termination: 'timeout', childMoves: 30, summary: clean, movesShown: 0 }).total).toBe(3);
  });

  it('blunders cost the «careful» star, ignored coach offers the «listened» star', () => {
    const stars = computeStars({
      termination: 'checkmate',
      childMoves: 25,
      summary: { counts: counts(3), takebacksOffered: 2, takebacksAccepted: 0, hintsUsed: 0 },
      movesShown: 0,
    });
    expect(stars).toEqual({ total: 1, finished: true, careful: false, listened: false, hintPenalty: 0 });

    const accepted = computeStars({
      termination: 'checkmate',
      childMoves: 25,
      summary: { counts: counts(1), takebacksOffered: 2, takebacksAccepted: 1, hintsUsed: 1 },
      movesShown: 0,
    });
    expect(accepted.total).toBe(3);
  });

  it('hints reduce the stars by halves but never below one for a finished game', () => {
    const many = computeStars({ termination: 'draw', childMoves: 40, summary: { ...clean, hintsUsed: 5 }, movesShown: 3 });
    expect(many.hintPenalty).toBe(1);
    expect(many.total).toBe(2);
    const worst = computeStars({
      termination: 'checkmate',
      childMoves: 40,
      summary: { counts: counts(4), takebacksOffered: 1, takebacksAccepted: 0, hintsUsed: 9 },
      movesShown: 5,
    });
    expect(worst.total).toBe(1);
  });

  it('«listened» is earned by thinking again, not by pressing the button', () => {
    const summary = { counts: counts(1), takebacksOffered: 1, takebacksAccepted: 1, hintsUsed: 0 };
    const outcome = (over: Partial<TakebackOutcome>): TakebackOutcome => ({ ply: 5, attemptUci: 'h5g5', attemptSan: 'Qg5', voluntary: false, known: true, changed: true, improved: true, ...over });
    const stars = (takebacks: TakebackOutcome[] | undefined) => computeStars({ termination: 'checkmate', childMoves: 25, summary, movesShown: 0, takebacks });
    expect(stars([outcome({})]).listened).toBe(true);
    expect(stars([outcome({ improved: false })]).listened).toBe(true); // a different move: the child did think again
    expect(stars([outcome({ changed: false, improved: false })]).listened).toBe(false); // the very same blunder replayed
    expect(stars([outcome({ known: false, changed: false, improved: false })]).listened).toBe(true); // the game ended first: benefit of the doubt
    expect(stars([outcome({ changed: false, improved: false }), outcome({ ply: 9 })]).listened).toBe(true);
    // «Вернуть ход» of the child's own accord says nothing about listening to the coach
    expect(stars([outcome({ voluntary: true, changed: false, improved: false })]).listened).toBe(true);
    expect(stars(undefined).listened).toBe(true); // older callers
  });

  it('an early resignation is not «finished», a long fight is; effort is never zero', () => {
    const early = computeStars({ termination: 'resign', childMoves: 5, summary: { ...clean, counts: counts(3), takebacksOffered: 1 }, movesShown: 0 });
    expect(early.finished).toBe(false);
    expect(early.total).toBe(0.5);
    expect(computeStars({ termination: 'resign', childMoves: 20, summary: clean, movesShown: 0 }).finished).toBe(true);
    expect(computeStars({ termination: 'abandoned', childMoves: 0, summary: clean, movesShown: 0 }).total).toBe(0);
  });
});

describe('orderJudgements', () => {
  it('sorts by ply and keeps the attempt order inside one ply', () => {
    const j = (ply: number, san: string): MoveJudgement => ({ ply, san }) as MoveJudgement;
    const ordered = orderJudgements([j(5, 'Qg5'), j(1, 'e4'), j(5, 'Nf3'), j(3, 'Qh5')]);
    expect(ordered.map((x) => `${x.ply}${x.san}`)).toEqual(['1e4', '3Qh5', '5Qg5', '5Nf3']);
  });
});

describe('capturedFromFen', () => {
  it('lists what is missing, strongest first, and the balance', () => {
    const start = capturedFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(start).toEqual({ lost: { w: [], b: [] }, diff: 0 });

    const c = capturedFromFen('r1b1kbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNB1KB1R w KQkq - 0 5');
    expect(c.lost.w).toEqual(['q']);
    expect(c.lost.b).toEqual(['q']);
    expect(c.diff).toBe(0);

    const promoted = capturedFromFen('QQ2k3/8/8/8/8/8/8/4K3 w - - 0 1');
    expect(promoted.lost.w).toEqual(['r', 'r', 'b', 'b', 'n', 'n', 'p', 'p', 'p', 'p', 'p', 'p', 'p', 'p']);
    expect(promoted.diff).toBe(18);
    expect(pieceGlyph('b', 'q')).toBe('♛');
  });
});

describe('describePositionRu', () => {
  it('describes the position in Russian without Latin letters or centipawns', () => {
    // after 1.e4 e5 2.Qh5 Nc6 3.Qg5 h6 — the white queen is attacked
    const fen = 'r1bqkbnr/pppp1pp1/2n4p/4p1Q1/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 0 4';
    const facts = computePositionFacts(fen, 'Дебют ферзевой пешки');
    const text = describePositionRu({
      facts,
      childColor: 'w',
      analysis: { fen, lines: [{ multipv: 1, depth: 14, cp: -350, mate: null, pvUci: ['g5d8'] }], bestmove: 'g5d8', depth: 14, timeMs: 5 },
      lastMove: { san: 'h6', fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p1Q1/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 3 3', by: 'bot' },
      moveNumber: 4,
    });
    expect(text).not.toMatch(/[A-Za-z]/);
    // the colour, the move number and whose move it is: only for a direct question, never a fact to retell
    expect(text).not.toMatch(/Ребёнок играет|Сейчас ход ребёнка|Идёт \d/);
    expect(text).toContain('Только если ребёнок сам спросит об этом: ребёнок играет белыми, идёт 4-й ход, сейчас ход ребёнка. Сам этого не говори');
    expect(text).toMatch(/^Сейчас дебют\./);
    expect(text).toContain('Под ударом у ребёнка: ферзь на же пять');
    expect(text).toContain('Последний ход соперника');
    expect(text).toContain('Материал равный.');
    expect(text).toContain('немного хуже');
    expect(text).not.toMatch(/-?350/);
  });

  it('puts the engine verdict into words from the child point of view', () => {
    const line = (cp: number | null, mate: number | null) => ({ fen: '', lines: [{ multipv: 1, depth: 12, cp, mate, pvUci: ['e2e4'] }], bestmove: 'e2e4', depth: 12, timeMs: 1 });
    expect(evalWordsRu(line(600, null), 'w', 'w')).toContain('большое преимущество');
    expect(evalWordsRu(line(600, null), 'w', 'b')).toContain('трудная позиция');
    expect(evalWordsRu(line(10, null), 'b', 'w')).toContain('примерно равны');
    expect(evalWordsRu(line(null, 2), 'b', 'b')).toContain('большое преимущество');
    expect(evalWordsRu(null, 'w', 'w')).toBeNull();
  });
});

describe('unsaved games queue', () => {
  const record = (id: string): GameRecord => ({ id, pgn: '*', events: [], judgements: [] }) as unknown as GameRecord;

  it('stores, de-duplicates, caps and removes', () => {
    const storage = new MemoryStorage();
    expect(readUnsavedGames(storage)).toEqual([]);
    expect(storeUnsavedGame(storage, record('a'))).toBe(true);
    expect(storeUnsavedGame(storage, record('a'))).toBe(true);
    expect(readUnsavedGames(storage).map((r) => r.id)).toEqual(['a']);

    for (let i = 0; i < MAX_UNSAVED_GAMES + 3; i++) storeUnsavedGame(storage, record(`g${i}`));
    const ids = readUnsavedGames(storage).map((r) => r.id);
    expect(ids).toHaveLength(MAX_UNSAVED_GAMES);
    expect(ids[ids.length - 1]).toBe(`g${MAX_UNSAVED_GAMES + 2}`);
    expect(ids).not.toContain('a');

    removeUnsavedGame(storage, ids[0] as string);
    expect(readUnsavedGames(storage)).toHaveLength(MAX_UNSAVED_GAMES - 1);
  });

  it('survives broken storage content and blocked writes', () => {
    const storage = new MemoryStorage();
    storage.setItem(UNSAVED_GAMES_KEY, '{not json');
    expect(readUnsavedGames(storage)).toEqual([]);
    storage.setItem(UNSAVED_GAMES_KEY, JSON.stringify([{ nope: true }, record('ok')]));
    expect(readUnsavedGames(storage).map((r) => r.id)).toEqual(['ok']);

    storage.failWrites = true;
    expect(storeUnsavedGame(storage, record('x'))).toBe(false);
    expect(storeUnsavedGame(null, record('x'))).toBe(false);
    expect(readUnsavedGames(undefined)).toEqual([]);
  });

  it('flush stops at a network failure but skips records the server refuses', async () => {
    const storage = new MemoryStorage();
    for (const id of ['a', 'bad', 'c', 'd']) storeUnsavedGame(storage, record(id));
    const sent: string[] = [];
    const save = (r: GameRecord): Promise<void> => {
      if (r.id === 'bad') return Promise.reject(Object.assign(new Error('invalid'), { status: 400 }));
      if (r.id === 'd') return Promise.reject(Object.assign(new Error('offline'), { status: 0 }));
      sent.push(r.id);
      return Promise.resolve();
    };
    expect(await flushUnsavedGames(storage, save)).toBe(2);
    expect(sent).toEqual(['a', 'c']);
    expect(readUnsavedGames(storage).map((r) => r.id)).toEqual(['bad', 'd']);
    expect(isClientError({ status: 413 })).toBe(true);
    expect(isClientError({ status: 503 })).toBe(false);
    expect(isClientError(new Error('x'))).toBe(false);
  });
});
