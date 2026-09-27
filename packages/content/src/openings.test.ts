import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  MAIN_LINE_EXPLORER_CHECKED,
  MAIN_LINE_MOVES,
  MAIN_LINE_TABLE,
  OPENING_REPERTOIRE,
  PLAN_CHILD_MOVES,
  getRepertoireAdvice,
  getRepertoireEntry,
  getRepertoireForSide,
  getRepertoirePlan,
  mainLineMoves,
} from './openings.ts';
import { LATIN_RE, PLACEHOLDER_RE, playLine } from './testUtils.ts';
// test-only: the named-opening book lives in the sibling workspace package (content does not depend on it at runtime)
import { lookupOpening } from '../../openings/src/index.ts';

const ALL_LINES = OPENING_REPERTOIRE.flatMap((entry) => entry.lines.map((line) => ({ entry, line })));

function fenAfter(sans: readonly string[]): Chess {
  const chess = new Chess();
  playLine(chess, sans);
  return chess;
}

describe('OPENING_REPERTOIRE', () => {
  it('covers the Italian game for White and the 1...e5 / 1...d5 set-ups for Black', () => {
    expect(OPENING_REPERTOIRE.map((e) => e.id)).toEqual(['italian-white', 'e5-black', 'd5-black']);
    expect(getRepertoireEntry('italian-white').side).toBe('w');
    expect(getRepertoireEntry('e5-black').side).toBe('b');
    expect(getRepertoireEntry('d5-black').side).toBe('b');
    expect(getRepertoireForSide('w').map((e) => e.id)).toEqual(['italian-white']);
    expect(getRepertoireForSide('b').map((e) => e.id)).toEqual(['e5-black', 'd5-black']);
  });

  it('is introduced at stage 5, as the research recommends', () => {
    for (const entry of OPENING_REPERTOIRE) expect(entry.fromStage).toBe(5);
  });

  it('explains ideas in plain Russian without notation and without placeholders', () => {
    for (const entry of OPENING_REPERTOIRE) {
      expect(entry.keyIdeas.length).toBeGreaterThanOrEqual(4);
      expect(entry.watchOut.length).toBeGreaterThanOrEqual(2);
      expect(entry.lines.length).toBeGreaterThanOrEqual(3);
      const texts = [
        entry.title,
        entry.against,
        entry.summary,
        ...entry.keyIdeas,
        ...entry.watchOut,
        ...entry.lines.flatMap((l) => [l.title, l.idea, l.nextIdea]),
      ];
      for (const text of texts) {
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text, `Latin letters in: ${text}`).not.toMatch(LATIN_RE);
        expect(text, `placeholder in: ${text}`).not.toMatch(PLACEHOLDER_RE);
      }
    }
  });

  it('line ids are unique', () => {
    const ids = ALL_LINES.map(({ line }) => line.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(ALL_LINES.map(({ entry, line }) => [`${entry.id}/${line.id}`, entry, line] as const))(
    '%s: every move is legal, canonical SAN from the initial position',
    (_name, entry, line) => {
      expect(line.movesSan.length).toBeGreaterThanOrEqual(6);
      const chess = fenAfter(line.movesSan);
      expect(chess.isGameOver()).toBe(false);
      // The repertoire lines start with the first move the entry is about.
      if (entry.id === 'italian-white') expect(line.movesSan[0]).toBe('e4');
      if (entry.id === 'e5-black') expect(line.movesSan.slice(0, 2)).toEqual(['e4', 'e5']);
    },
  );

  it('the basic set-ups reach the positions they are named after', () => {
    // Italian game: 1.e4 e5 2.Nf3 Nc6 3.Bc4
    const italian = fenAfter(getRepertoireEntry('italian-white').lines[0]?.movesSan.slice(0, 5) ?? []);
    expect(italian.fen()).toBe('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3');

    // 1...d5 set-up: pawns d5 + e6, knight f6, bishop e7, castled king.
    const qgd = fenAfter(getRepertoireEntry('d5-black').lines[0]?.movesSan ?? []);
    expect(qgd.get('d5')).toEqual({ type: 'p', color: 'b' });
    expect(qgd.get('e6')).toEqual({ type: 'p', color: 'b' });
    expect(qgd.get('f6')).toEqual({ type: 'n', color: 'b' });
    expect(qgd.get('e7')).toEqual({ type: 'b', color: 'b' });
    expect(qgd.get('g8')).toEqual({ type: 'k', color: 'b' });
  });

  it('both sides castle in the quiet Italian model line (golden rule 3)', () => {
    const quiet = getRepertoireEntry('italian-white').lines.find((l) => l.id === 'italian-quiet');
    expect(quiet?.movesSan.filter((san) => san === 'O-O')).toHaveLength(2);
  });

  it('the fried-liver line avoids the trap: Black answers with the knight to the rim, not with a capture on d5', () => {
    const line = getRepertoireEntry('e5-black').lines.find((l) => l.id === 'black-vs-knight-attack');
    expect(line?.movesSan.slice(6, 10)).toEqual(['Ng5', 'd5', 'exd5', 'Na5']);
  });

  it('the greedy-pawn line really ends with the queen hitting the rook in the corner', () => {
    const line = getRepertoireEntry('d5-black').lines.find((l) => l.id === 'black-greedy-pawn-trap');
    const chess = fenAfter(line?.movesSan ?? []);
    expect(chess.attackers('a8', 'w')).toContain('f3');
    expect(chess.attackers('a8', 'b')).toEqual([]);
  });

  it('the London line ends with the queen eyeing the weakened b2 pawn', () => {
    const line = getRepertoireEntry('d5-black').lines.find((l) => l.id === 'black-vs-london');
    const chess = fenAfter(line?.movesSan ?? []);
    expect(chess.attackers('b2', 'b')).toContain('b6');
  });
});

describe('getRepertoireAdvice (the repertoire is consumable by the game and the curriculum screen)', () => {
  const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'];

  it('recognises the Italian game for White from the SAN history and says what comes next', () => {
    const advice = getRepertoireAdvice(ITALIAN, 'w');
    expect(advice).toMatchObject({ entryId: 'italian-white', lineId: 'italian-quiet', lineTitle: 'Тихая итальянка', matchedPlies: 6, inBook: true, warning: false, fromStage: 5 });
    expect(advice?.idea).toContain('развиваем все фигуры');
    expect(advice?.nextIdea).toMatch(/^Дальше/);
    expect(advice?.nextMoveSan).toBe('c3');
    expect(advice?.nextMoveBy).toBe('child');
  });

  it('the same moves are the mirror set-up when the child plays Black', () => {
    const advice = getRepertoireAdvice(ITALIAN, 'b');
    expect(advice).toMatchObject({ entryId: 'e5-black', lineId: 'black-vs-italian', matchedPlies: 6, inBook: true });
    expect(advice?.nextMoveBy).toBe('opponent');
  });

  it('follows the game into the deeper line (strong centre) and notices when the game leaves the book', () => {
    const centre = getRepertoireAdvice([...ITALIAN, 'c3', 'Nf6', 'd4'], 'w');
    expect(centre).toMatchObject({ lineId: 'italian-strong-center', matchedPlies: 9, inBook: true, nextMoveSan: 'exd4', nextMoveBy: 'opponent' });
    const left = getRepertoireAdvice([...ITALIAN, 'd3', 'h6'], 'w');
    expect(left).toMatchObject({ lineId: 'italian-quiet', matchedPlies: 6, inBook: false });
    expect(left?.nextMoveSan).toBeUndefined();
  });

  it('accepts a FEN history and recognises transpositions', () => {
    const chess = new Chess();
    const fens = [chess.fen()];
    for (const san of ['e4', 'e5', 'Bc4', 'Nc6', 'Nf3', 'Bc5']) {
      chess.move(san);
      fens.push(chess.fen());
    }
    expect(getRepertoireAdvice(fens, 'w')).toMatchObject({ lineId: 'italian-quiet', matchedPlies: 6, inBook: true });
    // the same through SAN: the move order differs, the position is the model one
    expect(getRepertoireAdvice(['e4', 'e5', 'Bc4', 'Nc6', 'Nf3', 'Bc5'], 'w')?.matchedPlies).toBe(6);
  });

  it('needs two full moves, respects the stage gate and the colour', () => {
    expect(getRepertoireAdvice([], 'w')).toBeUndefined();
    expect(getRepertoireAdvice(['e4', 'e5', 'Nf3'], 'w')).toBeUndefined();
    expect(getRepertoireAdvice(['e4', 'e5', 'Nf3'], 'w', { minPlies: 3 })?.entryId).toBe('italian-white');
    expect(getRepertoireAdvice(ITALIAN, 'w', { stage: 4 })).toBeUndefined();
    expect(getRepertoireAdvice(ITALIAN, 'w', { stage: 5 })?.entryId).toBe('italian-white');
    expect(getRepertoireAdvice(['d4', 'd5', 'c4', 'e6'], 'w')).toBeUndefined(); // no 1.d4 repertoire for White
    expect(getRepertoireAdvice(['d4', 'd5', 'c4', 'e6'], 'b')).toMatchObject({ entryId: 'd5-black', lineId: 'black-qgd-setup' });
    expect(getRepertoireAdvice(['a3', 'h6', 'a4', 'h5'], 'w')).toBeUndefined();
    // garbage in the history stops the replay, it never throws
    expect(getRepertoireAdvice(['e4', 'e5', 'Nf3', 'Nc6', 'Zz9'], 'w')?.matchedPlies).toBe(4);
  });

  it('flags the cautionary line as a warning, not as a plan', () => {
    const advice = getRepertoireAdvice(['d4', 'd5', 'c4', 'dxc4', 'e3', 'b5'], 'b');
    expect(advice).toMatchObject({ lineId: 'black-greedy-pawn-trap', warning: true });
    expect(OPENING_REPERTOIRE.flatMap((e) => e.lines).filter((l) => l.warning)).toHaveLength(1);
  });

  it('every model line is recognised from its own moves, and every advice text is free of notation', () => {
    for (const { entry, line } of ALL_LINES) {
      const advice = getRepertoireAdvice(line.movesSan, entry.side);
      expect(advice, line.id).toBeDefined();
      expect(advice?.matchedPlies, line.id).toBe(line.movesSan.length);
      expect(advice?.inBook, line.id).toBe(true);
      for (const text of [advice?.lineTitle ?? '', advice?.idea ?? '', advice?.nextIdea ?? '', advice?.entryTitle ?? '']) expect(text).not.toMatch(LATIN_RE);
    }
  });
});

describe('getRepertoirePlan (TEACHER-MODE §3.3: the teacher uses the repertoire at any stage)', () => {
  const START = new Chess().fen();

  it('gives White a plan before the first move: the first line of the Italian part', () => {
    const plan = getRepertoirePlan([], 'w');
    expect(plan).toMatchObject({ entryId: 'italian-white', lineId: 'italian-quiet', lineTitle: 'Тихая итальянка', inBook: true, matchedPlies: 0, warning: false });
    expect(plan?.nextChildSans).toEqual(['e4', 'Nf3', 'Bc4', 'c3']);
    expect(plan?.nextChildSans.length).toBeLessThanOrEqual(PLAN_CHILD_MOVES);
    expect(plan?.continuationSan[0]).toBe('e4');
    // a FEN history with the start position is the same
    expect(getRepertoirePlan([START], 'w')?.nextChildSans).toEqual(['e4', 'Nf3', 'Bc4', 'c3']);
  });

  it('has no minPlies and no stage gate: after 1.e4 the Black plan is already there', () => {
    const plan = getRepertoirePlan(['e4'], 'b');
    expect(plan).toMatchObject({ entryId: 'e5-black', lineId: 'black-vs-italian', inBook: true, matchedPlies: 1 });
    expect(plan?.nextChildSans.slice(0, 3)).toEqual(['e5', 'Nc6', 'Bc5']);
    expect(getRepertoirePlan(['d4'], 'b')).toMatchObject({ entryId: 'd5-black', lineId: 'black-qgd-setup', nextChildSans: ['d5', 'e6', 'Nf6', 'Be7'] });
  });

  it('follows the special line the opponent chose (the early queen) and names the child\'s next model moves only', () => {
    const plan = getRepertoirePlan(['e4', 'e5', 'Qh5'], 'b');
    expect(plan).toMatchObject({ lineId: 'black-vs-early-queen', inBook: true, matchedPlies: 3 });
    expect(plan?.nextChildSans).toEqual(['Nc6', 'g6', 'Nf6']);
    expect(plan?.continuationSan).toEqual(['Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6']);
  });

  it('notices when the opponent leaves the book (TEACHER-MODE §3.4, E8: 3...h6)', () => {
    const plan = getRepertoirePlan(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6'], 'w');
    expect(plan).toMatchObject({ lineId: 'italian-quiet', inBook: false, matchedPlies: 5, nextChildSans: [], continuationSan: [] });
    expect(plan?.nextIdea).not.toMatch(LATIN_RE);
  });

  it('returns nothing when the game left every model line at once, or the history is garbage', () => {
    expect(getRepertoirePlan(['Nf3'], 'b')).toBeUndefined();
    expect(getRepertoirePlan(['a3'], 'w')).toBeUndefined();
    expect(getRepertoirePlan(['e4', 'e5', 'Zz9'], 'w')).toBeUndefined();
  });

  it('never plans a cautionary line and never names more than four child moves', () => {
    const greedy = getRepertoirePlan(['d4', 'd5', 'c4', 'dxc4', 'e3', 'b5'], 'b');
    expect(greedy?.warning ?? false).toBe(false);
    expect(greedy?.lineId).not.toBe('black-greedy-pawn-trap');
    for (const { entry, line } of ALL_LINES) {
      if (line.warning) continue;
      for (let n = 0; n < line.movesSan.length; n++) {
        const plan = getRepertoirePlan(line.movesSan.slice(0, n), entry.side);
        expect(plan, `${line.id} after ${n}`).toBeDefined();
        expect(plan?.inBook, `${line.id} after ${n}`).toBe(true);
        expect(plan?.nextChildSans.length ?? 0).toBeLessThanOrEqual(PLAN_CHILD_MOVES);
        // the child's next model move is legal in the game position
        const next = plan?.nextChildSans[0];
        const chess = fenAfter(line.movesSan.slice(0, n));
        if (next !== undefined && (chess.turn() === entry.side)) expect(() => new Chess(chess.fen()).move(next), `${line.id}: ${next}`).not.toThrow();
        for (const text of [plan?.lineTitle ?? '', plan?.nextIdea ?? '', plan?.idea ?? '', plan?.entryTitle ?? '']) expect(text).not.toMatch(LATIN_RE);
      }
    }
  });
});

describe('MAIN_LINE_MOVES (TEACHER-MODE §3.5: honest «так часто начинают»)', () => {
  it('is curated for the positions of the spec table, at most three moves each', () => {
    expect(MAIN_LINE_TABLE.length).toBe(17);
    expect(Object.keys(MAIN_LINE_MOVES)).toHaveLength(MAIN_LINE_TABLE.length);
    for (const row of MAIN_LINE_TABLE) {
      expect(row.moves.length).toBeGreaterThanOrEqual(1);
      expect(row.moves.length).toBeLessThanOrEqual(3);
    }
    expect(mainLineMoves(new Chess().fen())).toEqual(['e4', 'd4']);
    expect(mainLineMoves(fenAfter(['e4', 'e5', 'Nf3', 'Nc6']).fen())).toEqual(['Bb5', 'Bc4', 'd4']);
    expect(mainLineMoves(fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6']).fen())).toEqual([]);
    expect(mainLineMoves('garbage')).toEqual([]);
  });

  it('every move is legal canonical SAN and leads to a position of the named-opening book', () => {
    // 2.exd5 after 1.e4 d5 is THE main move, but the book names the Scandinavian at 1...d5 and only later variations
    const unnamedAfter = new Set(['e4 d5 exd5']);
    for (const row of MAIN_LINE_TABLE) {
      const before = fenAfter(row.after);
      for (const san of row.moves) {
        const chess = new Chess(before.fen());
        expect(() => playLine(chess, [san]), `${row.after.join(' ')} ${san}`).not.toThrow();
        const key = [...row.after, san].join(' ');
        if (unnamedAfter.has(key)) expect(lookupOpening(before.fen())?.nameRu, key).toBeDefined();
        else expect(lookupOpening(chess.fen()), key).toBeDefined();
      }
    }
  });

  it('keys are transposition-proof (placement + side to move + castling) and the lookup ignores move counters', () => {
    const viaTransposition = fenAfter(['Nf3', 'Nc6', 'e4', 'e5']).fen();
    expect(mainLineMoves(viaTransposition)).toEqual(['Bb5', 'Bc4', 'd4']);
  });

  it('the table is checked once against the lichess opening explorer (date not invented)', () => {
    expect(MAIN_LINE_EXPLORER_CHECKED === null || /^\d{4}-\d{2}-\d{2}$/.test(MAIN_LINE_EXPLORER_CHECKED)).toBe(true);
  });
});
