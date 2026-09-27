/**
 * @gambit/openings — named-opening lookup by position (EPD), see docs/ARCHITECTURE.md §3.
 *
 * Data: `generated/openings.json`, built by `pnpm openings:build` (tools/build-openings.ts) from
 * lichess-org/chess-openings (CC0). Shape: `{ "<epd>": ["<eco>", "<english name>"] }` where the EPD
 * is the first four FEN fields exactly as produced by chess.js 1.4.0 (the en-passant square is
 * present only when an en-passant capture is actually possible).
 *
 * Isomorphic: no DOM, no `node:` imports, no chess.js at runtime — plain string lookups.
 */
import openingsJson from './generated/openings.json' with { type: 'json' };
import { openingNameRu, RU_FAMILY_NAMES } from './ru-names.ts';

export { openingNameRu, RU_FAMILY_NAMES };

export interface OpeningInfo {
  /** ECO code, e.g. 'C50' */
  eco: string;
  /** English name as in lichess-org/chess-openings, e.g. 'Italian Game: Giuoco Piano' */
  name: string;
  /** Russian name (family or a well-known variation); absent for rare openings */
  nameRu?: string;
}

type OpeningTable = Readonly<Record<string, readonly string[] | undefined>>;

const TABLE: OpeningTable = openingsJson;

/** Number of named positions in the bundled book. */
export const OPENING_COUNT: number = Object.keys(TABLE).length;

/** First four FEN fields (board, side to move, castling, en passant). Accepts a FEN or an EPD. */
export function fenToEpd(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

function toInfo(entry: readonly string[] | undefined): OpeningInfo | undefined {
  if (!entry) return undefined;
  const [eco, name] = entry;
  if (eco === undefined || name === undefined) return undefined;
  const nameRu = openingNameRu(name);
  return nameRu === undefined ? { eco, name } : { eco, name, nameRu };
}

/**
 * Named opening for exactly this position, or `undefined` when the position is not in the book.
 *
 * FENs from other sources often carry an en-passant square after every double pawn push, while
 * the book (chess.js) only records it when a capture is possible — so a miss is retried with the
 * en-passant field cleared.
 */
export function lookupOpening(fen: string): OpeningInfo | undefined {
  const epd = fenToEpd(fen);
  // `Object.hasOwn` guards against prototype keys for garbage input such as 'constructor'.
  if (Object.hasOwn(TABLE, epd)) return toInfo(TABLE[epd]);
  const fields = epd.split(' ');
  if (fields.length === 4 && fields[3] !== '-') {
    const withoutEp = `${fields[0]} ${fields[1]} ${fields[2]} -`;
    if (Object.hasOwn(TABLE, withoutEp)) return toInfo(TABLE[withoutEp]);
  }
  return undefined;
}

/**
 * Opening of a game given the FEN after every ply (in order). The LAST named position wins, which
 * also catches transpositions. Only the first `maxPlies` entries are examined — names
 * practically never appear deeper than move 20.
 */
export function openingFromHistory(fens: readonly string[], maxPlies = 64): OpeningInfo | undefined {
  const end = Math.min(fens.length, Math.max(0, maxPlies));
  for (let i = end - 1; i >= 0; i--) {
    const fen = fens[i];
    if (fen === undefined) continue;
    const hit = lookupOpening(fen);
    if (hit) return hit;
  }
  return undefined;
}
