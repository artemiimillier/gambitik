import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { OTHER_FIRST_MOVES_UCI, STRATEGIES, STRATEGY_NO_REPEAT, STRATEGY_THEMES, answersFirstMove, getStrategiesFor, getStrategy, pickStrategyDeterministic, strategyGroupOf } from './strategies.ts';
import type { StrategyEntry } from './strategies.ts';
import { LATIN_RE, PLACEHOLDER_RE, playLine } from './testUtils.ts';

const CLOCK_RE = /минут|секунд|часы|время/i;
const words = (s: string): number => s.split(/\s+/).filter((w) => /[А-Яа-яЁё0-9]/.test(w)).length;

/** A deterministic rng for the variety checks. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('STRATEGIES — the library', () => {
  it('has at least 9 White and 15 Black strategies, the Black ones split by the first move', () => {
    const white = STRATEGIES.filter((s) => s.side === 'w');
    const black = STRATEGIES.filter((s) => s.side === 'b');
    expect(white.length).toBeGreaterThanOrEqual(9);
    expect(black.length).toBeGreaterThanOrEqual(15);
    expect(white.every((s) => s.against === 'any')).toBe(true);
    expect(black.filter((s) => s.against === 'e4').length).toBeGreaterThanOrEqual(6);
    expect(black.filter((s) => s.against === 'd4').length).toBeGreaterThanOrEqual(4);
    expect(black.filter((s) => s.against === 'other').length).toBeGreaterThanOrEqual(5);
    // the French and the Dutch are in the library
    expect(getStrategy('french')?.against).toBe('e4');
    expect(getStrategy('dutch-stonewall')?.against).toBe('d4');
    expect(new Set(STRATEGIES.map((s) => s.id)).size).toBe(STRATEGIES.length);
    // White starts with different first moves, so games really differ
    expect(new Set(white.map((s) => s.lineSan[0])).size).toBeGreaterThanOrEqual(2);
  });

  it.each(STRATEGIES.map((s) => [s.id, s] as const))('%s: kid texts are Russian, short, without Latin letters or clock words', (_id, s) => {
    const texts = [s.titleRu, s.titleAccRu, s.ideaRu, ...s.stepsRu, ...s.middlegameRu, ...s.planGoalsRu];
    for (const t of texts) {
      expect(t, t).not.toMatch(LATIN_RE);
      expect(t, t).not.toMatch(PLACEHOLDER_RE);
      expect(t, t).not.toMatch(CLOCK_RE);
      expect(t.trim(), t).toBe(t);
    }
    expect(words(s.ideaRu), s.ideaRu).toBeLessThanOrEqual(9);
    expect(s.ideaRu).toMatch(/^[а-яё]/); // a clause after «— »
    expect(s.stepsRu.length).toBeGreaterThanOrEqual(3);
    expect(s.stepsRu.length).toBeLessThanOrEqual(6);
    expect(s.middlegameRu.length).toBeGreaterThanOrEqual(2);
    for (const step of [...s.stepsRu, ...s.middlegameRu]) expect(words(step), step).toBeLessThanOrEqual(12);
    // «В этот раз разыграем … — …. Начни конём на эф три.» stays within 20 words
    expect(4 + words(s.titleAccRu) + words(s.ideaRu) + 5).toBeLessThanOrEqual(20);
    expect(s.minStage).toBeGreaterThanOrEqual(1);
    for (const t of s.themes) expect(STRATEGY_THEMES).toContain(t);
    // the goals after a deviation: «мы» verb phrases the teacher puts inside a sentence («по нашему плану — …»)
    expect(s.planGoalsRu.length).toBeGreaterThanOrEqual(2);
    expect(s.planGoalsRu.length).toBeLessThanOrEqual(4);
    for (const goal of s.planGoalsRu) {
      expect(words(goal), goal).toBeLessThanOrEqual(12);
      expect(goal, goal).toMatch(/^([а-яё]+\s)?[а-яё]+(ем|им|ём)(ся)?\s/u);
      expect(goal, goal).not.toMatch(/(?<![а-яё])(бел|чёрн|черн)[а-яё]*/iu);
    }
    expect(new Set(s.planGoalsRu).size).toBe(s.planGoalsRu.length);
  });

  it('only the Black systems (against «other») list the first moves they answer — known moves, none of 1.e4 / 1.d4', () => {
    for (const s of STRATEGIES) {
      if (s.answersUci === undefined) continue;
      expect(s.side, s.id).toBe('b');
      expect(s.against, s.id).toBe('other');
      expect(s.answersUci.length, s.id).toBeGreaterThan(0);
      for (const uci of s.answersUci) expect(OTHER_FIRST_MOVES_UCI, `${s.id} ${uci}`).toContain(uci);
      expect(new Set(s.answersUci).size, s.id).toBe(s.answersUci.length);
    }
    // every White first move of chess.js other than 1.e4 / 1.d4 is a known one
    const firsts = new Chess().moves({ verbose: true }).map((m) => m.lan).filter((uci) => uci !== 'e2e4' && uci !== 'd2d4');
    expect([...OTHER_FIRST_MOVES_UCI].sort()).toEqual(firsts.sort());
  });

  it.each(STRATEGIES.map((s) => [s.id, s] as const))('%s: the main line is legal and canonical; lineSan = the child\'s moves of it (6–10)', (_id, s) => {
    const chess = new Chess();
    const moves = playLine(chess, s.mainLineSan);
    const child = moves.filter((m) => m.color === s.side).map((m) => m.san);
    expect(child).toEqual(s.lineSan);
    expect(s.lineSan.length).toBeGreaterThanOrEqual(6);
    expect(s.lineSan.length).toBeLessThanOrEqual(10);
    // the main line ends with a child move or the opponent's reply to it
    expect(s.mainLineSan.length).toBeGreaterThanOrEqual(s.side === 'w' ? 2 * s.lineSan.length - 1 : 2 * s.lineSan.length);
    if (s.side === 'b') {
      const first = moves[0];
      expect(first && strategyGroupOf(`${first.from}${first.to}`)).toBe(s.against);
    }
    for (const san of s.middlegameSan) expect(san, san).toMatch(/^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?$/);
  });

  it('getStrategy finds a card by id', () => {
    expect(getStrategy('italian')?.titleRu).toBe('Итальянская партия');
    expect(getStrategy('nope')).toBeUndefined();
  });
});

