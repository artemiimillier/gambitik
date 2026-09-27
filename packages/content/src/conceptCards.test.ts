import { describe, expect, it } from 'vitest';
import type { Chess, PieceSymbol, Square } from 'chess.js';
import type { ConceptCard, MotifId } from '@gambit/shared';
import {
  CONCEPT_CARDS,
  getConceptCard,
  getConceptCardByMotif,
  getConceptCardByTheme,
  getConceptCardsForStage,
} from './conceptCards.ts';
import { CURRICULUM } from './curriculum.ts';
import { THEME_TITLES_RU, isLichessPuzzleTheme } from './themes.ts';
import {
  LATIN_RE,
  PLACEHOLDER_RE,
  canForceMate,
  destinations,
  everyReplyLosesToMate,
  load,
  materialBalance,
  opponentKingCapturable,
  opposite,
  playLine,
  sentenceCount,
} from './testUtils.ts';

/** Every MotifId of contracts.ts. `satisfies` makes the compiler complain when the union grows. */
const ALL_MOTIFS = {
  hangingPiece: true,
  freeCapture: true,
  badTrade: true,
  fork: true,
  pin: true,
  skewer: true,
  discoveredAttack: true,
  doubleCheck: true,
  removeDefender: true,
  trappedPiece: true,
  backRankMate: true,
  mateIn1: true,
  mateIn2: true,
  mateIn3: true,
  promotion: true,
  kingSafety: true,
  development: true,
  center: true,
} satisfies Record<MotifId, true>;

const REQUIRED_CARD_IDS = [
  'thinking-routine',
  'opening-center',
  'opening-development',
  'opening-king-safety',
  'endgame-queen-mate',
  'endgame-rook-mate',
  'endgame-square-rule',
  'endgame-opposition',
  'endgame-ladder-mate',
];

/**
 * What each example CLAIMS (in its comment) — verified on the board.
 * Key: `${cardId}#${exampleIndex}`. Every example of every card must have an entry.
 */
interface ExampleClaims {
  /** State of the final position of the solution line. */
  finalIs?: 'checkmate' | 'stalemate' | 'insufficientMaterial';
  /** The first move forces mate within this many own moves against EVERY defence (brute force). */
  forcedMateIn?: number;
  /** Net material won by the solving side along the line, in pawns (at least). */
  minGain?: number;
  /** The first move captures a piece of this type … */
  firstCaptures?: PieceSymbol;
  /** … and the capturing piece cannot be recaptured. */
  firstCaptureIsFree?: boolean;
  /** After ply N (1-based) the piece that just moved attacks all these squares (fork / threat). */
  attacksAfterPly?: { ply: number; targets: Square[] };
  /** A discovered attack: `from` does not attack `target` before the first move, but does after it. */
  discovers?: { from: Square; target: Square };
  /** After the first move the piece on `square` is pinned: its legal moves may only go to `mayGoTo`. */
  pinnedAfterFirst?: { square: Square; mayGoTo: Square[] };
  /** Before the first move the piece on `defender` protects `target`. */
  defends?: { defender: Square; target: Square };
  /** After the first move the king is attacked by two pieces at once. */
  doubleCheckAfterFirst?: boolean;
  /** After the first move every legal move of the piece on `square` lands on an attacked square. */
  trappedAfterFirst?: Square;
  /** The last move of the line captures a piece of this type. */
  lastCaptures?: PieceSymbol;
  /** The last move of the line is a promotion to this piece. */
  lastPromotesTo?: PieceSymbol;
  /** A tempting/careless alternative from the start position and what it leads to. */
  alternative?: { sans: string[]; finalIs: 'checkmate' | 'stalemate' };
  /** The first move is castling. */
  firstIsCastling?: boolean;
}

