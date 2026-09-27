import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { buildPgn, formatClk } from './pgn.ts';

describe('formatClk', () => {
  it('formats h:mm:ss, rounding down', () => {
    expect(formatClk(299_900)).toBe('0:04:59');
    expect(formatClk(600_000)).toBe('0:10:00');
    expect(formatClk(3_725_000)).toBe('1:02:05');
    expect(formatClk(-5)).toBe('0:00:00');
    expect(formatClk(Number.NaN)).toBe('0:00:00');
  });
});

describe('buildPgn', () => {
  const headers = { Event: 'Гамбитик: тренировка', White: 'Ученик', Black: 'Петя "Пешка"', Date: '2026.09.21', TimeControl: '300' };
  const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4', 'Nxe5', 'Qg5', 'Nxf7', 'Qxg2', 'Rf1', 'Qxe4+', 'Be2', 'Nf3#'];

  it('writes the seven tag roster first and escapes values', () => {
    const pgn = buildPgn({ headers, moves: [], result: '*' });
    const lines = pgn.split('\n');
    expect(lines.slice(0, 7)).toEqual([
      '[Event "Гамбитик: тренировка"]',
      '[Site "?"]',
      '[Date "2026.09.21"]',
      '[Round "?"]',
      '[White "Ученик"]',
      "[Black \"Петя 'Пешка'\"]",
      '[Result "*"]',
    ]);
    expect(lines[7]).toBe('[TimeControl "300"]');
    expect(pgn.trimEnd().endsWith('*')).toBe(true);
  });

  it('round-trips through chess.js loadPgn with clocks and comments', () => {
    const moves = sans.map((san, i) => ({
      san,
      clkMs: 300_000 - i * 7_000,
      ...(i === 7 ? { comment: 'Тренер предложил вернуть ход {подсказка 1}' } : {}),
    }));
    const pgn = buildPgn({ headers, moves, result: '0-1' });
    expect(pgn).toContain('1. e4 {[%clk 0:05:00]} 1... e5 {[%clk 0:04:53]}');
    expect(pgn).toContain('(подсказка 1)');
    for (const line of pgn.split('\n')) expect(line.length).toBeLessThanOrEqual(80);

    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(sans);
    expect(chess.isCheckmate()).toBe(true);
    expect(chess.getHeaders().Result).toBe('0-1');
    expect(chess.getHeaders().Black).toBe("Петя 'Пешка'");
    expect(chess.getComments()[0]?.comment).toContain('[%clk 0:05:00]');
  });

  it('writes compact movetext without comments', () => {
    const pgn = buildPgn({ headers: {}, moves: sans.slice(0, 4).map((san) => ({ san })), result: '1/2-1/2' });
    expect(pgn.split('\n\n')[1]?.trim()).toBe('1. e4 e5 2. Nf3 Nc6 1/2-1/2');
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(sans.slice(0, 4));
  });

  it('the Result tag always follows the result argument', () => {
    const pgn = buildPgn({ headers: { Result: '1-0' }, moves: [{ san: 'e4' }], result: '0-1' });
    expect(pgn).toContain('[Result "0-1"]');
    expect(pgn).not.toContain('[Result "1-0"]');
  });

  it('starts from a FEN with Black to move', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
    const pgn = buildPgn({ headers: { FEN: fen }, moves: [{ san: 'Nc6' }, { san: 'Bb5' }, { san: 'a6' }], result: '*' });
    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain('2... Nc6 3. Bb5 a6 *');
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(['Nc6', 'Bb5', 'a6']);
  });
});
