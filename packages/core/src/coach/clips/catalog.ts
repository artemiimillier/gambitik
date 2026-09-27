/**
 * The catalogue interface of the «Записи» voice (docs/voice-clips/SPEC.md §3.3): how a `ClipCatalogLine` (Russian,
 * in @gambit/content) turns into recordable units and manifest pools. Shared by the tools (script, manifest), the
 * catalogue tests and the fixtures.
 *
 * Placeholders in a wording (the knight is the example word):
 *  - piece forms — `{конь}` nom, `{коня}` acc, `{коня:gen}` gen, `{конём}` ins; capitalised `{Конь}` at a sentence start;
 *  - agreement with the piece — `{твой}` твой/твоя, `{твоего}` твоего/твою, `{своего}` своего/свою, `{он}` он/она,
 *    `{его}` его/её, `{ему}` ему/ей, and any pair `{p:ушёл|ушла}`;
 *  - the knight's own word — `{n:прыгнуть|пойти}`: the first for the knight, the second for any other piece (a knight
 *    jumps, the others go: the builders say it so, and a recording must say exactly the bubble);
 *  - the child's gender (`profile.address`) — `{g:сам|сама}`.
 * A line with piece placeholders is `byPiece`, a line with `{g:…}` is `byGender`; the lint (lint.ts) enforces both.
 * Wordings of a `byPiece` line without piece words are recorded once and join every piece pool.
 */
import type { ClipCatalogLine, ClipWording, PieceType } from '@gambit/shared';
import { capitalize } from '../phrase.ts';
import { pieceGenderRu, pieceNameRu } from '../spoken.ts';
import type { GrammaticalCase } from '../spoken.ts';
import { lineUnitKey, poolKeyOf } from './keys.ts';

/** The pieces of a plain `byPiece: true` line (the king is named only where a line lists it). */
export const DEFAULT_LINE_PIECES: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q'];

const PIECE_CASE: Readonly<Record<string, GrammaticalCase>> = { конь: 'nom', коня: 'acc', 'коня:gen': 'gen', конём: 'ins' };
const PIECE_AGREE: Readonly<Record<string, readonly [string, string]>> = {
  твой: ['твой', 'твоя'],
  твоего: ['твоего', 'твою'],
  своего: ['своего', 'свою'],
  он: ['он', 'она'],
  его: ['его', 'её'],
  ему: ['ему', 'ей'],
};

const PLACEHOLDER_RE = /\{([^{}]+)\}/gu;

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** Does the wording name a piece (needs a piece variant)? */
export function usesPiece(t: string): boolean {
  for (const m of t.matchAll(PLACEHOLDER_RE)) {
    const token = (m[1] as string).toLowerCase();
    if (Object.hasOwn(PIECE_CASE, token) || Object.hasOwn(PIECE_AGREE, token) || token.startsWith('p:') || token.startsWith('n:')) return true;
  }
  return false;
}

/** Does the wording depend on the child's gender? */
export function usesGender(t: string): boolean {
  for (const m of t.matchAll(PLACEHOLDER_RE)) if ((m[1] as string).toLowerCase().startsWith('g:')) return true;
  return false;
}

/**
 * The wording with its placeholders filled for `piece` / `g`; null when a placeholder needs a variant that is not
 * given or is unknown (the lint reports it).
 */
