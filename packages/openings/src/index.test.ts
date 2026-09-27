import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import openingsJson from './generated/openings.json' with { type: 'json' };
import { fenToEpd, lookupOpening, OPENING_COUNT, openingFromHistory, openingNameRu, RU_FAMILY_NAMES } from './index.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** FEN after every ply of the given SAN moves (the starting position is not included). */
function fensAfter(sans: string[]): string[] {
  const chess = new Chess();
  return sans.map((san) => {
    chess.move(san);
    return chess.fen();
  });
}

function fenAfter(sans: string[]): string {
  return fensAfter(sans).at(-1) ?? START_FEN;
}

describe('generated openings.json', () => {
  it('has more than 3000 named positions', () => {
    expect(Object.keys(openingsJson).length).toBeGreaterThan(3000);
    expect(OPENING_COUNT).toBe(Object.keys(openingsJson).length);
  });

  it('stores [eco, name] pairs keyed by a 4-field EPD', () => {
    for (const [epd, entry] of Object.entries(openingsJson)) {
      expect(epd.split(' ')).toHaveLength(4);
      expect(entry).toHaveLength(2);
      expect(entry[0]).toMatch(/^[A-E]\d\d$/);
      expect(entry[1].length).toBeGreaterThan(2);
    }
  });
});

describe('lookupOpening', () => {
  it('names the Italian Game after 1.e4 e5 2.Nf3 Nc6 3.Bc4', () => {
    const hit = lookupOpening(fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']));
    expect(hit).toEqual({ eco: 'C50', name: 'Italian Game', nameRu: 'Итальянская партия' });
  });

  it("names the Queen's Gambit after 1.d4 d5 2.c4", () => {
    const hit = lookupOpening(fenAfter(['d4', 'd5', 'c4']));
    expect(hit?.name).toBe("Queen's Gambit");
    expect(hit?.eco).toBe('D06');
    expect(hit?.nameRu).toBe('Ферзевый гамбит');
  });

  it('knows the main kid repertoire families in Russian', () => {
    const cases: [string[], string, string][] = [
      [['e4', 'c5'], 'Sicilian Defense', 'Сицилианская защита'],
      [['e4', 'e6'], 'French Defense', 'Французская защита'],
      [['e4', 'c6'], 'Caro-Kann Defense', 'Защита Каро — Канн'],
      [['e4', 'd5'], 'Scandinavian Defense', 'Скандинавская защита'],
      [['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], 'Ruy Lopez', 'Испанская партия'],
      [['e4', 'e5', 'Nf3', 'Nc6', 'd4'], 'Scotch Game', 'Шотландская партия'],
      [['e4', 'e5', 'Nf3', 'Nf6'], "Petrov's Defense", 'Русская партия'],
      [['d4', 'Nf6', 'c4', 'g6', 'Nc3'], "King's Indian Defense", 'Староиндийская защита'],
    ];
    for (const [moves, name, nameRu] of cases) {
      const hit = lookupOpening(fenAfter(moves));
      expect(hit?.name, moves.join(' ')).toBe(name);
      expect(hit?.nameRu, moves.join(' ')).toBe(nameRu);
    }
  });

  it('uses the longest dictionary prefix for famous variations', () => {
    const evans = lookupOpening(fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4']));
    expect(evans?.name).toBe('Italian Game: Evans Gambit');
    expect(evans?.nameRu).toBe('Гамбит Эванса');
  });

  it('returns undefined for unknown positions and garbage', () => {
    expect(lookupOpening(START_FEN)).toBeUndefined();
    expect(lookupOpening('8/8/8/4k3/8/4K3/4P3/8 w - - 0 1')).toBeUndefined();
    expect(lookupOpening('')).toBeUndefined();
    expect(lookupOpening('constructor')).toBeUndefined();
    expect(lookupOpening('__proto__')).toBeUndefined();
  });

  it('accepts a bare EPD and ignores move counters', () => {
    const fen = fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(lookupOpening(fenToEpd(fen))?.name).toBe('Italian Game');
    expect(lookupOpening(`${fenToEpd(fen)} 17 42`)?.name).toBe('Italian Game');
  });

  it('tolerates FENs that always carry an en-passant square', () => {
    // chess.js writes '-' after 1.e4 c5 (no capture possible); other tools write 'c6'.
    const foreign = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2';
    expect(lookupOpening(foreign)?.name).toBe('Sicilian Defense');
  });
});

describe('openingFromHistory', () => {
  it('returns the last (deepest) named position', () => {
    const fens = fensAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4']);
    const hit = openingFromHistory(fens);
    expect(hit?.eco).toBe('C54');
    expect(hit?.name).toBe('Italian Game: Classical Variation, Center Attack');
    expect(hit?.nameRu).toBe('Итальянская партия');
  });

  it('keeps the last known name once the game leaves the book', () => {
    const fens = fensAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6', 'a3', 'a6', 'h3', 'Rb8']);
    expect(openingFromHistory(fens)?.name).toMatch(/^Italian Game/);
  });

  it('catches transpositions', () => {
    const fens = fensAfter(['Nf3', 'd5', 'd4', 'Nf6', 'c4', 'e6', 'Nc3']);
    const hit = openingFromHistory(fens);
    expect(hit?.eco).toBe('D37');
    expect(hit?.nameRu).toBe('Отказанный ферзевый гамбит');
  });

  it('handles empty and unnamed histories, and a leading start position', () => {
    expect(openingFromHistory([])).toBeUndefined();
    expect(openingFromHistory([START_FEN])).toBeUndefined();
    expect(openingFromHistory([START_FEN, ...fensAfter(['d4', 'd5', 'c4'])])?.name).toBe("Queen's Gambit");
  });

  it('respects maxPlies', () => {
    const fens = fensAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(openingFromHistory(fens, 2)?.name).toBe("King's Pawn Game");
    expect(openingFromHistory(fens, 0)).toBeUndefined();
  });
});

describe('RU_FAMILY_NAMES', () => {
  const names = Object.values(openingsJson).map((entry) => entry[1]);

  it('has at least 50 entries, all Cyrillic', () => {
    const entries = Object.entries(RU_FAMILY_NAMES);
    expect(entries.length).toBeGreaterThanOrEqual(50);
    for (const [, ru] of entries) expect(ru).toMatch(/^[А-ЯЁа-яё«»—,\s-]+$/);
  });

  it('every key matches at least one real lichess opening name (no dead entries)', () => {
    const dead = Object.keys(RU_FAMILY_NAMES).filter(
      (key) => !names.some((n) => n === key || n.startsWith(`${key}:`) || n.startsWith(`${key},`)),
    );
    expect(dead).toEqual([]);
  });

  it('covers the vast majority of named positions', () => {
    const covered = names.filter((n) => openingNameRu(n) !== undefined).length;
    expect(covered / names.length).toBeGreaterThan(0.9);
  });

  it('only matches at segment boundaries', () => {
    expect(openingNameRu("Queen's Gambit Declined: Three Knights Variation")).toBe('Отказанный ферзевый гамбит');
    expect(openingNameRu("Queen's Gambit")).toBe('Ферзевый гамбит');
    expect(openingNameRu("King's Indian Attack: Sicilian Variation")).toBe('Староиндийское начало');
    expect(openingNameRu('Italian Gamer')).toBeUndefined();
    expect(openingNameRu('Pterodactyl Defense')).toBeUndefined();
  });
});