const CLAIMS: Record<string, ExampleClaims> = {
  'piece-values#0': { firstCaptures: 'r', firstCaptureIsFree: true, minGain: 5 },
  'hanging-piece#0': { firstCaptures: 'n', firstCaptureIsFree: true, minGain: 3 },
  'hanging-piece#1': { firstCaptures: 'b', firstCaptureIsFree: true, minGain: 3 },
  'free-capture#0': { firstCaptures: 'b', firstCaptureIsFree: true, minGain: 3 },
  'free-capture#1': { firstCaptures: 'r', firstCaptureIsFree: true, minGain: 5 },
  'bad-trade#0': { firstCaptures: 'r', lastCaptures: 'n', minGain: 2 },
  // Careless development instead of defending allows the scholar's mate.
  'thinking-routine#0': { alternative: { sans: ['Nf6', 'Qxf7#'], finalIs: 'checkmate' } },
  'opening-center#0': {},
  'opening-development#0': { attacksAfterPly: { ply: 1, targets: ['e5'] } },
  'opening-king-safety#0': { firstIsCastling: true },
  'opening-early-queen#0': { attacksAfterPly: { ply: 1, targets: ['d5'] } },
  'scholars-mate#0': { finalIs: 'checkmate', forcedMateIn: 1 },
  'scholars-mate#1': { alternative: { sans: ['d6', 'Qxf7#'], finalIs: 'checkmate' } },
  'mate-in-1#0': { finalIs: 'checkmate', forcedMateIn: 1 },
  'mate-in-1#1': { finalIs: 'checkmate', forcedMateIn: 1 },
  'back-rank-mate#0': { finalIs: 'checkmate', forcedMateIn: 1 },
  'back-rank-mate#1': { finalIs: 'checkmate', forcedMateIn: 2 },
  'stalemate#0': { finalIs: 'checkmate', forcedMateIn: 3, alternative: { sans: ['Qf7'], finalIs: 'stalemate' } },
  'endgame-ladder-mate#0': { finalIs: 'checkmate', forcedMateIn: 2 },
  'endgame-ladder-mate#1': { finalIs: 'checkmate', forcedMateIn: 3 },
  'endgame-queen-mate#0': { finalIs: 'checkmate', forcedMateIn: 3 },
  'endgame-queen-mate#1': { finalIs: 'checkmate', forcedMateIn: 1 },
  'endgame-rook-mate#0': { finalIs: 'checkmate', forcedMateIn: 1 },
  'endgame-rook-mate#1': { finalIs: 'checkmate', forcedMateIn: 2 },
  'fork#0': { attacksAfterPly: { ply: 1, targets: ['e8', 'b5'] }, lastCaptures: 'q', minGain: 9 },
  'fork#1': { attacksAfterPly: { ply: 1, targets: ['d6', 'f6'] }, lastCaptures: 'n', minGain: 3 },
  'pin#0': { pinnedAfterFirst: { square: 'c6', mayGoTo: ['b5', 'd7'] }, lastCaptures: 'q', minGain: 6 },
  'pin#1': { pinnedAfterFirst: { square: 'c6', mayGoTo: [] }, attacksAfterPly: { ply: 1, targets: ['c6'] }, lastCaptures: 'n', minGain: 3 },
  'skewer#0': { attacksAfterPly: { ply: 1, targets: ['e4'] }, lastCaptures: 'q', minGain: 9 },
  'skewer#1': { attacksAfterPly: { ply: 1, targets: ['d5'] }, lastCaptures: 'r', minGain: 5 },
  'mate-in-2#0': { finalIs: 'checkmate', forcedMateIn: 2 },
  'endgame-square-rule#0': { lastPromotesTo: 'q', minGain: 8 },
  'endgame-square-rule#1': { lastCaptures: 'q', finalIs: 'insufficientMaterial' },
  'endgame-opposition#0': { lastPromotesTo: 'q', minGain: 8 },
  'endgame-opposition#1': { finalIs: 'stalemate' },
  'discovered-attack#0': { discovers: { from: 'd1', target: 'd8' }, lastCaptures: 'q', minGain: 7 },
  'double-check#0': { doubleCheckAfterFirst: true, finalIs: 'checkmate', forcedMateIn: 1 },
  'remove-defender#0': { defends: { defender: 'f6', target: 'd5' }, firstCaptures: 'n', lastCaptures: 'b', minGain: 3 },
  'deflection#0': { defends: { defender: 'b8', target: 'c8' }, lastCaptures: 'r', lastPromotesTo: 'q', finalIs: 'checkmate', forcedMateIn: 2 },
  'attraction#0': { attacksAfterPly: { ply: 3, targets: ['h8', 'd8'] }, lastCaptures: 'q', minGain: 5 },
  'trapped-piece#0': { trappedAfterFirst: 'h2', lastCaptures: 'b', minGain: 3 },
  'mate-in-3#0': { doubleCheckAfterFirst: true, finalIs: 'checkmate', forcedMateIn: 3 },
  'promotion#0': { lastPromotesTo: 'q', minGain: 8 },
  'promotion#1': { attacksAfterPly: { ply: 1, targets: ['g7', 'c7'] }, lastCaptures: 'q', minGain: 11 },
  'smothered-mate#0': { finalIs: 'checkmate', forcedMateIn: 2 },
};