export function expandWording(t: string, variant: { piece?: PieceType; g?: 'm' | 'f' } = {}): string | null {
  let ok = true;
  const out = t.replace(PLACEHOLDER_RE, (_all, raw: string) => {
    const token = raw.toLowerCase();
    const cap = isUpper(raw.charAt(0));
    let word: string | null = null;
    if (Object.hasOwn(PIECE_CASE, token)) word = variant.piece ? pieceNameRu(variant.piece, PIECE_CASE[token] as GrammaticalCase) : null;
    else if (Object.hasOwn(PIECE_AGREE, token)) word = variant.piece ? (PIECE_AGREE[token] as readonly [string, string])[pieceGenderRu(variant.piece) === 'f' ? 1 : 0] : null;
    else if (token.startsWith('p:') || token.startsWith('g:')) {
      const pair = raw.slice(2).split('|');
      const fem = token.startsWith('p:') ? (variant.piece ? pieceGenderRu(variant.piece) === 'f' : null) : variant.g ? variant.g === 'f' : null;
      word = pair.length === 2 && fem !== null ? (pair[fem ? 1 : 0] as string) : null;
    } else if (token.startsWith('n:')) {
      const pair = raw.slice(2).split('|');
      word = pair.length === 2 && variant.piece ? (pair[variant.piece === 'n' ? 0 : 1] as string) : null;
    }
    if (word === null) {
      ok = false;
      return '';
    }
    return cap ? capitalize(word) : word;
  });
  return ok ? out : null;
}

/** The pieces a line is recorded for ([] = not by piece). */
export function linePieces(line: Pick<ClipCatalogLine, 'byPiece'>): readonly PieceType[] {
  if (!line.byPiece) return [];
  return line.byPiece === true ? DEFAULT_LINE_PIECES : line.byPiece;
}

/** One recordable unit of the catalogue: a wording of a line variant. */
export interface CatalogUnit {
  line: string;
  /** 1-based wording number */
  wording: number;
  piece?: PieceType;
  g?: 'm' | 'f';
  /** `line:<pool>#<n>` */
  unitKey: string;
  /** the pool it is recorded under */
  pool: string;
  /** every pool whose takes include it (a plain wording of a `byPiece` line joins all piece pools) */
  pools: string[];
  /** what is said; null when the wording cannot be expanded (a lint error) */
  text: string | null;
  mood?: ClipWording['mood'];
  role: ClipCatalogLine['role'];
}

/**
 * Every unit a catalogue line needs recorded (SPEC §3.3: `byPiece` ×5 at script time, gendered forms doubled). A
 * wording is recorded once per variant it actually depends on: «— это вилка!» of a `byPiece` line is one unit that
 * joins the plain pool and every piece pool; «Найдёшь ход {g:сам|сама}?» is two units (`/m`, `/f`).
 */
export function catalogUnits(line: ClipCatalogLine): CatalogUnit[] {
  const pieces = linePieces(line);
  const out: CatalogUnit[] = [];
  line.wordings.forEach((w, i) => {
    const n = i + 1;
    const byP = pieces.length > 0 && usesPiece(w.t);
    const byG = !!line.byGender && usesGender(w.t);
    // the pools a unit joins: its own variant, plus every variant it does not depend on
    const pieceJoins = (piece: PieceType | undefined): (PieceType | undefined)[] => (byP ? [piece] : [undefined, ...pieces]);
    const genderJoins = (g: 'm' | 'f' | undefined): ('m' | 'f' | undefined)[] => (byG ? [g] : line.byGender ? [undefined, 'm', 'f'] : [undefined]);
    for (const piece of byP ? pieces : [undefined]) {
      for (const g of byG ? (['m', 'f'] as const) : [undefined]) {
        const pool = poolKeyOf(line.id, piece, g);
        const pools = pieceJoins(piece).flatMap((p) => genderJoins(g).map((gg) => poolKeyOf(line.id, p, gg)));
        out.push({
          line: line.id,
          wording: n,
          role: line.role,
          ...(piece ? { piece } : {}),
          ...(g ? { g } : {}),
          ...(w.mood ? { mood: w.mood } : {}),
          unitKey: lineUnitKey(pool, n),
          pool,
          pools,
          text: expandWording(w.t, { ...(piece ? { piece } : {}), ...(g ? { g } : {}) }),
        });
      }
    }
  });
  return out;
}

/** The catalogue's L3 siblings, as the manifest carries them (`fallbacks`). */
export function catalogFallbacks(lines: readonly ClipCatalogLine[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) if (l.fallback) out[l.id] = l.fallback;
  return out;
}
