/**
 * The structured goals of the 24 library cards (docs/TEACHING.md §6.4) on real positions: castling only by a castling
 * move, «aim at f7» only while the pawn stands and our bishop really hits it, a lost piece is «impossible», never «done».
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Color } from '@gambit/shared';
import { LESSON_GOAL_KEYS, STRATEGIES, getStrategy } from '@gambit/content';
import type { StrategyCardLike } from '../teacher.ts';
import { goalAchieved, goalDoneBy, goalImpossible, goalsOfCard, themeGoalOf } from './goals.ts';
import type { ThemeGoal } from './goals.ts';

/** Plays SAN moves from the initial position: the FEN after each ply (index 0 = start) and the history. */
function game(sans: readonly string[]): { fens: string[]; history: string[]; fen: string } {
  const chess = new Chess();
  const fens = [chess.fen()];
  const history: string[] = [];
  for (const s of sans) {
    history.push(chess.move(s).san);
    fens.push(chess.fen());
  }
  return { fens, history, fen: fens[fens.length - 1] as string };
}

function card(id: string): StrategyCardLike {
  const c = getStrategy(id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
}

function goal(id: string, key: string, color: Color): ThemeGoal {
  const g = goalsOfCard(card(id), color).find((x) => x.key === key);
  if (!g) throw new Error(`${id}: no goal ${key}`);
  return g;
}

/** The goal the LAST move of `sans` achieves (the child is the side that made it). */
function doneByLast(id: string, sans: readonly string[]): string | null {
  const g = game(sans);
  const color: Color = sans.length % 2 === 1 ? 'w' : 'b';
  const goals = goalsOfCard(card(id), color);
  const done = goalDoneBy(goals, g.fens[g.fens.length - 2] as string, g.fen, color, g.history.slice(0, -1), g.history);
  return done?.key ?? null;
}

describe('goalsOfCard', () => {
  it('every goal of the 24 cards has a structured shape and a known key', () => {
    expect(STRATEGIES).toHaveLength(24);
    for (const c of STRATEGIES) {
      const goals = goalsOfCard(c, c.side);
      expect(goals.map((g) => g.textRu), c.id).toEqual(c.planGoalsRu);
      for (const g of goals) expect(LESSON_GOAL_KEYS as readonly string[]).toContain(g.key);
    }
  });

  it('the other colour and no card give no goals', () => {
    expect(goalsOfCard(card('italian'), 'b')).toEqual([]);
    expect(goalsOfCard(null, 'w')).toEqual([]);
    expect(themeGoalOf('летим на луну')).toBeNull();
  });

  it('a goal text is found with its end mark and a capital letter too', () => {
    expect(themeGoalOf('Прячем короля рокировкой.')?.key).toBe('castle');
  });
});

describe('Italian: the bishop aims at f7', () => {
  const aim = goal('italian', 'aimF7', 'w');

  it('3.Bc4 achieves it — the pawn is on f7 and the bishop hits it', () => {
    expect(doneByLast('italian', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])).toBe('aimF7');
  });

  it('after the bishop is lost it is not achieved but impossible, and no move «does» it', () => {
    const g = game(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Na5', 'd3', 'Nxc4', 'dxc4']);
    expect(goalAchieved(aim, g.fen, 'w', g.history)).toBe(false);
    expect(goalImpossible(aim, g.fen, 'w')).toBe(true);
    // the next white move serves no aimF7
    expect(doneByLast('italian', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Na5', 'd3', 'Nxc4', 'dxc4', 'd6', 'Nc3'])).not.toBe('aimF7');
  });

  it('after Bxf7+ the target pawn is gone: not achieved, impossible, not «done» by the sacrifice', () => {
    const g = game(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Bxf7+']);
    expect(goalAchieved(aim, g.fen, 'w', g.history)).toBe(false);
    expect(goalImpossible(aim, g.fen, 'w')).toBe(true);
    expect(doneByLast('italian', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Bxf7+'])).toBeNull();
  });

  it('a bishop on another diagonal does not aim (and the goal is still open)', () => {
    // 3.Be2: the bishop stands on the other diagonal and does not hit f7
    const g = game(['e4', 'e5', 'Nf3', 'Nc6', 'Be2']);
    expect(goalAchieved(aim, g.fen, 'w', g.history)).toBe(false);
    expect(goalImpossible(aim, g.fen, 'w')).toBe(false);
  });

  it('the centre is held by c3 and d3', () => {
    expect(doneByLast('italian', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3'])).toBe('holdCentre');
  });
});

describe('castle: only a castling move counts', () => {
  const castle = goal('open-game', 'castle', 'b');

  it('a king walk Ke2 is not castling — and castling became impossible', () => {
    const g = game(['e4', 'e5', 'Nf3', 'Ke7']);
    expect(goalAchieved(castle, g.fen, 'b', g.history)).toBe(false);
    expect(goalImpossible(castle, g.fen, 'b')).toBe(true);
    expect(doneByLast('open-game', ['e4', 'e5', 'Nf3', 'Ke7'])).toBeNull();
  });

  it('White Ke2 either: no castle in the history, no rights, no castled king', () => {
    const w = goalsOfCard(card('italian'), 'w');
    expect(w.some((g) => g.kind === 'castle')).toBe(false); // the Italian card has no castle goal …
    const g = game(['e4', 'e5', 'Ke2']);
    const anyCastle = goal('open-game', 'castle', 'b');
    const white: ThemeGoal = { ...anyCastle }; // … the shape is colour-free: check it for White
    expect(goalAchieved(white, g.fen, 'w', g.history)).toBe(false);
    expect(goalImpossible(white, g.fen, 'w')).toBe(true);
  });

  it('…O-O achieves it and it is not impossible after', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O'];
    expect(doneByLast('open-game', sans)).toBe('castle');
    const g = game(sans);
    expect(goalImpossible(castle, g.fen, 'b')).toBe(false);
  });
});

describe('the other shapes on their cards', () => {
  it('London: the bishop before e3 — achieved by 2.Bf4, impossible after 2.e3', () => {
    expect(doneByLast('london', ['d4', 'd5', 'Bf4'])).toBe('bishopFirst');
    const g = game(['d4', 'd5', 'e3']);
    expect(goalImpossible(goal('london', 'bishopFirst', 'w'), g.fen, 'w')).toBe(true);
  });

  it('Caro-Kann: the bishop out before …e6', () => {
    expect(doneByLast('caro-kann', ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5'])).toBe('bishopFirst');
  });

  it('Four knights: both knights out, then the pin Bg5 of the f6 knight against the queen', () => {
    expect(doneByLast('four-knights', ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3'])).toBe('bothKnights');
    expect(doneByLast('four-knights', ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6', 'Bb5', 'Bb4', 'O-O', 'O-O', 'd3', 'd6', 'Bg5'])).toBe('pinKnight');
  });

  it("King's Indian: the bishop on the long diagonal, then …e5 into the centre", () => {
    expect(doneByLast('kings-indian', ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7'])).toBe('longDiagonal');
    expect(doneByLast('kings-indian', ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O', 'Be2', 'e5'])).toBe('hitCentre');
  });

  it('French: the strike …c5 hits the chain', () => {
    expect(doneByLast('french', ['e4', 'e6', 'd4', 'd5', 'e5', 'c5'])).toBe('chain');
  });

  it("Queen's gambit: 2.c4 hits the centre", () => {
    expect(doneByLast('queens-gambit', ['d4', 'd5', 'c4'])).toBe('hitCentre');
  });

  it('Scandinavian: 1…d5 hits e4 at once', () => {
    expect(doneByLast('scandinavian', ['e4', 'd5'])).toBe('hitCentre');
  });

  it('a goal about the opponent pawn is impossible when the pawn is gone', () => {
    const press = goal('two-knights', 'pressCentrePawn', 'b');
    const g = game(['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'e5']);
    expect(goalImpossible(press, g.fen, 'b')).toBe(true);
  });
});
