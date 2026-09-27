import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { IDEA_TAILS } from '@gambit/content';
import type { EvalScore, Threat } from '@gambit/shared';
import type { MoveIdea, MoveIdeaId } from './moveIdeas.ts';
import {
  IDEA_GROUP,
  IDEA_PRIORITY,
  MAX_IDEA_PAIR_WORDS,
  MAX_IDEA_WORDS,
  STATIC_IDEA_IDS,
  explainMove,
  explainMoveLoss,
  explainOpponentMove,
  ideaWordCount,
  isEarlyQueenMove,
  joinIdeasRu,
  pickIdeas,
} from './moveIdeas.ts';

// ───────────────────────── helpers ─────────────────────────

const START = new Chess().fen();

function fenAfter(...sans: string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

/** The FEN after one UCI move. */
function play(fen: string, uci: string): string {
  const chess = new Chess(fen);
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return chess.fen();
}

/** Throws unless the FEN is a legal chess.js position and every move of `line` is legal in turn. */
function assertLegal(fen: string, line: readonly string[]): void {
  const chess = new Chess(fen);
  for (const uci of line) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

/** Every idea any test produced — checked for language rules at the end. */
const SEEN: MoveIdea[] = [];

function explain(fen: string, uci: string, pvUci?: string[], lineScore?: EvalScore, prev?: { uci: string; fenBefore: string }): MoveIdea[] {
  assertLegal(fen, pvUci && pvUci[0] === uci ? pvUci : [uci, ...(pvUci ?? [])]);
  const ideas = explainMove({ fen, uci, ...(pvUci ? { pvUci } : {}), ...(lineScore ? { lineScore } : {}), ...(prev ? { prev } : {}) });
  SEEN.push(...ideas);
  return ideas;
}

function ids(ideas: readonly MoveIdea[]): MoveIdeaId[] {
  return ideas.map((i) => i.id);
}

function find(ideas: readonly MoveIdea[], id: MoveIdeaId): MoveIdea {
  const got = ideas.find((i) => i.id === id);
  if (!got) throw new Error(`no idea ${id} in [${ids(ideas).join(', ')}]`);
  return got;
}

const MATE_2: EvalScore = { cp: null, mate: 2 };
const MATE_3: EvalScore = { cp: null, mate: 3 };

// §8.1 reference positions
const E1 = START;
const E2 = fenAfter('e4', 'e5');
const E3 = fenAfter('e4', 'e5', 'Qh5');
const E4 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
const E5 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const E6 = 'r1bqkbnr/pppp1ppp/2n5/4p1N1/4P3/8/PPPP1PPP/RNBQKB1R b KQkq - 3 3';
const E7 = 'r1bqkbnr/pppppppp/8/8/3nP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3';
const E8 = 'r1bqkbnr/pppp1pp1/2n4p/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';
const E9 = 'r1bqr1k1/bpp2pp1/p1np1n1p/4p3/2B1P3/2PP1NN1/PP3PPP/R1BQR1K1 w - - 2 11';
const E10 = '8/8/5k2/8/8/4K3/4P3/8 w - - 0 1';
const E12 = fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5');
/** The two-knights card's line up to 9.Сa4 (Black to play …b5). */
const TWO_KNIGHTS_B5 = fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Be7', 'O-O', 'O-O', 'Re1', 'd6', 'c3', 'Na5', 'Bb5', 'a6', 'Ba4');

/** Concept cards that exist in packages/content CONCEPT_CARDS today (core does not depend on content). */
const KNOWN_CONCEPTS = new Set([
  'hanging-piece',
  'free-capture',
  'bad-trade',
  'mate-in-1',
  'mate-in-2',
  'mate-in-3',
  'back-rank-mate',
  'opening-center',
  'opening-development',
  'opening-king-safety',
  'opening-early-queen',
  'scholars-mate',
  'endgame-ladder-mate',
  'endgame-queen-mate',
  'endgame-rook-mate',
  'endgame-opposition',
  'fork',
  'pin',
  'skewer',
  'discovered-attack',
  'double-check',
  'remove-defender',
  'trapped-piece',
  'promotion',
]);

// ───────────────────────── tables ─────────────────────────

describe('taxonomy tables', () => {
  it('lists every idea exactly once in priority order, with its group', () => {
    expect(new Set(IDEA_PRIORITY).size).toBe(IDEA_PRIORITY.length);
    expect(Object.keys(IDEA_GROUP).sort()).toEqual([...IDEA_PRIORITY].sort());
    expect(IDEA_PRIORITY.slice(0, 3)).toEqual(['mate', 'mateSoon', 'promotion']);
    expect(IDEA_PRIORITY[IDEA_PRIORITY.length - 1]).toBe('quiet');
    // groups never go "back up" along the priority order
    const order = IDEA_PRIORITY.map((id) => IDEA_GROUP[id]);
    expect([...order].sort()).toEqual(order);
  });

  it('the opponent explainer uses only the static rules 5–21, 25, 26, 28', () => {
    // + recapture, answerCheck and fightCenter (static rules)
    expect(STATIC_IDEA_IDS).toHaveLength(23);
    for (const id of ['mate', 'mateSoon', 'promotion', 'fork', 'pin', 'quiet', 'improvePiece', 'restrictKing'] as const) {
      expect(STATIC_IDEA_IDS).not.toContain(id);
    }
  });
});

// ───────────────────────── §8.1 positions ─────────────────────────

describe('§8.1 reference positions', () => {
  it('E1: 1.e4 and 1.d4 put a pawn in the centre and open lines; 1.Кf3 develops', () => {
    const e4 = explain(E1, 'e2e4');
    expect(ids(e4)).toEqual(['centerPawn', 'openLine']);
    expect(find(e4, 'openLine').phraseRu).toBe('открывает дорогу слону и ферзю');
    expect(find(e4, 'openLine').squares.sort()).toEqual(['d1', 'f1']);
    expect(joinIdeasRu(pickIdeas(e4, { stage: 1, max: 2 }))).toBe('ставит пешку в центр и открывает дорогу слону и ферзю');
    expect(ids(explain(E1, 'd2d4'))).toEqual(['centerPawn', 'openLine']);
    const nf3 = explain(E1, 'g1f3');
    expect(ids(nf3)).toEqual(['develop', 'centerControl']);
    expect(joinIdeasRu(pickIdeas(nf3, { stage: 1, max: 2 }))).toBe('выводит коня и смотрит в центр');
  });

  it('E2: 2.Кf3 develops and attacks e5 (T2), 2.Кc3 / 2.Сc4 develop', () => {
    const nf3 = explain(E2, 'g1f3');
    expect(ids(nf3)).toEqual(['attack', 'develop', 'centerControl']);
    expect(find(nf3, 'attack').squares).toEqual(['e5']);
    const said = pickIdeas(nf3, { stage: 1, max: 2 });
    expect(ids(said)).toEqual(['develop', 'attack']);
    expect(joinIdeasRu(said)).toBe('выводит коня и нападает на пешку на е пять');
    expect(joinIdeasRu(said, 'you')).toBe('выводишь коня и нападаешь на пешку на е пять');
    expect(ids(pickIdeas(nf3, { stage: 1, max: 1 }))).toEqual(['attack']);

    expect(ids(explain(E2, 'b1c3'))).toEqual(['develop', 'centerControl']);
    const bc4 = explain(E2, 'f1c4');
    expect(ids(bc4)).toEqual(['develop', 'aimWeakSquare', 'centerControl']);
  });

  it('E3: 2.Фh5 is an early queen that attacks e5; the answers 2…Кc6 / 2…d6 defend, 2…Фe7 has no group-A idea', () => {
    const opp = explainOpponentMove(E2, 'd1h5', E3);
    expect(ids(opp.ideas)).toEqual(['attack', 'aimWeakSquare', 'centerControl']);
    const attack = find(opp.ideas, 'attack');
    expect(attack.squares).toEqual(['e5']);
    expect(attack.phraseRu).toBe('нападает на пешку на е пять');
    expect(attack.conceptId).toBe('opening-early-queen');
    expect(isEarlyQueenMove(E2, 'd1h5')).toBe(true);
    expect(opp.wants).toBeNull();
    SEEN.push(...opp.ideas);

    const nc6 = explain(E3, 'b8c6');
    expect(ids(nc6)).toEqual(['defend', 'develop', 'centerControl']);
    expect(find(nc6, 'defend').phraseRu).toBe('защищает пешку на е пять');
    expect(joinIdeasRu(pickIdeas(nc6, { stage: 2, max: 2 }))).toBe('защищает пешку на е пять и выводит коня в игру');

    const d6 = explain(E3, 'd7d6');
    expect(ids(d6)).toEqual(['defend', 'openLine']);
    expect(ids(pickIdeas(d6, { stage: 2, max: 2 }))).toEqual(['defend']); // not a stage 1–2 pair
    expect(ids(pickIdeas(d6, { stage: 3, max: 2 }))).toEqual(['defend', 'openLine']);

    const qe7 = explain(E3, 'd8e7');
    expect(qe7.some((i) => i.group === 'A')).toBe(false);
    // 2…Фe7 GUARDS the attacked e5 pawn one step away: a defensive queen move is not «the early-queen mistake» for
    // the reaction (G03 / G08); the kid filter of the ADVICE still keeps it off the arrows (teacher T3)
    expect(isEarlyQueenMove(E3, 'd8e7')).toBe(false);
    expect(isEarlyQueenMove(E2, 'd1f3')).toBe(true);
  });

  it('E4: 3…g6 closes the mate threat and attacks the queen; 3…Фe7 only closes it (T4)', () => {
    const g6 = explain(E4, 'g7g6');
    expect(ids(g6)).toEqual(['defendMate', 'block', 'attack']);
    expect(find(g6, 'defendMate').conceptId).toBe('scholars-mate');
    expect(find(g6, 'defendMate').squares).toEqual(['f7']);
    expect(find(g6, 'attack').squares).toEqual(['h5']);
    expect(find(g6, 'attack').conceptId).toBe('opening-early-queen');
    const said = pickIdeas(g6, { stage: 2, max: 2 });
    expect(ids(said)).toEqual(['defendMate', 'attack']);
    expect(joinIdeasRu(said)).toBe('закрывает угрозу мата и нападает на ферзя на аш пять');

    const qe7 = explain(E4, 'd8e7');
    expect(ids(qe7)).toContain('defendMate');
    expect(ids(pickIdeas(qe7, { stage: 2, max: 2 }))).toEqual(['defendMate']);
    expect(ids(explain(E4, 'd8f6'))).toContain('defendMate');
  });

  it('E4 from the other side: 3.Сc4 threatens mate — what the opponent wants is Фxf7#', () => {
    const before = fenAfter('e4', 'e5', 'Qh5', 'Nc6');
    const opp = explainOpponentMove(before, 'f1c4', E4);
    expect(opp.ideas[0]?.id).toBe('threatMate');
    expect(ids(opp.ideas)).toContain('develop');
    expect(opp.wants?.uci).toBe('h5f7');
    expect(opp.wants?.san).toBe('Qxf7#');
    SEEN.push(...opp.ideas);
  });

  it('E5/E6: 3.Кg5 has no idea (the knight just hangs); 3…Фxg5 takes it for free', () => {
    expect(explain(E5, 'f3g5')).toEqual([]);
    const qxg5 = explain(E6, 'd8g5');
    expect(ids(qxg5)[0]).toBe('freeCapture');
    expect(find(qxg5, 'freeCapture')).toMatchObject({ gainPawns: 3, squares: ['g5'], phraseRu: 'забирает коня на же пять бесплатно: никто не защищал' });
    expect(ids(explain(E6, 'f8e7'))).toEqual(['develop']);
  });

  it('E7: 3.Фxd4 wins the knight; the bot\'s 2…Кxd4 itself has no idea to tell', () => {
    const qxd4 = explain(E7, 'd1d4');
    expect(find(qxd4, 'freeCapture').gainPawns).toBe(3);
    expect(explainOpponentMove(fenAfter('e4', 'Nc6', 'd4'), 'c6d4', E7).ideas).toEqual([]);
  });

  it('E8: the bot left the book with 3…h6 (no idea); 4.d4 / 0-0 / c3 are explained', () => {
    expect(explainOpponentMove(fenAfter('e4', 'e5', 'Nf3', 'Nc6', 'Bc4'), 'h7h6', E8).ideas).toEqual([]);
    const d4 = explain(E8, 'd2d4');
    expect(ids(d4)).toEqual(['attack', 'centerPawn', 'openLine']);
    expect(joinIdeasRu(pickIdeas(d4, { stage: 1, max: 2 }))).toBe('ставит пешку в центр и нападает на пешку на е пять');
    expect(ids(explain(E8, 'e1g1'))).toEqual(['castle']);
    expect(ids(explain(E8, 'c2c3'))).toContain('supportCenter');
  });

  it('E9: quiet middlegame moves are honestly «спокойный крепкий ход»; b4 takes space on the queen\'s side', () => {
    for (const uci of ['a2a4', 'c4b3']) expect(ids(explain(E9, uci))).toEqual(['quiet']);
    // b4 newly controls a5 and c5 in the opponent's half, safely (the knight c6 may not take: c3 guards b4)
    const b4 = explain(E9, 'b2b4');
    expect(ids(b4)).toEqual(['space']);
    expect(find(b4, 'space').squares).toEqual(['b4', 'a5', 'c5']);
  });

  it('E10: every king move forward is king activity (T9)', () => {
    for (const uci of ['e3d4', 'e3e4', 'e3f4']) {
      const ideas = explain(E10, uci);
      expect(ideas[0]?.id).toBe('kingActivity');
      expect(ideas[0]?.phraseRu).toBe('король идёт вперёд: в эндшпиле король — сильная фигура');
    }
  });

  it('E12: 4.c3 prepares d4, 4.d3 opens the bishop', () => {
    const c3 = explain(E12, 'c2c3');
    expect(find(c3, 'supportCenter').squares).toEqual(['c3', 'd4']);
    expect(ids(explain(E12, 'd2d3'))).toEqual(['openLine']);
  });
});

// ───────────────────────── every idea: positive and negative fixtures ─────────────────────────

interface Fixture {
  name: string;
  fen: string;
  uci: string;
  pv?: string[];
  score?: EvalScore;
  /** the move played just before `fen` (the recapture rule) */
  prev?: { uci: string; fenBefore: string };
  has?: MoveIdeaId[];
  lacks?: MoveIdeaId[];
  /** exact first idea of the list */
  first?: MoveIdeaId;
  /** the idea `pickIdeas` says first (when the list starts with the never-first «смотрит в центр») */
  said?: MoveIdeaId;
  phrase?: Partial<Record<MoveIdeaId, string>>;
}

const FIXTURES: Fixture[] = [
  // ── A: mate ──
  { name: 'mate: back-rank mate', fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', uci: 'a1a8', first: 'mate', phrase: { mate: 'ставит мат' } },
  { name: "mate: scholar's mate", fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', uci: 'h5f7', first: 'mate' },
  { name: 'mate (−): a rook move that does not mate', fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', uci: 'a1a7', lacks: ['mate'], has: ['threatMate'] },
  // ── A: mate soon ──
  {
    name: 'mateSoon: back-rank mate in two',
    fen: 'r5k1/5ppp/8/8/8/8/4R3/4R1K1 w - - 0 1',
    uci: 'e2e8',
    pv: ['e2e8', 'a8e8', 'e1e8'],
    score: MATE_2,
    first: 'mateSoon',
    phrase: { mateSoon: 'ведёт к мату в два хода: король соперника заперт своими пешками' },
  },
  { name: 'mateSoon: rook ladder in two', fen: '7k/8/R7/1R6/8/8/8/6K1 w - - 0 1', uci: 'a6a7', pv: ['a6a7', 'h8g8', 'b5b8'], score: MATE_2, first: 'mateSoon', phrase: { mateSoon: 'ведёт к мату в два хода' } },
  { name: 'mateSoon: ladder in three', fen: '7k/8/8/R7/1R6/8/8/6K1 w - - 0 1', uci: 'a5a7', pv: ['a5a7', 'h8g8', 'b4b6', 'g8f8', 'b6b8'], score: MATE_3, first: 'mateSoon', phrase: { mateSoon: 'ведёт к мату в три хода' } },
  { name: 'mateSoon (−): no engine score', fen: 'r5k1/5ppp/8/8/8/8/4R3/4R1K1 w - - 0 1', uci: 'e2e8', pv: ['e2e8', 'a8e8', 'e1e8'], lacks: ['mateSoon'] },
  { name: 'mateSoon (−): a mate too far away', fen: '7k/8/R7/1R6/8/8/8/6K1 w - - 0 1', uci: 'a6a7', pv: ['a6a7', 'h8g8', 'b5b8'], score: { cp: null, mate: 5 }, lacks: ['mateSoon'] },
  // ── A: promotion ──
  { name: 'promotion: to a queen', fen: '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1', uci: 'e7e8q', first: 'promotion', phrase: { promotion: 'пешка превращается в ферзя' } },
  { name: 'promotion: capturing a rook', fen: '3r2k1/4P3/8/8/8/8/8/4K3 w - - 0 1', uci: 'e7d8q', first: 'promotion', has: ['freeCapture'] },
  { name: 'promotion (−): one step before', fen: '8/8/4P1k1/8/8/8/8/4K3 w - - 0 1', uci: 'e6e7', lacks: ['promotion'], has: ['passedPawn'] },
  // ── A: tactics (need the line) ──
  {
    name: 'fork: knight on king and rook',
    fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1',
    uci: 'd5c7',
    pv: ['d5c7', 'e8d7', 'c7a8'],
    first: 'fork',
    phrase: { fork: 'нападает сразу на короля и ладью — это вилка' },
  },
  {
    name: 'fork: pawn on knight and bishop',
    fen: '4k3/8/3n1b2/8/3PP3/8/8/4K3 w - - 0 1',
    uci: 'e4e5',
    pv: ['e4e5', 'f6e7', 'e5d6', 'e7d6'],
    first: 'fork',
    phrase: { fork: 'нападает сразу на коня и слона — это вилка' },
  },
  {
    name: 'fork: prepared by a check (fork on the next move)',
    fen: '1r4k1/8/8/8/4n3/8/6K1/3Q4 b - - 0 1',
    uci: 'b8b2',
    pv: ['b8b2', 'g2h1', 'e4f2', 'h1g1', 'f2d1'],
    first: 'fork',
    phrase: { fork: 'готовит вилку: следом нападёт на короля и ферзя' },
  },
  { name: 'fork (−): the line never collects', fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', uci: 'd5c7', pv: ['d5c7', 'e8d7'], lacks: ['fork'], has: ['attack', 'check'] },
  { name: 'fork (−): no engine line at all', fen: '4k3/8/3n1b2/8/3PP3/8/8/4K3 w - - 0 1', uci: 'e4e5', lacks: ['fork'], has: ['attack'] },
  {
    name: 'pin: rook pins the queen to the king',
    fen: '4k3/8/8/4q3/8/8/8/R4K2 w - - 0 1',
    uci: 'a1e1',
    pv: ['a1e1', 'e5e1', 'f1e1'],
    first: 'pin',
    phrase: { pin: 'связывает ферзя на е пять: за ним стоит король' },
  },
  {
    name: 'pin: a pawn attacks the pinned knight',
    fen: '4k3/1p3ppp/2n5/1B6/3P4/8/5PPP/6K1 w - - 0 1',
    uci: 'd4d5',
    pv: ['d4d5', 'g7g6', 'd5c6', 'b7c6', 'b5c6'],
    first: 'pin',
    phrase: { pin: 'связывает коня на цэ шесть: за ним стоит король' },
  },
  { name: 'pin (−): taking a piece whose defender is pinned is a capture idea', fen: '4k3/4n3/2b5/8/8/8/4R1B1/4K3 w - - 0 1', uci: 'g2c6', pv: ['g2c6'], lacks: ['pin'], first: 'freeCapture', phrase: { freeCapture: 'забирает слона на цэ шесть бесплатно: взять назад нельзя' } },
  {
    name: 'skewer: check, the queen behind falls',
    fen: '3q4/8/8/3k4/8/8/8/R3K3 w - - 0 1',
    uci: 'a1d1',
    pv: ['a1d1', 'd5e6', 'd1d8'],
    first: 'skewer',
    phrase: { skewer: 'сквозной удар: король уйдёт — и заберём ферзя на дэ восемь' },
  },
  { name: 'skewer: bishop hits the queen, the rook behind falls', fen: 'r3k3/8/8/3q4/8/8/8/5BK1 w - - 0 1', uci: 'f1g2', pv: ['f1g2', 'd5d7', 'g2a8'], first: 'skewer' },
  { name: 'skewer (−): no line', fen: '3q4/8/8/3k4/8/8/8/R3K3 w - - 0 1', uci: 'a1d1', lacks: ['skewer'], has: ['check'] },
  {
    name: 'discoveredAttack: the knight uncovers the rook on the queen',
    fen: '6k1/4q1pp/8/8/4N3/8/8/4R1K1 w - - 0 1',
    uci: 'e4f6',
    pv: ['e4f6', 'g7f6', 'e1e7'],
    first: 'discoveredAttack',
    phrase: { discoveredAttack: 'открывает дорогу ладье, и та нападает на ферзя на е семь' },
  },
  {
    name: 'discoveredAttack: a knight check uncovers the bishop on the rook',
    fen: '7r/k7/8/8/3N4/8/1B6/6K1 w - - 0 1',
    uci: 'd4b5',
    pv: ['d4b5', 'a7a8', 'b2h8'],
    first: 'discoveredAttack',
    phrase: { discoveredAttack: 'открывает дорогу слону, и тот нападает на ладью на аш восемь' },
  },
  { name: 'discoveredAttack (−): no line', fen: '6k1/4q1pp/8/8/4N3/8/8/4R1K1 w - - 0 1', uci: 'e4f6', lacks: ['discoveredAttack'] },
  { name: 'doubleCheck: knight and rook', fen: '4k3/8/8/8/4N3/8/8/4R1K1 w - - 0 1', uci: 'e4f6', pv: ['e4f6'], first: 'doubleCheck', lacks: ['check'] },
  { name: 'doubleCheck: the other knight square', fen: '4k3/8/8/8/4N3/8/8/4R1K1 w - - 0 1', uci: 'e4d6', pv: ['e4d6'], first: 'doubleCheck' },
  { name: 'doubleCheck (−): a single knight check', fen: '4k3/8/8/8/4N3/8/8/6K1 w - - 0 1', uci: 'e4f6', pv: ['e4f6'], lacks: ['doubleCheck'], first: 'check' },
  {
    name: 'removeDefender: take the knight, then the rook',
    fen: '6k1/6pp/5n2/3r2B1/8/8/8/3RK3 w - - 0 1',
    uci: 'g5f6',
    pv: ['g5f6', 'g7f6', 'd1d5'],
    first: 'removeDefender',
    phrase: { removeDefender: 'забирает защитника ладьи на дэ пять' },
  },
  { name: 'removeDefender (−): no line — just an even trade', fen: '6k1/6pp/5n2/3r2B1/8/8/8/3RK3 w - - 0 1', uci: 'g5f6', lacks: ['removeDefender'], has: ['trade'] },
  {
    name: "trappedPiece: Noah's ark",
    fen: '6k1/8/8/1pp5/8/1B6/P1P5/4K3 b - - 0 1',
    uci: 'c5c4',
    pv: ['c5c4', 'b3c4', 'b5c4'],
    first: 'trappedPiece',
    phrase: { trappedPiece: 'ловит слона на бэ три: ему некуда уйти' },
  },
  // Сb3 gives check along b3–g8: 1…c4 closes the line first and attacks the bishop second
  { name: 'trappedPiece (−): no line', fen: '6k1/8/8/1pp5/8/1B6/P1P5/4K3 b - - 0 1', uci: 'c5c4', lacks: ['trappedPiece'], first: 'answerCheck', has: ['attack'] },
  // ── A: recaptures (the move before captured on the same square — a trade, never a gift) ──
  {
    name: 'recapture: G09 4.bxa3 after 3…Сxa3 (a bishop back for the rook)',
    fen: fenAfter('a4', 'e5', 'h4', 'd5', 'Ra3', 'Bxa3'),
    uci: 'b2a3',
    prev: { uci: 'f8a3', fenBefore: fenAfter('a4', 'e5', 'h4', 'd5', 'Ra3') },
    first: 'recapture',
    lacks: ['freeCapture', 'winMaterial', 'trade'],
    phrase: { recapture: 'забирает слона на а три в ответ' },
  },
  {
    name: 'recapture: G08 5.Фxf3 after 4…Сxf3 is a trade',
    fen: fenAfter('e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5', 'Bxf3'),
    uci: 'd1f3',
    prev: { uci: 'g4f3', fenBefore: fenAfter('e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5') },
    first: 'recapture',
    lacks: ['freeCapture'],
    phrase: { recapture: 'забирает слона на эф три в ответ — это размен' },
  },
  {
    name: 'recapture (−): 3.Фxd4 after 2…Кxd4 still wins a knight for a pawn (E7)',
    fen: E7,
    uci: 'd1d4',
    prev: { uci: 'c6d4', fenBefore: fenAfter('e4', 'Nc6', 'd4') },
    first: 'freeCapture',
    lacks: ['recapture'],
  },
  // ── A: answering a check ──
  { name: 'answerCheck: the king steps away', fen: '4k3/8/8/8/8/8/8/4R1K1 b - - 0 1', uci: 'e8d7', first: 'answerCheck', phrase: { answerCheck: 'уходит королём от шаха' } },
  {
    name: 'answerCheck: G06 6…c6 closes the check and attacks the bishop',
    fen: 'r1bqkb1r/ppp2ppp/5n2/nB1Pp1N1/8/8/PPPP1PPP/RNBQK2R b KQkq - 2 6',
    uci: 'c7c6',
    first: 'answerCheck',
    has: ['attack'],
    said: 'answerCheck',
    phrase: { answerCheck: 'закрывается от шаха' },
  },
  { name: 'answerCheck (−): nobody gives check', fen: E1, uci: 'e2e4', lacks: ['answerCheck'] },
  // ── A: captures ──
  { name: 'freeCapture: undefended knight', fen: '4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1', uci: 'g2d5', first: 'freeCapture', lacks: ['improvePiece'], phrase: { freeCapture: 'забирает коня на дэ пять бесплатно: никто не защищал' } },
  { name: 'freeCapture (−): the knight was defended', fen: '4k3/8/4p3/3n4/4P3/8/8/4K3 w - - 0 1', uci: 'e4d5', lacks: ['freeCapture'], first: 'winMaterial' },
  {
    name: 'winMaterial: pawn takes a defended knight',
    fen: '4k3/8/4p3/3n4/4P3/8/8/4K3 w - - 0 1',
    uci: 'e4d5',
    first: 'winMaterial',
    phrase: { winMaterial: 'выгодно бьёт коня на дэ пять: даже после размена в плюсе' },
  },
  { name: 'winMaterial: pawn takes a defended rook', fen: '4k3/8/2p5/3r4/4P3/8/8/4K3 w - - 0 1', uci: 'e4d5', first: 'winMaterial' },
  { name: 'winMaterial (−): an even trade', fen: '4k3/8/2p5/3n4/8/8/6B1/4K3 w - - 0 1', uci: 'g2d5', lacks: ['winMaterial', 'freeCapture'], first: 'trade' },
  // ── A: safety ──
  { name: 'defendMate: luft against a back-rank mate', fen: '1r4k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1', uci: 'h2h3', first: 'defendMate', phrase: { defendMate: 'закрывает угрозу мата' } },
  { name: 'defendMate (−): a move that ignores the threat', fen: '1r4k1/5ppp/8/8/8/8/P4PPP/6K1 w - - 0 1', uci: 'a2a3', lacks: ['defendMate', 'quiet'] },
  { name: 'defendMate (−): no threat at all', fen: START, uci: 'h2h3', lacks: ['defendMate'] },
  { name: 'escape: the attacked knight jumps to safety', fen: '4k3/8/8/8/3p4/4N3/8/4K3 w - - 0 1', uci: 'e3f5', first: 'escape', phrase: { escape: 'уводит коня из-под боя' } },
  { name: 'escape: the attacked rook leaves (and pins)', fen: '4k3/8/8/4q3/8/8/8/R4K2 w - - 0 1', uci: 'a1e1', has: ['escape'] },
  { name: 'escape (−): into another attack', fen: '4k3/8/8/1p6/3p4/4N3/8/4K3 w - - 0 1', uci: 'e3c4', lacks: ['escape'] },
  { name: 'escape (−): nothing was attacked', fen: START, uci: 'g1f3', lacks: ['escape'] },
  { name: 'defend: the rook guards the attacked knight', fen: '4k3/8/8/8/1b6/2N5/8/R5K1 w - - 0 1', uci: 'a1c1', first: 'defend', phrase: { defend: 'защищает коня на цэ три' } },
  { name: 'defend (−): a king move leaves the knight hanging', fen: '4k3/8/8/8/1b6/2N5/8/R5K1 w - - 0 1', uci: 'g1f1', lacks: ['defend', 'quiet'] },
  { name: 'defend (−): a queen guarding a pawn is not taught', fen: E3, uci: 'd8e7', lacks: ['defend'] },
  { name: 'block: the bishop closes the file', fen: '4r1k1/8/8/8/3PN3/6B1/8/6K1 w - - 0 1', uci: 'g3e5', first: 'block', phrase: { block: 'закрывает коня на е четыре от ладьи' } },
  { name: 'block (−): the bishop goes elsewhere', fen: '4r1k1/8/8/8/3PN3/6B1/8/6K1 w - - 0 1', uci: 'g3f4', lacks: ['block', 'quiet'] },
  // ── B ──
  { name: 'threatMate: the rook comes to the open file', fen: '6k1/5ppp/8/8/8/8/7R/6K1 w - - 0 1', uci: 'h2e2', first: 'threatMate', phrase: { threatMate: 'грозит матом' } },
  { name: 'threatMate (−): the rook stays behind the pawn', fen: '6k1/5ppp/8/8/8/8/7R/6K1 w - - 0 1', uci: 'h2h3', lacks: ['threatMate'], first: 'quiet' },
  {
    name: 'attack: developing with an attack on the queen',
    fen: E3,
    uci: 'g8f6',
    first: 'attack',
    phrase: { attack: 'выводит коня и нападает на ферзя на аш пять' },
  },
  { name: 'attack: two pieces at once (no line: no «вилка»)', fen: '4k3/8/3n1b2/8/3PP3/8/8/4K3 w - - 0 1', uci: 'e4e5', has: ['attack'], phrase: { attack: 'нападает на коня на дэ шесть и слона на эф шесть' } },
  { name: 'attack (−): the attacker itself hangs', fen: E5, uci: 'f3g5', lacks: ['attack'] },
  { name: 'attack (−): the target could already be taken', fen: E6, uci: 'h7h6', lacks: ['attack'] },
  // Кd4 blocks the check of the bishop h8 and «sees» the rook e6 — but the knight is pinned and may not take it
  { name: 'attack (−): the attacker is pinned to its king', fen: '2k4b/8/4r3/1N6/8/4P3/8/K7 w - - 0 1', uci: 'b5d4', lacks: ['attack', 'improvePiece'] },
  { name: 'check: a rook check', fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', uci: 'a1a8', first: 'check', phrase: { check: 'ставит шах — королю придётся спасаться' } },
  { name: 'check (−): the checking queen is simply taken', fen: '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', uci: 'd1d8', lacks: ['check'], first: 'trade' },
  // ── C ──
  {
    name: 'castle: white short castling',
    fen: E8,
    uci: 'e1g1',
    first: 'castle',
    phrase: { castle: 'рокировка: король прячется в домик, а ладья выходит в игру' },
  },
  { name: 'castle: black short castling', fen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq - 5 4', uci: 'e8g8', first: 'castle' },
  { name: 'castle (−): the king walks', fen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq - 5 4', uci: 'e8f8', lacks: ['castle', 'quiet'] },
  { name: 'develop: a knight from home', fen: START, uci: 'b1a3', first: 'develop', phrase: { develop: 'выводит коня в игру' }, lacks: ['centerControl'] },
  { name: 'develop: a black bishop from home', fen: E6, uci: 'f8e7', first: 'develop', phrase: { develop: 'выводит слона в игру' } },
  { name: 'develop (−): a knight that already left home', fen: E5, uci: 'f3g5', lacks: ['develop'] },
  { name: 'develop (−): too late in the game', fen: 'r1bq1rk1/pp3ppp/2n2n2/2bpp3/8/3P1N2/PPP1BPPP/RNBQ1RK1 w - - 0 20', uci: 'b1c3', lacks: ['develop'], has: ['improvePiece'] },
  { name: 'centerPawn: black 1…e5', fen: fenAfter('e4'), uci: 'e7e5', first: 'centerPawn', phrase: { centerPawn: 'ставит пешку в центр' } },
  { name: 'centerPawn (−): 1.c4', fen: START, uci: 'c2c4', lacks: ['centerPawn'] },
  { name: 'supportCenter: black 1…c6', fen: fenAfter('e4'), uci: 'c7c6', first: 'supportCenter', phrase: { supportCenter: 'готовит пешке дорогу в центр' } },
  { name: 'supportCenter (−): d4 is already occupied', fen: fenAfter('d4', 'd5'), uci: 'c2c3', lacks: ['supportCenter'] },
  { name: 'openLine: 1.c4 opens the queen', fen: START, uci: 'c2c4', first: 'openLine', phrase: { openLine: 'открывает дорогу ферзю' } },
  { name: 'openLine (−): 1.h3', fen: START, uci: 'h2h3', lacks: ['openLine'] },
  {
    name: 'aimWeakSquare: 3.Сc4 aims at f7',
    fen: E5,
    uci: 'f1c4',
    has: ['aimWeakSquare'],
    phrase: { aimWeakSquare: 'нацеливается на слабую клетку эф семь рядом с королём' },
  },
  { name: 'aimWeakSquare (−): the black king has castled', fen: 'rnbq1rk1/ppppbppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQ - 4 4', uci: 'f1c4', lacks: ['aimWeakSquare'], has: ['prepareCastle'] },
  { name: 'prepareCastle: 3.Сb5 clears the way', fen: E5, uci: 'f1b5', has: ['prepareCastle'], phrase: { prepareCastle: 'освобождает место для рокировки' } },
  { name: 'prepareCastle (−): the bishop still stands on f1', fen: START, uci: 'g1f3', lacks: ['prepareCastle'] },
  { name: 'centerControl: a rim knight comes to b3', fen: '4k3/8/8/8/8/8/8/N3K3 w - - 0 1', uci: 'a1b3', has: ['centerControl', 'improvePiece'] },
  { name: 'centerControl (−): 1.Кa3 looks away from the centre', fen: START, uci: 'b1a3', lacks: ['centerControl'] },
  // ── P1 (cheap and exact, so they are here) ──
  { name: 'connectRooks: the queen leaves the back rank', fen: 'r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NPBN2/PPP2PPP/R2Q1RK1 w - - 0 1', uci: 'd1d2', first: 'connectRooks' },
  { name: 'connectRooks (−): the bishop is still on c1', fen: 'r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 1', uci: 'd1d2', lacks: ['connectRooks'] },
  { name: 'rookOpenFile: an open file', fen: '4k3/pp4pp/8/8/8/8/PP4PP/R3K3 w - - 0 1', uci: 'a1d1', has: ['rookOpenFile'], phrase: { rookOpenFile: 'ставит ладью на открытую линию' } },
  {
    name: 'rookOpenFile: a half-open file',
    fen: '4k3/pp1p2pp/8/8/8/8/PP4PP/R3K3 w - - 0 1',
    uci: 'a1d1',
    has: ['rookOpenFile'],
    phrase: { rookOpenFile: 'ставит ладью на полуоткрытую линию — смотрит на пешку соперника' },
  },
  { name: 'rookOpenFile (−): behind an own pawn', fen: '4k3/pp4pp/8/8/8/8/PP4PP/R3K3 w - - 0 1', uci: 'a1b1', lacks: ['rookOpenFile'] },
  { name: 'rookSeventh: the rook breaks in', fen: '6k1/pp3pp1/7p/8/8/8/6PP/3R2K1 w - - 0 1', uci: 'd1d7', has: ['rookSeventh', 'attack'] },
  { name: 'rookSeventh (−): the sixth rank', fen: '6k1/pp3pp1/7p/8/8/8/6PP/3R2K1 w - - 0 1', uci: 'd1d6', lacks: ['rookSeventh'] },
  // ── D ──
  { name: 'passedPawn: one step to go', fen: '8/8/4P1k1/8/8/8/8/4K3 w - - 0 1', uci: 'e6e7', first: 'passedPawn', phrase: { passedPawn: 'двигает проходную пешку: до превращения один шаг' } },
  { name: 'passedPawn: four steps to go', fen: '8/8/5k2/8/8/8/4P3/4K3 w - - 0 1', uci: 'e2e4', has: ['passedPawn'], phrase: { passedPawn: 'двигает проходную пешку: до превращения четыре шага' } },
  { name: 'passedPawn (−): 1.e4 is not passed', fen: START, uci: 'e2e4', lacks: ['passedPawn'] },
  { name: 'trade: queens', fen: '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', uci: 'd1d8', first: 'trade', phrase: { trade: 'меняется ферзями' } },
  { name: 'trade: bishop for knight', fen: '4k3/8/2p5/3n4/8/8/6B1/4K3 w - - 0 1', uci: 'g2d5', first: 'trade', phrase: { trade: 'меняет слона на коня' } },
  {
    name: 'trade: when ahead',
    fen: '4k3/8/2p5/3n4/8/8/6B1/R3K3 w - - 0 1',
    uci: 'g2d5',
    first: 'trade',
    phrase: { trade: 'меняет слона на коня: когда фигур больше, размены выгодны' },
  },
  { name: 'trade (−): a winning capture', fen: '4k3/8/4p3/3n4/4P3/8/8/4K3 w - - 0 1', uci: 'e4d5', lacks: ['trade'] },
  // ── E ──
  { name: 'kingActivity: to the centre', fen: E10, uci: 'e3d4', first: 'kingActivity' },
  { name: 'kingActivity: forward, a black pawn on the board', fen: '8/p7/5k2/8/8/4K3/4P3/8 w - - 0 1', uci: 'e3f4', first: 'kingActivity', lacks: ['opposition'] },
  { name: 'kingActivity (−): the king goes back', fen: E10, uci: 'e3d2', lacks: ['kingActivity'] },
  { name: 'kingActivity (−): not in the opening', fen: E2, uci: 'e1e2', lacks: ['kingActivity', 'quiet'] },
  { name: 'restrictKing: the queen cuts the king off', fen: '8/8/8/3k4/8/8/8/4K1Q1 w - - 0 1', uci: 'g1g4', said: 'restrictKing' },
  { name: 'restrictKing: the rook cuts a rank', fen: '8/8/8/8/3k4/8/8/R3K3 w - - 0 1', uci: 'a1a3', first: 'restrictKing', phrase: { restrictKing: 'отнимает у короля клетки — загоняем его к краю' } },
  { name: 'restrictKing (−): the rook does not touch the king', fen: '8/8/8/8/3k4/8/8/R3K3 w - - 0 1', uci: 'a1a2', lacks: ['restrictKing'] },
  { name: 'restrictKing (−): nobody is ahead', fen: E10, uci: 'e3d4', lacks: ['restrictKing'] },
  { name: 'opposition: kings face each other', fen: E10, uci: 'e3f4', has: ['opposition'] },
  { name: 'opposition (−): the opponent still has pawn moves', fen: '8/p7/5k2/8/8/4K3/4P3/8 w - - 0 1', uci: 'e3f4', lacks: ['opposition'] },
  // ── D: space on the queen's side (TEACHING §6.3; conservative) ──
  { name: 'space: 11.b4 controls a5 and c5', fen: E9, uci: 'b2b4', first: 'space', lacks: ['quiet'], phrase: { space: 'забирает пешкой место на стороне ферзя' } },
  { name: 'space: 1.c4 opens the queen and takes space', fen: START, uci: 'c2c4', first: 'openLine', has: ['space'] },
  { name: 'space: …b5 chases the bishop and takes space (the two-knights card)', fen: TWO_KNIGHTS_B5, uci: 'b7b5', first: 'attack', has: ['space'] },
  { name: 'space (−): an a-pawn controls one square only', fen: E9, uci: 'a2a4', lacks: ['space'] },
  { name: 'space (−): not yet the fourth rank', fen: START, uci: 'b2b3', lacks: ['space'] },
  { name: 'space (−): the pawn may simply be taken (2.c4 in the Queen\'s Gambit)', fen: fenAfter('d4', 'd5'), uci: 'c2c4', lacks: ['space'], first: 'fightCenter' },
  { name: 'space (−): a passed pawn runs (that is «passedPawn»)', fen: '8/8/5k2/8/8/1P6/8/4K3 w - - 0 1', uci: 'b3b4', has: ['passedPawn'], lacks: ['space'] },
  { name: 'space (−): the answer to a check', fen: '6k1/8/8/1pp5/8/1B6/P1P5/4K3 b - - 0 1', uci: 'c5c4', first: 'answerCheck', lacks: ['space'] },
  { name: 'space (−): a capture', fen: '4k3/8/8/2p5/1P6/8/8/4K3 w - - 0 1', uci: 'b4c5', lacks: ['space'] },
  // (b4 would control a5 and c5 — but the b-pawn was the knight's only guard against the bishop)
  { name: 'space (−): the push leaves a knight en prise', fen: '4k3/ppp5/8/4b3/8/2N5/1P6/4K3 w - - 0 1', uci: 'b2b4', lacks: ['space', 'quiet'] },
  // ── C: the fight for the centre (1.d4 d5 2.c4 / 2…e6) ──
  {
    name: 'fightCenter: 2.c4 attacks d5 (the Queen\'s Gambit), even without winning it',
    fen: fenAfter('d4', 'd5'),
    uci: 'c2c4',
    first: 'fightCenter',
    lacks: ['attack'],
    phrase: { fightCenter: 'нападает на пешку на дэ пять в центре' },
  },
  { name: 'fightCenter: 2…e5 attacks d4 (guarded by the queen) next to the centre pawn idea', fen: fenAfter('e4', 'd6', 'd4'), uci: 'e7e5', first: 'centerPawn', has: ['fightCenter'], lacks: ['attack'] },
  { name: 'fightCenter (−): 1.e4 attacks no pawn', fen: E1, uci: 'e2e4', lacks: ['fightCenter'] },
  {
    name: 'supportCenter: 2…e6 supports d5 attacked by c4',
    fen: fenAfter('d4', 'd5', 'c4'),
    uci: 'e7e6',
    has: ['supportCenter'],
    phrase: { supportCenter: 'поддерживает пешку на дэ пять' },
  },
  // ── F ──
  { name: 'improvePiece: a rim knight', fen: '4k3/8/8/8/8/8/8/N3K3 w - - 0 1', uci: 'a1b3', said: 'improvePiece', phrase: { improvePiece: 'ставит коня активнее: отсюда он видит больше клеток' } },
  { name: 'improvePiece: a bishop in the middlegame', fen: '4r1k1/8/8/8/3PN3/6B1/8/6K1 w - - 0 1', uci: 'g3f4', first: 'improvePiece' },
  { name: 'improvePiece (−): never in the opening', fen: E3, uci: 'd8e7', lacks: ['improvePiece'] },
  { name: 'quiet: a calm middlegame move', fen: E9, uci: 'a2a4', first: 'quiet', lacks: ['space'], phrase: { quiet: 'спокойный крепкий ход' } },
  { name: 'quiet (−): the knight just hangs', fen: E5, uci: 'f3g5', lacks: ['quiet'] },
];

describe('explainMove — every idea on real positions', () => {
  it.each(FIXTURES)('$name', (f) => {
    const ideas = explain(f.fen, f.uci, f.pv, f.score, f.prev);
    const got = ids(ideas);
    if (f.first) expect(got[0]).toBe(f.first);
    if (f.said) expect(pickIdeas(ideas, { stage: 5, max: 1 })[0]?.id).toBe(f.said);
    for (const id of f.has ?? []) expect(got).toContain(id);
    for (const id of f.lacks ?? []) expect(got).not.toContain(id);
    for (const [id, text] of Object.entries(f.phrase ?? {})) expect(find(ideas, id as MoveIdeaId).phraseRu).toBe(text);
  });

  it('every P0 idea (and the cheap P1 ones) has a positive and a negative fixture', () => {
    const positive = new Set<MoveIdeaId>();
    const negative = new Set<MoveIdeaId>();
    for (const f of FIXTURES) {
      if (f.first) positive.add(f.first);
      if (f.said) positive.add(f.said);
      for (const id of f.has ?? []) positive.add(id);
      for (const id of f.lacks ?? []) negative.add(id);
    }
    for (const id of IDEA_PRIORITY) {
      expect(positive, id).toContain(id);
      expect(negative, id).toContain(id);
    }
  });

  it('returns ideas in priority order', () => {
    for (const f of FIXTURES) {
      const got = explainMove({ fen: f.fen, uci: f.uci, ...(f.pv ? { pvUci: f.pv } : {}), ...(f.score ? { lineScore: f.score } : {}) });
      const ranks = got.map((i) => IDEA_PRIORITY.indexOf(i.id));
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });

  it('a line that does not start with the move is read as its continuation', () => {
    const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1';
    expect(ids(explainMove({ fen, uci: 'd5c7', pvUci: ['e8d7', 'c7a8'] }))[0]).toBe('fork');
  });

  it('gives group-A gains in pawns', () => {
    const fork = explain('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', 'd5c7', ['d5c7', 'e8d7', 'c7a8']);
    expect(find(fork, 'fork').gainPawns).toBe(5);
    expect(find(explain('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1', 'e7e8q'), 'promotion').gainPawns).toBe(8);
    expect(find(explain('4k3/8/4p3/3n4/4P3/8/8/4K3 w - - 0 1', 'e4d5'), 'winMaterial').gainPawns).toBe(2);
    expect(find(explain(E4, 'g7g6'), 'defendMate').gainPawns).toBeUndefined();
  });

  it('is empty for an illegal move or a broken FEN (never throws)', () => {
    expect(explainMove({ fen: START, uci: 'e2e5' })).toEqual([]);
    expect(explainMove({ fen: START, uci: 'nonsense' })).toEqual([]);
    expect(explainMove({ fen: 'not a fen', uci: 'e2e4' })).toEqual([]);
  });

  it('uses the given phase instead of computing it', () => {
    // 1.Кf3 declared an endgame at move 30: not «выводит в игру»
    const fen = START.replace(/ 1$/, ' 30');
    expect(ids(explainMove({ fen, uci: 'g1f3', phase: 'endgame' }))).not.toContain('develop');
    expect(ids(explainMove({ fen: START, uci: 'g1f3', phase: 'opening' }))).toContain('develop');
  });
});

// ───────────────────────── the sub-cases of an idea (MoveIdea.variant) ─────────────────────────

interface VariantFixture {
  name: string;
  fen: string;
  uci: string;
  pv?: string[];
  score?: EvalScore;
  prev?: { uci: string; fenBefore: string };
  id: MoveIdeaId;
  /** the expected sub-case; null = the idea fires without one (only the wordings true for every sub-case fit) */
  variant: string | null;
}

const G08_BEFORE = fenAfter('e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5');
const G09_BEFORE = fenAfter('a4', 'e5', 'h4', 'd5', 'Ra3');
const PIN_LINE = ['d4d5', 'g7g6', 'd5c6'];

const VARIANT_FIXTURES: VariantFixture[] = [
  // answerCheck: capture | king | block
  { name: 'the bishop takes the checking bishop (a trade, so no capture idea says it)', fen: '4k3/8/8/p7/1b6/B7/8/4K3 w - - 0 1', uci: 'a3b4', id: 'answerCheck', variant: 'capture' },
  { name: 'the king steps away', fen: '4k3/8/8/8/8/8/8/4R1K1 b - - 0 1', uci: 'e8d7', id: 'answerCheck', variant: 'king' },
  { name: 'G06 6…c6 closes the line', fen: 'r1bqkb1r/ppp2ppp/5n2/nB1Pp1N1/8/8/PPPP1PPP/RNBQK2R b KQkq - 2 6', uci: 'c7c6', id: 'answerCheck', variant: 'block' },
  // attack: one | two | queenDevelop
  { name: '2.Кf3 attacks e5', fen: E2, uci: 'g1f3', id: 'attack', variant: 'one' },
  { name: 'a pawn hits a knight and a bishop (no line: not yet a fork)', fen: '4k3/8/3n1b2/8/3PP3/8/8/4K3 w - - 0 1', uci: 'e4e5', id: 'attack', variant: 'two' },
  { name: '2…Кf6 develops and hits the early queen', fen: E3, uci: 'g8f6', id: 'attack', variant: 'queenDevelop' },
  { name: 'a bishop out of its home square in move 1 hits the queen', fen: 'r3k3/8/8/3q4/8/8/8/5BK1 w - - 0 1', uci: 'f1g2', id: 'attack', variant: 'queenDevelop' },
  // recapture: even | gain (a recapture that only limits a loss has none)
  { name: 'G08 5.Фxf3: a bishop for a bishop', fen: fenAfter('e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5', 'Bxf3'), uci: 'd1f3', prev: { uci: 'g4f3', fenBefore: G08_BEFORE }, id: 'recapture', variant: 'even' },
  { name: 'the knight took a pawn, the pawn takes the knight (the e-pawn takes back: +1)', fen: '4k3/8/4p3/3n4/2P5/8/8/4K3 w - - 0 2', uci: 'c4d5', prev: { uci: 'f6d5', fenBefore: '4k3/8/4pn2/3P4/2P5/8/8/4K3 b - - 0 1' }, id: 'recapture', variant: 'gain' },
  { name: 'G09 4.bxa3: a bishop back for the rook', fen: fenAfter('a4', 'e5', 'h4', 'd5', 'Ra3', 'Bxa3'), uci: 'b2a3', prev: { uci: 'f8a3', fenBefore: G09_BEFORE }, id: 'recapture', variant: null },
  // mateSoon: m2 | m3 | backRank
  { name: 'rook ladder in two', fen: '7k/8/R7/1R6/8/8/8/6K1 w - - 0 1', uci: 'a6a7', pv: ['a6a7', 'h8g8', 'b5b8'], score: MATE_2, id: 'mateSoon', variant: 'm2' },
  { name: 'rook ladder in three', fen: '7k/8/8/R7/1R6/8/8/6K1 w - - 0 1', uci: 'a5a7', pv: ['a5a7', 'h8g8', 'b4b6', 'g8f8', 'b6b8'], score: MATE_3, id: 'mateSoon', variant: 'm3' },
  { name: 'back-rank mate in two', fen: 'r5k1/5ppp/8/8/8/8/4R3/4R1K1 w - - 0 1', uci: 'e2e8', pv: ['e2e8', 'a8e8', 'e1e8'], score: MATE_2, id: 'mateSoon', variant: 'backRank' },
  // pin: king | queen | rook — the piece behind
  { name: 'the rook pins the queen to the king', fen: '4k3/8/8/4q3/8/8/8/R4K2 w - - 0 1', uci: 'a1e1', pv: ['a1e1', 'e5e1', 'f1e1'], id: 'pin', variant: 'king' },
  { name: 'd5 hits the knight pinned to the queen', fen: '4q1k1/1p3ppp/2n5/1B6/3P4/8/5PPP/6K1 w - - 0 1', uci: 'd4d5', pv: PIN_LINE, id: 'pin', variant: 'queen' },
  { name: 'd5 hits the knight pinned to the rook', fen: '4r1k1/1p3ppp/2n5/1B6/3P4/8/5PPP/6K1 w - - 0 1', uci: 'd4d5', pv: PIN_LINE, id: 'pin', variant: 'rook' },
  // skewer: king | queen — the dear piece in front
  { name: 'a check, the queen behind falls', fen: '3q4/8/8/3k4/8/8/8/R3K3 w - - 0 1', uci: 'a1d1', pv: ['a1d1', 'd5e6', 'd1d8'], id: 'skewer', variant: 'king' },
  { name: 'the queen steps aside, the rook behind falls', fen: 'r3k3/8/8/3q4/8/8/8/5BK1 w - - 0 1', uci: 'f1g2', pv: ['f1g2', 'd5d7', 'g2a8'], id: 'skewer', variant: 'queen' },
  // trade: same | diff | ahead
  { name: 'queens', fen: '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', uci: 'd1d8', id: 'trade', variant: 'same' },
  { name: 'a bishop for a knight', fen: '4k3/8/2p5/3n4/8/8/6B1/4K3 w - - 0 1', uci: 'g2d5', id: 'trade', variant: 'diff' },
  { name: 'a bishop for a knight with a rook more', fen: '4k3/8/2p5/3n4/8/8/6B1/R3K3 w - - 0 1', uci: 'g2d5', id: 'trade', variant: 'ahead' },
  // kingActivity: center | forward | pawns
  { name: 'E10 Крd4', fen: E10, uci: 'e3d4', id: 'kingActivity', variant: 'forward' },
  { name: 'along the rank towards the centre', fen: '8/8/5k2/8/8/K7/4P3/8 w - - 0 1', uci: 'a3b3', id: 'kingActivity', variant: 'center' },
  { name: 'back from the centre to stop a passed pawn', fen: '8/8/5k2/8/3K4/1p6/6P1/8 w - - 0 1', uci: 'd4c3', id: 'kingActivity', variant: 'pawns' },
  // develop: center | plain
  { name: '1.Кf3 hits e5 and d4', fen: START, uci: 'g1f3', id: 'develop', variant: 'center' },
  { name: '2.Сc4 hits d5', fen: E2, uci: 'f1c4', id: 'develop', variant: 'center' },
  { name: '1.Кa3 sees no centre square', fen: START, uci: 'b1a3', id: 'develop', variant: 'plain' },
  { name: '3.Сe2 sees no centre square', fen: fenAfter('e4', 'e5', 'Nf3', 'Nc6'), uci: 'f1e2', id: 'develop', variant: 'plain' },
  // supportCenter: pawn | step
  { name: '2…e6 supports d5', fen: fenAfter('d4', 'd5', 'c4'), uci: 'e7e6', id: 'supportCenter', variant: 'pawn' },
  { name: '1…c6 prepares d5', fen: fenAfter('e4'), uci: 'c7c6', id: 'supportCenter', variant: 'step' },
  // rookOpenFile: open | halfOpen
  { name: 'no pawns on the file', fen: '4k3/pp4pp/8/8/8/8/PP4PP/R3K3 w - - 0 1', uci: 'a1d1', id: 'rookOpenFile', variant: 'open' },
  { name: 'only an enemy pawn on the file', fen: '4k3/pp1p2pp/8/8/8/8/PP4PP/R3K3 w - - 0 1', uci: 'a1d1', id: 'rookOpenFile', variant: 'halfOpen' },
];

function explainFixture(f: { fen: string; uci: string; pv?: string[]; score?: EvalScore; prev?: { uci: string; fenBefore: string } }): MoveIdea[] {
  return explain(f.fen, f.uci, f.pv, f.score, f.prev);
}

describe('the sub-cases of an idea (MoveIdea.variant, @gambit/content IDEA_TAILS)', () => {
  it.each(VARIANT_FIXTURES)('$id · $variant — $name', (f) => {
    const got = find(explainFixture(f), f.id);
    if (f.variant === null) expect(got.variant).toBeUndefined();
    else expect(got.variant).toBe(f.variant);
  });

  it('every sub-case of the content spec has a positive fixture and a negative one (the same idea, another sub-case)', () => {
    let checked = 0;
    for (const [id, spec] of Object.entries(IDEA_TAILS) as [MoveIdeaId, { variants?: readonly string[] }][]) {
      for (const v of spec.variants ?? []) {
        expect(VARIANT_FIXTURES.some((f) => f.id === id && f.variant === v), `${id}:${v} positive`).toBe(true);
        expect(VARIANT_FIXTURES.some((f) => f.id === id && f.variant !== v), `${id}:${v} negative`).toBe(true);
        checked += 1;
      }
    }
    // 11 ideas with sub-cases, 28 sub-cases (the content spec)
    expect(checked).toBe(28);
  });

  it('a detector sets only the sub-cases its pool knows; an idea without sub-cases never sets one', () => {
    const all = [...FIXTURES, ...VARIANT_FIXTURES].flatMap((f) => explainMove({ fen: f.fen, uci: f.uci, ...(f.pv ? { pvUci: f.pv } : {}), ...(f.score ? { lineScore: f.score } : {}), ...(f.prev ? { prev: f.prev } : {}) }));
    expect(all.filter((i) => i.variant !== undefined).length).toBeGreaterThan(40);
    for (const i of all) {
      const known = IDEA_TAILS[i.id].variants;
      if (known) expect(known, `${i.id}: ${i.variant}`).toContain(i.variant ?? known[0]);
      else expect(i.variant, i.id).toBeUndefined();
    }
  });

  it('the sub-case never changes the brief phrase', () => {
    // «в центр» is never in the phrase: 1.Кf3 (center) and 1.Кa3 (plain) are told the same way in the brief
    expect(find(explain(START, 'g1f3'), 'develop').phraseRu).toBe('выводит коня в игру');
    expect(find(explain(START, 'b1a3'), 'develop').phraseRu).toBe('выводит коня в игру');
    expect(find(explain(E3, 'g8f6'), 'attack').phraseRu).toBe('выводит коня и нападает на ферзя на аш пять');
    expect(find(explain('4k3/8/8/8/8/8/8/4R1K1 b - - 0 1', 'e8d7'), 'answerCheck').phraseRu).toBe('уходит королём от шаха');
  });

  it('the opponent\'s static ideas carry their sub-case too (an opponent move is told by the same detectors)', () => {
    const { ideas } = explainOpponentMove(fenAfter('e4'), 'c7c6', fenAfter('e4', 'c6'));
    expect(find(ideas, 'supportCenter').variant).toBe('step');
    SEEN.push(...ideas);
  });
});

// ───────────────────────── pickIdeas / joinIdeasRu ─────────────────────────

function fake(id: MoveIdeaId, phraseRu: string, extra: Partial<MoveIdea> = {}): MoveIdea {
  return { id, group: IDEA_GROUP[id], squares: [], phraseRu, phraseYouRu: phraseRu, ...extra };
}

describe('pickIdeas', () => {
  it('one idea: the first by priority; never «смотрит в центр» alone', () => {
    expect(ids(pickIdeas(explain(E2, 'g1f3'), { stage: 5, max: 1 }))).toEqual(['attack']);
    expect(pickIdeas([fake('centerControl', 'смотрит в центр')], { stage: 5, max: 2 })).toEqual([]);
    expect(ids(pickIdeas(explain(E3, 'd8e7'), { stage: 1, max: 2 }))).toEqual(['quiet']);
  });

  it('stages 1–2 allow only the principle pairs; stage 3 any two groups', () => {
    const d6 = explain(E3, 'd7d6');
    expect(ids(pickIdeas(d6, { stage: 1, max: 2 }))).toEqual(['defend']);
    expect(ids(pickIdeas(d6, { stage: 3, max: 2 }))).toEqual(['defend', 'openLine']);
    // a principle pair inside one group is fine on every stage
    expect(ids(pickIdeas(explain(E1, 'e2e4'), { stage: 1, max: 2 }))).toEqual(['centerPawn', 'openLine']);
    // same group, not a named pair → one idea even on stage 5
    const aAndA = [fake('defendMate', 'закрывает угрозу мата'), fake('block', 'закрывает пешку от ферзя')];
    expect(ids(pickIdeas(aAndA, { stage: 5, max: 2 }))).toEqual(['defendMate']);
    // winMaterial + «и спасает» is a named pair
    const winSave = [fake('winMaterial', 'выгодно бьёт коня'), fake('escape', 'уводит слона из-под боя')];
    expect(ids(pickIdeas(winSave, { stage: 1, max: 2 }))).toEqual(['winMaterial', 'escape']);
  });

  it('both phrases together fit into 14 words', () => {
    for (const f of FIXTURES) {
      const ideas = explainMove({ fen: f.fen, uci: f.uci, ...(f.pv ? { pvUci: f.pv } : {}), ...(f.score ? { lineScore: f.score } : {}) });
      for (const stage of [1, 3]) {
        const said = pickIdeas(ideas, { stage, max: 2 });
        expect(said.length).toBeLessThanOrEqual(2);
        const words = said.reduce((n, i) => n + ideaWordCount(i.phraseRu), 0);
        if (said.length === 2) expect(words).toBeLessThanOrEqual(MAX_IDEA_PAIR_WORDS);
      }
    }
    const long = [fake('attack', 'нападает на коня на дэ шесть и слона на эф шесть'), fake('develop', 'выводит коня в игру')];
    expect(ids(pickIdeas(long, { stage: 1, max: 2 }))).toEqual(['attack']);
  });

  it('`avoid` drops ideas (the caller decides what to do when nothing is left)', () => {
    const nf3 = explain(E2, 'g1f3');
    const said = pickIdeas(nf3, { stage: 1, max: 2, avoid: ['attack'] });
    expect(ids(said)).toEqual(['develop', 'centerControl']);
    expect(joinIdeasRu(said)).toBe('выводит коня и смотрит в центр');
    // the «ты» form does not name the knight twice («выводишь коня и конь смотрит в центр»)
    expect(joinIdeasRu(said, 'you')).toBe('выводишь коня, и он смотрит в центр');
    expect(pickIdeas(nf3, { stage: 1, max: 2, avoid: ['attack', 'develop'] })).toEqual([]);
  });

  it('never says the same thing twice', () => {
    // «выводит коня и нападает на ферзя» already says «выводит»
    expect(ids(pickIdeas(explain(E3, 'g8f6'), { stage: 5, max: 2 }))).toEqual(['attack']);
    // «ловит слона» + «нападает на слона» — the same target
    expect(ids(pickIdeas(explain('6k1/8/8/1pp5/8/1B6/P1P5/4K3 b - - 0 1', 'c5c4', ['c5c4', 'b3c4', 'b5c4']), { stage: 5, max: 2 }))).toEqual(['trappedPiece']);
    // the capture of a combination is not an extra «меняет слона на коня»
    const removal = explain('6k1/6pp/5n2/3r2B1/8/8/8/3RK3 w - - 0 1', 'g5f6', ['g5f6', 'g7f6', 'd1d5']);
    expect(ids(pickIdeas(removal, { stage: 5, max: 2 }))).not.toContain('trade');
    // mates and «quiet» stand alone
    const soon = explain('7k/8/R7/1R6/8/8/8/6K1 w - - 0 1', 'a6a7', ['a6a7', 'h8g8', 'b5b8'], MATE_2);
    expect(ids(pickIdeas(soon, { stage: 5, max: 2 }))).toEqual(['mateSoon']);
    expect(ids(pickIdeas([fake('quiet', 'спокойный крепкий ход'), fake('centerControl', 'смотрит в центр')], { stage: 5, max: 2 }))).toEqual(['quiet']);
  });
});

describe('joinIdeasRu', () => {
  it('joins one or two ideas into one phrase', () => {
    expect(joinIdeasRu([])).toBe('');
    expect(joinIdeasRu([fake('develop', 'выводит коня в игру')])).toBe('выводит коня в игру');
    expect(joinIdeasRu([fake('develop', 'выводит коня в игру'), fake('attack', 'нападает на пешку')])).toBe('выводит коня и нападает на пешку');
    const castle = explain(E8, 'e1g1')[0] as MoveIdea;
    expect(joinIdeasRu([castle, fake('attack', 'нападает на пешку')])).toBe(`${castle.phraseRu}; ещё нападает на пешку`);
  });
});

// ───────────────────────── explainOpponentMove ─────────────────────────

describe('explainOpponentMove (§4.3)', () => {
  it('1…e5 puts a pawn in the centre (T2)', () => {
    const opp = explainOpponentMove(fenAfter('e4'), 'e7e5', E2);
    expect(ids(opp.ideas)).toEqual(['centerPawn', 'openLine']);
    expect(opp.wants).toBeNull();
    SEEN.push(...opp.ideas);
  });

  it('names only static ideas — no «вилка» without a line, never «спокойный ход»', () => {
    const fork = explainOpponentMove('4k3/8/3n1b2/8/3PP3/8/8/4K3 w - - 0 1', 'e4e5', '4k3/8/3n1b2/4P3/3P4/8/8/4K3 b - - 0 1');
    expect(ids(fork.ideas)).not.toContain('fork');
    expect(ids(fork.ideas)).toContain('attack');
    expect(explainOpponentMove(E9, 'b2b4', '').ideas).toEqual([]);
    for (const f of FIXTURES) {
      const { ideas } = explainOpponentMove(f.fen, f.uci, '');
      for (const i of ideas) {
        expect(STATIC_IDEA_IDS).toContain(i.id);
        // the same words must fit the bot's move: nobody is «соперник», nothing is «наше»
        expect(i.phraseRu).not.toMatch(/соперник|заберём|загоняем/);
      }
      SEEN.push(...ideas);
    }
  });

  it('what the opponent wants: the engine threat when given, else a static mate in one', () => {
    const threat: Threat = { uci: 'c6d4', san: 'Nd4', motif: 'fork', targetSquares: ['c2'], gainCp: 300 };
    expect(explainOpponentMove(E2, 'd1h5', E3, { threat }).wants).toBe(threat);
    const before = fenAfter('e4', 'e5', 'Qh5', 'Nc6');
    expect(explainOpponentMove(before, 'f1c4', E4, { threat: null }).wants?.uci).toBe('h5f7');
    // a broken `childFenAfter` falls back to the position after the move
    expect(explainOpponentMove(before, 'f1c4', 'broken').wants?.uci).toBe('h5f7');
  });

  it('an illegal move has no ideas', () => {
    expect(explainOpponentMove(START, 'e2e5', START).ideas).toEqual([]);
  });
});

describe('isEarlyQueenMove', () => {
  it('the queen leaves home early while minor pieces sleep', () => {
    expect(isEarlyQueenMove(E2, 'd1h5')).toBe(true);
    expect(isEarlyQueenMove(E2, 'd1f3')).toBe(true);
    expect(isEarlyQueenMove(E2, 'g1f3')).toBe(false);
    // developed minors or a late move: not «early»
    expect(isEarlyQueenMove('r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7', 'd1e2')).toBe(false);
    expect(isEarlyQueenMove(E2.replace(/ 2$/, ' 11'), 'd1h5')).toBe(false);
  });
});

// ───────────────────────── §4.4 explainMoveLoss ─────────────────────────

describe('explainMoveLoss (§4.4)', () => {
  it('3.Кg5 after the advice Сc4 / d4: the reply takes the knight, three pawns of material (E5 → E6)', () => {
    const loss = explainMoveLoss({
      judgement: {
        fenBefore: E5,
        fenAfter: E6,
        uci: 'f3g5',
        winPctLoss: 55,
        materialLossPawns: 3,
        refutationPvUci: ['d8g5', 'd2d4'],
        evalAfter: { cp: -611, mate: null },
      },
      adviceUci: ['f1c4', 'd2d4'],
    });
    expect(loss.severityRu).toBe('заметно слабее');
    expect(loss.reply).toMatchObject({ uci: 'd8g5', san: 'Qxg5', spokenRu: 'ферзь бьёт на же пять' });
    expect(ids(loss.reply?.ideas ?? [])[0]).toBe('freeCapture');
    expect(loss.factsRu).toEqual([
      'соперник может ответить: ферзь бьёт на же пять — забирает коня на же пять бесплатно: никто не защищал',
      'в итоге теряется материал: три пешки',
    ]);
    expect(ids(loss.missing)).toContain('develop');
  });

  it('2.a3 instead of 2.Кf3: the reply attacks e4, the move does not develop', () => {
    const loss = explainMoveLoss({
      judgement: {
        fenBefore: E2,
        fenAfter: play(E2, 'a2a3'),
        uci: 'a2a3',
        winPctLoss: 5.5,
        materialLossPawns: 0,
        refutationPvUci: ['g8f6'],
        evalAfter: { cp: 5, mate: null },
      },
      adviceUci: ['g1f3', 'b1c3'],
    });
    expect(loss.severityRu).toBe('чуть слабее');
    expect(loss.factsRu).toEqual([
      'соперник может ответить: конь на эф шесть — нападает на пешку на е четыре',
      'этот ход не выводит коня или слона и не борется за центр — а совет это делал',
    ]);
    expect(ids(loss.missing)).toEqual(['develop', 'centerControl']);
  });

  it('a mate is told as a mate; nothing verifiable → «так тоже можно, но чуть слабее»', () => {
    const mated = explainMoveLoss({
      judgement: { fenBefore: E2, fenAfter: play(E2, 'a2a3'), uci: 'a2a3', winPctLoss: 40, materialLossPawns: 0, refutationPvUci: [], evalAfter: { cp: null, mate: -2 } },
    });
    expect(mated.factsRu).toEqual(['соперник может поставить мат за два хода']);
    expect(mated.reply).toBeNull();

    const quiet = { fenBefore: E9, fenAfter: play(E9, 'b2b4'), uci: 'b2b4', materialLossPawns: 0, refutationPvUci: [], evalAfter: { cp: 10, mate: null } };
    // the played move is one of the advised moves: nothing is «missing»
    const nothing = explainMoveLoss({ judgement: { ...quiet, winPctLoss: 9.9 }, adviceUci: ['a2a4', 'b2b4'] });
    expect(nothing.factsRu).toEqual(['так тоже можно, но чуть слабее']);
    expect(nothing.missing).toEqual([]);
    expect(nothing.severityRu).toBe('чуть слабее');
    expect(explainMoveLoss({ judgement: { ...quiet, winPctLoss: 10 } }).severityRu).toBe('заметно слабее');
  });

  it('facts are Latin-free', () => {
    const loss = explainMoveLoss({
      judgement: { fenBefore: E5, fenAfter: E6, uci: 'f3g5', winPctLoss: 55, materialLossPawns: 3, refutationPvUci: ['d8g5'], evalAfter: { cp: -611, mate: null } },
      adviceUci: ['f1c4'],
    });
    for (const fact of loss.factsRu) expect(fact).not.toMatch(/[A-Za-z]/);
  });
});

// ───────────────────────── language rules (run last: SEEN is filled above) ─────────────────────────

describe('phrases', () => {
  it('no Latin letters, at most 12 words, the right group, known concept cards, real squares', () => {
    expect(SEEN.length).toBeGreaterThan(150);
    for (const i of SEEN) {
      for (const text of [i.phraseRu, i.phraseYouRu]) {
        expect(text, i.id).not.toMatch(/[A-Za-z]/);
        expect(ideaWordCount(text), text).toBeLessThanOrEqual(MAX_IDEA_WORDS);
        expect(text.trim()).toBe(text);
        expect(text.length).toBeGreaterThan(0);
      }
      expect(i.group).toBe(IDEA_GROUP[i.id]);
      if (i.conceptId !== undefined) expect(KNOWN_CONCEPTS, i.conceptId).toContain(i.conceptId);
      for (const sq of i.squares) expect(sq).toMatch(/^[a-h][1-8]$/);
    }
  });

  it('the «ты» phrase is a different wording where the verb has a person', () => {
    const nf3 = find(explain(E2, 'g1f3'), 'attack');
    expect(nf3.phraseYouRu).toBe('нападаешь на пешку на е пять');
    const mate = find(explain('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8'), 'mate');
    expect(mate.phraseYouRu).toBe('ставишь мат');
  });
});
