/**
 * PGN export (main line only, optional `[%clk]` and text comments).
 */
import type { GameResult } from '@gambit/shared';

const SEVEN_TAG_ROSTER = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'] as const;
const ROSTER_DEFAULTS: Record<(typeof SEVEN_TAG_ROSTER)[number], string> = {
  Event: '?',
  Site: '?',
  Date: '????.??.??',
  Round: '?',
  White: '?',
  Black: '?',
  Result: '*',
};
const MAX_LINE = 80;

export interface PgnMove {
  san: string;
  /** remaining clock of the player who made the move, written as `[%clk h:mm:ss]` */
  clkMs?: number;
  /** free text, written inside the same `{ }` comment after the clock */
  comment?: string;
}

/**
 * chess.js' PGN grammar has no escape sequences inside tag values (`[^"]*`), so instead of the
 * standard `\"` escaping, double quotes become single quotes and backslashes become slashes.
 */
function cleanTagValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\\/g, '/').replace(/"/g, "'").trim();
}

function sanitizeComment(comment: string): string {
  return comment.replace(/[{}]/g, (ch) => (ch === '{' ? '(' : ')')).replace(/\s+/g, ' ').trim();
}

/** `[%clk h:mm:ss]` — whole seconds, rounded down like a clock face; negatives become 0. */
export function formatClk(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function startFromFen(fen: string | undefined): { moveNumber: number; blackToMove: boolean } {
  if (!fen) return { moveNumber: 1, blackToMove: false };
  const fields = fen.trim().split(/\s+/);
  const n = Number.parseInt(fields[5] ?? '1', 10);
  return { moveNumber: Number.isFinite(n) && n > 0 ? n : 1, blackToMove: fields[1] === 'b' };
}

/**
 * Builds a PGN that chess.js `loadPgn` (and lichess) can re-read.
 *
 *  - Seven Tag Roster first (missing tags get the standard `?` placeholders), then the remaining
 *    headers in insertion order. The `Result` tag always equals `result`. Tag names must be plain
 *    letters (others are skipped) and `"` in values becomes `'` — limits of chess.js' parser.
 *  - A `FEN` header makes the numbering start from that position (`SetUp "1"` is added).
 *  - `clkMs` → `{[%clk 0:04:59]}`; `comment` is appended in the same braces (braces inside the
 *    text are replaced by parentheses). After a comment Black's move is written as `12... Nf6`.
 *  - Movetext is wrapped at 80 columns and ends with the result token.
 */
export function buildPgn(args: { headers: Record<string, string>; moves: PgnMove[]; result: GameResult }): string {
  const headers: Record<string, string> = { ...args.headers, Result: args.result };
  if (headers.FEN && !headers.SetUp) headers.SetUp = '1';

  const lines: string[] = [];
  for (const tag of SEVEN_TAG_ROSTER) lines.push(`[${tag} "${cleanTagValue(headers[tag] ?? ROSTER_DEFAULTS[tag])}"]`);
  for (const [tag, value] of Object.entries(headers)) {
    if ((SEVEN_TAG_ROSTER as readonly string[]).includes(tag)) continue;
    if (!/^[A-Za-z]+$/.test(tag) || value === undefined || value === null) continue;
    lines.push(`[${tag} "${cleanTagValue(String(value))}"]`);
  }

  const tokens: string[] = [];
  let { moveNumber, blackToMove } = startFromFen(headers.FEN);
  let needNumber = true;
  for (const move of args.moves) {
    if (!blackToMove) tokens.push(`${moveNumber}.`);
    else if (needNumber) tokens.push(`${moveNumber}...`);
    tokens.push(move.san);

    const parts: string[] = [];
    if (typeof move.clkMs === 'number') parts.push(`[%clk ${formatClk(move.clkMs)}]`);
    const text = move.comment ? sanitizeComment(move.comment) : '';
    if (text) parts.push(text);
    if (parts.length > 0) tokens.push(`{${parts.join(' ')}}`);

    needNumber = parts.length > 0;
    if (blackToMove) moveNumber += 1;
    blackToMove = !blackToMove;
  }
  tokens.push(args.result);

  // Wrap at spaces, but never inside a `[%clk …]` command (some PGN readers dislike that).
  const words = tokens.flatMap((t) => t.match(/\{?\[%[^\]]*\]\}?|\S+/g) ?? []);
  const wrapped: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + 1 + word.length > MAX_LINE) {
      wrapped.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) wrapped.push(current);

  return `${lines.join('\n')}\n\n${wrapped.join('\n')}\n`;
}