function expectFinal(chess: Chess, finalIs: NonNullable<ExampleClaims['finalIs']>): void {
  if (finalIs === 'checkmate') expect(chess.isCheckmate()).toBe(true);
  if (finalIs === 'stalemate') expect(chess.isStalemate()).toBe(true);
  if (finalIs === 'insufficientMaterial') expect(chess.isInsufficientMaterial()).toBe(true);
}

const ALL_EXAMPLES = CONCEPT_CARDS.flatMap((card) =>
  card.examples.map((example, index) => ({ key: `${card.id}#${index}`, card, example })),
);

describe('CONCEPT_CARDS — structure', () => {
  it('has at least 24 cards with unique kebab-case ids', () => {
    expect(CONCEPT_CARDS.length).toBeGreaterThanOrEqual(24);
    const ids = CONCEPT_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('covers every MotifId of contracts.ts', () => {
    for (const motif of Object.keys(ALL_MOTIFS) as MotifId[]) {
      const card = getConceptCardByMotif(motif);
      expect(card, `no concept card for motif '${motif}'`).toBeDefined();
      expect(card?.motif).toBe(motif);
    }
  });

  it('contains the thinking routine, the three opening principles and the key endgames', () => {
    for (const id of REQUIRED_CARD_IDS) expect(getConceptCard(id), id).toBeDefined();
    expect(getConceptCard('opening-center')?.motif).toBe('center');
    expect(getConceptCard('opening-development')?.motif).toBe('development');
    expect(getConceptCard('opening-king-safety')?.motif).toBe('kingSafety');
  });

  it.each(CONCEPT_CARDS.map((c) => [c.id, c] as const))('%s: well-formed texts', (_id, card: ConceptCard) => {
    expect(card.stage).toBeGreaterThanOrEqual(1);
    expect(card.stage).toBeLessThanOrEqual(CURRICULUM.length);
    expect(card.examples.length).toBeGreaterThanOrEqual(1);

    const sentences = sentenceCount(card.explanation);
    expect(sentences, `explanation has ${sentences} sentences`).toBeGreaterThanOrEqual(2);
    expect(sentences, `explanation has ${sentences} sentences`).toBeLessThanOrEqual(5);
    expect(card.question.trim().endsWith('?') || card.question.includes('?')).toBe(true);

    const spoken = [card.title, card.explanation, card.question, ...card.examples.map((e) => e.comment)];
    for (const text of spoken) {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text, `Latin letters in: ${text}`).not.toMatch(LATIN_RE);
      expect(text, `placeholder in: ${text}`).not.toMatch(PLACEHOLDER_RE);
    }
  });

  it('references only real Lichess themes that have a Russian title', () => {
    for (const card of CONCEPT_CARDS) {
      for (const theme of card.lichessThemes) {
        expect(isLichessPuzzleTheme(theme), `${card.id}: '${theme}' is not a Lichess CSV tag`).toBe(true);
        expect(THEME_TITLES_RU[theme], `${card.id}: no title for '${theme}'`).toBeTruthy();
      }
    }
  });

  it('every tactical theme drilled in stages 1–5 has a concept card', () => {
    // Length tags and three advanced motifs have no dedicated card (yet).
    const withoutCard = new Set(['short', 'long', 'veryLong', 'defensiveMove', 'intermezzo', 'xRayAttack']);
    for (const stage of CURRICULUM.filter((s) => s.stage <= 5)) {
      for (const theme of stage.puzzleThemes) {
        if (withoutCard.has(theme)) continue;
        expect(getConceptCardByTheme(theme), `stage ${stage.stage}: no card for theme '${theme}'`).toBeDefined();
      }
    }
  });

  it('a card is never introduced later than the first stage that drills its theme', () => {
    for (const card of CONCEPT_CARDS) {
      if (card.motif === undefined) continue;
      const primaryTheme = card.lichessThemes[0];
      if (primaryTheme === undefined) continue;
      const firstStage = CURRICULUM.find((s) => s.puzzleThemes.includes(primaryTheme));
      if (firstStage) expect(card.stage, card.id).toBeLessThanOrEqual(firstStage.stage);
    }
  });
});

describe('getConceptCard', () => {
  it('finds a card by id, by MotifId and by Lichess theme key', () => {
    expect(getConceptCard('fork')?.id).toBe('fork');
    expect(getConceptCard('hangingPiece')?.id).toBe('hanging-piece');
    expect(getConceptCard('removeDefender')?.id).toBe('remove-defender');
    expect(getConceptCard('capturingDefender')?.id).toBe('remove-defender');
    expect(getConceptCard('smotheredMate')?.id).toBe('smothered-mate');
    expect(getConceptCard('no-such-card')).toBeUndefined();
    expect(getConceptCard('')).toBeUndefined();
  });

  it('getConceptCardsForStage returns the cards of one stage', () => {
    const stage2 = getConceptCardsForStage(2);
    expect(stage2.length).toBeGreaterThan(0);
    expect(stage2.every((c) => c.stage === 2)).toBe(true);
    expect(getConceptCardsForStage(99)).toEqual([]);
  });
});

describe('CONCEPT_CARDS — every FEN and every solution line is machine-verified', () => {
  it('has a claims entry for every example (and no stale entries)', () => {
    expect(Object.keys(CLAIMS).sort()).toEqual(ALL_EXAMPLES.map((e) => e.key).sort());
  });

  it.each(ALL_EXAMPLES.map((e) => [e.key, e] as const))('%s', (key, { card, example }) => {
    const claims = CLAIMS[key] ?? {};

    // 1. The position is legal and not already over.
    const chess = load(example.fen);
    expect(opponentKingCapturable(example.fen), 'the side not to move is in check').toBe(false);
    expect(chess.isGameOver()).toBe(false);
    expect(example.solutionSan.length).toBeGreaterThanOrEqual(1);

    const solver = chess.turn();
    const balanceBefore = materialBalance(chess, solver);

    // 2. Claims about the start position.
    if (claims.defends) {
      expect(chess.attackers(claims.defends.target, opposite(solver))).toContain(claims.defends.defender);
    }
    if (claims.discovers) {
      expect(chess.attackers(claims.discovers.target, solver)).not.toContain(claims.discovers.from);
    }
    if (claims.alternative) {
      const alt = load(example.fen);
      playLine(alt, claims.alternative.sans);
      expectFinal(alt, claims.alternative.finalIs);
    }

    // 3. Every move is legal and written in canonical SAN.
    const moves = playLine(chess, example.solutionSan);
    const first = moves[0];
    const last = moves[moves.length - 1];
    if (first === undefined || last === undefined) throw new Error('empty solution');
    // The solving side makes the last move of the line. Two demos intentionally end with the
    // opponent's move: the accepted recapture of a good trade and the stalemating move of the attacker.
    if (key !== 'bad-trade#0' && key !== 'endgame-opposition#1') expect(last.color).toBe(solver);

    // 4. Claims about the first move.
    const afterFirst = load(example.fen);
    playLine(afterFirst, example.solutionSan.slice(0, 1));
    if (claims.firstCaptures) expect(first.captured).toBe(claims.firstCaptures);
    if (claims.firstCaptureIsFree) expect(afterFirst.isAttacked(first.to, opposite(solver))).toBe(false);
    if (claims.firstIsCastling) expect(first.isKingsideCastle() || first.isQueensideCastle()).toBe(true);
    if (claims.discovers) {
      expect(afterFirst.attackers(claims.discovers.target, solver)).toContain(claims.discovers.from);
    }
    if (claims.doubleCheckAfterFirst) {
      const [king] = afterFirst.findPiece({ type: 'k', color: opposite(solver) });
      if (king === undefined) throw new Error('no king');
      expect(afterFirst.attackers(king, solver).length).toBe(2);
    }
    if (claims.pinnedAfterFirst) {
      const { square, mayGoTo } = claims.pinnedAfterFirst;
      expect(afterFirst.get(square)?.color).toBe(opposite(solver));
      for (const to of destinations(afterFirst, square)) expect(mayGoTo).toContain(to);
    }
    if (claims.trappedAfterFirst) {
      const square = claims.trappedAfterFirst;
      expect(afterFirst.get(square)?.color).toBe(opposite(solver));
      for (const to of destinations(afterFirst, square)) {
        const probe = load(afterFirst.fen());
        probe.move({ from: square, to });
        expect(probe.isAttacked(to, solver), `${square}-${to} would be a safe escape`).toBe(true);
      }
    }
    if (claims.forcedMateIn !== undefined) {
      expect(example.solutionSan.length).toBe(claims.forcedMateIn * 2 - 1);
      const forced =
        claims.forcedMateIn === 1 ? afterFirst.isCheckmate() : everyReplyLosesToMate(afterFirst, claims.forcedMateIn - 1);
      expect(forced, 'the first move does not force mate against every defence').toBe(true);
      // … and the card does not undersell the position: there is no faster mate.
      if (claims.forcedMateIn > 1) {
        expect(canForceMate(load(example.fen), claims.forcedMateIn - 1), 'a faster mate exists').toBe(false);
      }
    }

    // 5. Claims about a position in the middle of the line.
    if (claims.attacksAfterPly) {
      const { ply, targets } = claims.attacksAfterPly;
      const probe = load(example.fen);
      const played = playLine(probe, example.solutionSan.slice(0, ply));
      const mover = played[played.length - 1];
      if (mover === undefined) throw new Error('bad ply');
      for (const target of targets) {
        expect(probe.attackers(target, mover.color), `${mover.san} does not attack ${target}`).toContain(mover.to);
      }
    }

    // 6. Claims about the end of the line.
    if (claims.lastCaptures) expect(last.captured).toBe(claims.lastCaptures);
    if (claims.lastPromotesTo) expect(last.promotion).toBe(claims.lastPromotesTo);
    if (claims.finalIs) expectFinal(chess, claims.finalIs);
    if (claims.minGain !== undefined) {
      expect(materialBalance(chess, solver) - balanceBefore).toBeGreaterThanOrEqual(claims.minGain);
    }

    // 7. Motif-specific invariants that hold for every example of the card.
    const lastSan = example.solutionSan[example.solutionSan.length - 1] ?? '';
    if (lastSan.endsWith('#')) expect(chess.isCheckmate()).toBe(true);
    if (card.motif === 'mateIn1') expect(example.solutionSan).toHaveLength(1);
    if (card.motif === 'mateIn2') expect(example.solutionSan).toHaveLength(3);
    if (card.motif === 'mateIn3') expect(example.solutionSan).toHaveLength(5);
    if (card.motif === 'mateIn1' || card.motif === 'mateIn2' || card.motif === 'mateIn3' || card.motif === 'backRankMate') {
      expect(chess.isCheckmate()).toBe(true);
    }
    if (card.motif === 'backRankMate') {
      const [king] = chess.findPiece({ type: 'k', color: opposite(solver) });
      expect(king?.[1]).toBe(solver === 'w' ? '8' : '1');
    }
    if (card.motif === 'promotion') expect(example.solutionSan.some((san) => san.includes('='))).toBe(true);
    if (card.motif === 'kingSafety') expect(example.solutionSan).toContain('O-O');
  });
});
