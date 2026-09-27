import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../content.ts';
import { strategyCardSchema } from '../schemas.ts';
import { StrategyHistory } from './history.ts';
import {
  FALLBACK_STRATEGIES,
  GENERIC_STRATEGIES,
  STRATEGY_HISTORY_LIMIT,
  againstKeyFor,
  createStrategyLibrary,
  eligibleStrategies,
  firstChildMove,
  pickStrategyBuiltin,
  varietyCandidates,
} from './library.ts';
import type { LibraryCard } from './library.ts';

const ids = (cards: readonly { id: string }[]): string[] => cards.map((c) => c.id);

describe('built-in strategy cards', () => {
  it('are valid cards with a legal first move and Latin-free spoken texts', () => {
    for (const card of [...FALLBACK_STRATEGIES, ...GENERIC_STRATEGIES]) {
      expect(strategyCardSchema.safeParse(card).success, card.id).toBe(true);
      for (const text of [card.titleRu, card.titleAccRu ?? '', card.ideaRu, ...card.stepsRu, ...card.middlegameRu]) expect(text, card.id).not.toMatch(/[A-Za-z]/);
      const opponent = card.side === 'b' ? (card.against === 'd4' ? 'd2d4' : 'e2e4') : undefined;
      if (card.lineSan.length > 0) expect(firstChildMove(card, card.side, opponent), card.id).not.toBeNull();
    }
  });
});

describe('who may play which card (built-in rule)', () => {
  const cards = FALLBACK_STRATEGIES;

  it('filters by colour and the opponent’s first move', () => {
    expect(ids(eligibleStrategies(cards, { childColor: 'w', stage: 1 }))).toEqual(['italian', 'london']);
    expect(ids(eligibleStrategies(cards, { childColor: 'b', stage: 1, opponentFirstUci: 'e2e4' }))).toEqual(['open-game']);
    expect(ids(eligibleStrategies(cards, { childColor: 'b', stage: 1, opponentFirstUci: 'd2d4' }))).toEqual(['orthodox']);
    // unknown first move: every Black card (the game asks again once the move is known)
    expect(ids(eligibleStrategies(cards, { childColor: 'b', stage: 1 }))).toEqual(['open-game', 'orthodox']);
    expect(eligibleStrategies(cards, { childColor: 'b', stage: 1, opponentFirstUci: 'c2c4' })).toEqual([]);
    expect(againstKeyFor('g1f3')).toBe('other');
    expect(againstKeyFor(undefined)).toBeNull();
  });

  it('gives a child below every card the easiest ones', () => {
    const hard: LibraryCard[] = cards.map((c, i) => ({ ...c, minStage: 4 + i }));
    expect(ids(eligibleStrategies(hard, { childColor: 'w', stage: 1 }))).toEqual(['italian']);
  });
});

describe('variety', () => {
  const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('never offers the last strategies while an alternative exists', () => {
    expect(ids(varietyCandidates(cards, ['a', 'b'], 3))).toEqual(['c', 'd']);
    expect(ids(varietyCandidates(cards, ['a', 'b', 'c', 'd'], 3))).toEqual(['a']);
    // everything played lately: the least recently played half
    expect(ids(varietyCandidates(cards, ['a', 'b', 'c', 'd'], 5))).toEqual(['a', 'b']);
    expect(ids(varietyCandidates([{ id: 'x' }], ['x'], 3))).toEqual(['x']);
  });

  it('the built-in pick prefers a never-played card', () => {
    expect(pickStrategyBuiltin(cards, ['a'])?.id).toBe('b');
    expect(pickStrategyBuiltin(cards, ['a', 'b', 'c', 'd'])?.id).toBe('a');
    expect(pickStrategyBuiltin([], [])).toBeNull();
  });
});

describe('the first move of a card', () => {
  const italian = FALLBACK_STRATEGIES.find((c) => c.id === 'italian') as LibraryCard;
  const openGame = FALLBACK_STRATEGIES.find((c) => c.id === 'open-game') as LibraryCard;

  it('is legal: White from the start, Black after the opponent’s move', () => {
    expect(firstChildMove(italian, 'w')).toEqual({ san: 'e4', uci: 'e2e4', fenBefore: new Chess().fen() });
    expect(firstChildMove(openGame, 'b', 'e2e4')?.uci).toBe('e7e5');
    expect(firstChildMove(openGame, 'b')).toBeNull();
    expect(firstChildMove(openGame, 'b', 'e2e5')).toBeNull(); // not a legal opening move
  });

  it('understands a line written with both sides’ moves', () => {
    const both: LibraryCard = { ...openGame, lineSan: ['e4', 'e5', 'Nf3'] };
    expect(firstChildMove(both, 'b', 'e2e4')?.san).toBe('e5');
  });
});