describe('getStrategiesFor', () => {
  it('White: by stage, easiest first; stage 1 already has a choice of first moves', () => {
    const s1 = getStrategiesFor('w', 1);
    expect(s1.length).toBeGreaterThanOrEqual(3);
    expect(s1.every((s) => s.side === 'w' && s.minStage <= 1)).toBe(true);
    expect(new Set(s1.map((s) => s.lineSan[0])).size).toBeGreaterThanOrEqual(2);
    const s5 = getStrategiesFor('w', 5);
    expect(s5.length).toBe(STRATEGIES.filter((s) => s.side === 'w').length);
    expect(s5.map((s) => s.id)).toContain('queens-gambit');
    expect(s1.map((s) => s.id)).not.toContain('queens-gambit');
  });

  it('Black: by the opponent\'s first move; without it — every Black strategy of the stage', () => {
    expect(getStrategiesFor('b', 5, 'e2e4').map((s) => s.against)).toEqual(expect.arrayContaining(['e4']));
    expect(getStrategiesFor('b', 5, 'e2e4').every((s) => s.against === 'e4')).toBe(true);
    expect(getStrategiesFor('b', 5, 'd2d4').every((s) => s.against === 'd4')).toBe(true);
    expect(getStrategiesFor('b', 5, 'g1f3').every((s) => s.against === 'other')).toBe(true);
    // 1.c4 d5? loses too much: the classic development does not answer 1.c4
    expect(getStrategiesFor('b', 5, 'c2c4').map((s) => s.id)).toEqual(['kings-indian-setup', 'queens-indian-setup', 'botvinnik-system', 'reversed-sicilian']);
    // 1.Nf3 e5? loses the pawn: the reversed Sicilian does not answer 1.Nf3
    expect(getStrategiesFor('b', 5, 'g1f3').map((s) => s.id)).not.toContain('reversed-sicilian');
    expect(getStrategiesFor('b', 1, 'e2e4').map((s) => s.id)).toEqual(['open-game', 'two-knights', 'french', 'scandinavian']);
    expect(getStrategiesFor('b', 1, 'd2d4').map((s) => s.id)).toEqual(['orthodox', 'slav', 'dutch-stonewall']);
    expect(getStrategiesFor('b', 2, 'd2d4').map((s) => s.id)).toContain('kings-indian');
    const all = getStrategiesFor('b', 9);
    expect(all.length).toBe(STRATEGIES.filter((s) => s.side === 'b').length);
  });

  it('Black against any other first move: at least three different plans at stage 1, not only «Классическое развитие»', () => {
    for (const first of OTHER_FIRST_MOVES_UCI) {
      const cards = getStrategiesFor('b', 1, first);
      expect(cards.length, first).toBeGreaterThan(0);
      expect(cards.every((s) => s.against === 'other' && answersFirstMove(s, first)), first).toBe(true);
      // the reply is legal after that first move
      for (const s of cards) {
        const chess = new Chess();
        chess.move({ from: first.slice(0, 2), to: first.slice(2, 4) });
        expect(() => chess.move(s.lineSan[0] ?? ''), `${first} ${s.id}`).not.toThrow();
      }
    }
    // the first moves the bots really play: three plans already at stage 1, with different first replies
    for (const first of ['g1f3', 'c2c4', 'b2b3', 'f2f4', 'd2d3', 'g2g3', 'e2e3', 'b1c3']) {
      const plans = getStrategiesFor('b', 1, first);
      expect(plans.length, first).toBeGreaterThanOrEqual(3);
      expect(getStrategiesFor('b', 2, first).length, first).toBeGreaterThanOrEqual(3);
      expect(new Set(plans.map((s) => s.lineSan[0])).size, first).toBeGreaterThanOrEqual(2);
    }
    // 1.g4: the classic development and the reversed Sicilian answer it
    expect(getStrategiesFor('b', 5, 'g2g4').map((s) => s.id)).toEqual(['classic-development', 'reversed-sicilian']);
  });

  it('a stage below every card still gets the easiest cards (never empty)', () => {
    expect(getStrategiesFor('w', 0).length).toBeGreaterThan(0);
    expect(getStrategiesFor('b', 0, 'e2e4').length).toBeGreaterThan(0);
    expect(getStrategiesFor('b', 1, 'e2e4').some((s) => s.id === 'caro-kann')).toBe(false);
  });

  it('strategyGroupOf', () => {
    expect(strategyGroupOf('e2e4')).toBe('e4');
    expect(strategyGroupOf(' D2D4 ')).toBe('d4');
    expect(strategyGroupOf('e2e3')).toBe('other');
  });
});