describe('the strategy library of @gambit/content (real package)', () => {
  it('is loaded with its own rules', async () => {
    const content = await loadContent();
    const library = content.strategyLibrary;
    expect(library.source).toBe('content');
    expect(library.cards.length).toBeGreaterThanOrEqual(12);
    expect(library.cards.every((card) => card.titleAccRu !== undefined)).toBe(true);
    const white = library.eligible({ childColor: 'w', stage: 1 });
    expect(white.length).toBeGreaterThanOrEqual(3);
    expect(white.every((card) => card.side === 'w' && card.minStage <= 1)).toBe(true);
    const vsD4 = library.eligible({ childColor: 'b', stage: 5, opponentFirstUci: 'd2d4' });
    expect(vsD4.length).toBeGreaterThan(0);
    expect(vsD4.every((card) => card.against === 'd4')).toBe(true);
    // deterministic: the same history gives the same card, and it is a fresh one
    const first = library.pick(white, []);
    expect(library.pick(white, [])?.id).toBe(first?.id);
    expect(library.pick(white, [first?.id ?? ''])?.id).not.toBe(first?.id);
    for (const card of library.cards) if (card.side === 'w') expect(firstChildMove(card, 'w'), card.id).not.toBeNull();
  });

  it('survives content rules that misbehave', () => {
    const cards = FALLBACK_STRATEGIES;
    const broken = createStrategyLibrary({
      cards,
      source: 'content',
      getStrategiesFor: () => {
        throw new Error('boom');
      },
      pickStrategyDeterministic: () => ({ id: 'not-a-candidate' }),
    });
    expect(ids(broken.eligible({ childColor: 'w', stage: 1 }))).toEqual(['italian', 'london']);
    expect(broken.pick(cards.slice(0, 2), [])?.id).toBe('italian');

    const foreign = createStrategyLibrary({ cards, source: 'content', getStrategiesFor: () => [{ id: 'unknown' }, { id: 'open-game' }, 'junk'] });
    // unknown ids and cards of the other colour are dropped → nothing fits → the principles card
    expect(ids(foreign.eligible({ childColor: 'w', stage: 1 }))).toEqual(['principles-white']);
    expect(foreign.byId('principles-black')?.side).toBe('b');
  });
});

describe('StrategyHistory (kv strategy-history)', () => {
  function memoryStore(initial?: unknown) {
    const store = {
      value: initial,
      loadStrategyHistoryRaw: () => store.value,
      saveStrategyHistory: (value: unknown) => {
        store.value = value;
      },
    };
    return store;
  }

  it('keeps the last five strategies of each colour, oldest first', () => {
    let now = 1_000_000;
    const history = new StrategyHistory(memoryStore(), () => now);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      history.record(id, 'w');
      now += 30_000;
    }
    expect(history.recent('w')).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(history.recent('w')).toHaveLength(STRATEGY_HISTORY_LIMIT);
    expect(history.recent('b')).toEqual([]);
  });

  it('two quick games in a row both count — nothing is replaced within a time window («каждую партию новую»)', () => {
    let now = 5_000_000;
    const history = new StrategyHistory(memoryStore(), () => now);
    history.record('italian', 'w');
    now += 10_000; // a lost game and a rematch at once
    history.record('london', 'w');
    now += 10_000;
    history.record('vienna', 'w');
    expect(history.recent('w')).toEqual(['italian', 'london', 'vienna']);
    // the same answer twice in a row (a repeated request) is one entry
    history.record('vienna', 'w');
    expect(history.recent('w')).toEqual(['italian', 'london', 'vienna']);
  });

  it('per colour: games as Black never push the White strategies out (and back)', () => {
    let now = 7_000_000;
    const store = memoryStore();
    const history = new StrategyHistory(store, () => now);
    history.record('italian', 'w');
    for (const id of ['french', 'dutch-stonewall', 'sicilian', 'orthodox', 'slav', 'kings-indian']) {
      now += 60_000;
      history.record(id, 'b');
    }
    history.record('london', 'w');
    expect(history.recent('w')).toEqual(['italian', 'london']);
    expect(history.recent('b')).toEqual(['dutch-stonewall', 'sicilian', 'orthodox', 'slav', 'kings-indian']);
    expect(history.recent()).toEqual(['italian', 'dutch-stonewall', 'sicilian', 'orthodox', 'slav', 'kings-indian', 'london']);
    // stored with the colours (and readable by the first version: `ids` stays a plain list)
    expect(store.value).toMatchObject({ ids: history.recent(), sides: ['w', 'b', 'b', 'b', 'b', 'b', 'w'] });
  });

  it('reads the first version (no colours): its ids count for both colours', () => {
    const history = new StrategyHistory(memoryStore({ ids: ['italian', 'open-game'], servedAt: 1 }), () => 2);
    expect(history.recent('w')).toEqual(['italian', 'open-game']);
    expect(history.recent('b')).toEqual(['italian', 'open-game']);
    history.record('london', 'w');
    expect(history.recent('w')).toEqual(['italian', 'open-game', 'london']);
    expect(history.recent('b')).toEqual(['italian', 'open-game']);
  });

  it('ignores damaged stored values and bad ids', () => {
    const history = new StrategyHistory(memoryStore({ ids: ['ok', 42, '<script>', 'fine'], servedAt: 'x' }), () => 0);
    expect(history.recent()).toEqual(['ok', 'fine']);
    expect(new StrategyHistory(memoryStore('garbage')).recent()).toEqual([]);
    history.record('<bad>');
    expect(history.recent()).toEqual(['ok', 'fine']);
  });
});