describe('pickStrategyDeterministic — variety', () => {
  const white = getStrategiesFor('w', 5);

  it('never repeats one of the last three when an alternative exists (any rng, any history)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = seeded(seed);
      const history: string[] = [];
      for (let game = 0; game < 12; game++) {
        const cands = game % 3 === 0 ? white.slice(0, 4) : white;
        const pick = pickStrategyDeterministic(cands, history, rng) as StrategyEntry;
        expect(pick).not.toBeNull();
        const recent = history.slice(-STRATEGY_NO_REPEAT);
        if (cands.some((c) => !recent.includes(c.id))) expect(recent, `seed ${seed} game ${game}`).not.toContain(pick.id);
        history.push(pick.id);
      }
    }
  });

  it('prefers a never-played strategy; otherwise the least recent one when all were played lately', () => {
    const three = white.slice(0, 3);
    const [a, b, c] = three.map((s) => s.id) as [string, string, string];
    expect(pickStrategyDeterministic(three, [a, b], () => 0.99)?.id).toBe(c);
    // all three in the last three games → the one played longest ago
    expect(pickStrategyDeterministic(three, [b, c, a], () => 0)?.id).toBe(b);
    expect(pickStrategyDeterministic(three, [a, c, b, a, c], () => 0)?.id).toBe(b);
  });

  it('is a pure function of the rng; spreads over the library; null for no candidates', () => {
    const r1 = pickStrategyDeterministic(white, [], () => 0.5);
    const r2 = pickStrategyDeterministic(white, [], () => 0.5);
    expect(r1?.id).toBe(r2?.id);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) seen.add(pickStrategyDeterministic(white, [], seeded(seed))?.id ?? '');
    expect(seen.size).toBeGreaterThanOrEqual(4);
    expect(pickStrategyDeterministic([], ['italian'])).toBeNull();
    // a strange rng never breaks it
    expect(pickStrategyDeterministic(white, [], () => Number.NaN)).not.toBeNull();
    expect(pickStrategyDeterministic(white, [], () => 1)).not.toBeNull();
  });

  it('twelve games in a row with a stage-1 child as White use at least three different strategies', () => {
    const cands = getStrategiesFor('w', 1);
    const history: string[] = [];
    const rng = seeded(7);
    for (let i = 0; i < 12; i++) history.push(pickStrategyDeterministic(cands, history, rng)?.id ?? '');
    expect(new Set(history).size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < history.length; i++) expect(history[i]).not.toBe(history[i - 1]);
  });
});
