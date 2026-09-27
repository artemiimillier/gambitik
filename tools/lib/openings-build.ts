/**
 * Pure helpers for tools/build-openings.ts: parse the lichess-org/chess-openings TSV volumes and
 * turn them into the compact EPD → [eco, name] table bundled by @gambit/openings.
 */
import { Chess } from 'chess.js';

export interface OpeningTsvRow {
  eco: string;
  name: string;
  pgn: string;
}

export type OpeningTable = Record<string, [eco: string, name: string]>;

export interface OpeningBuildResult {
  table: OpeningTable;
  rows: number;
  /** rows whose position was already named by an earlier row (the deeper/earlier entry is kept) */
  duplicates: number;
  /** rows whose PGN could not be replayed */
  errors: { row: OpeningTsvRow; message: string }[];
}

/** Parses one TSV volume (`eco<TAB>name<TAB>pgn`, first line is the header). Extra columns are ignored. */
export function parseOpeningsTsv(text: string): OpeningTsvRow[] {
  const rows: OpeningTsvRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    const [eco, name, pgn] = line.split('\t');
    if (i === 0 && eco === 'eco') continue; // header
    if (!eco || !name || !pgn) {
      throw new Error(`openings TSV: malformed line ${i + 1}: ${JSON.stringify(line.slice(0, 120))}`);
    }
    rows.push({ eco: eco.trim(), name: name.trim(), pgn: pgn.trim() });
  }
  return rows;
}

/** First four FEN fields — must stay identical to `fenToEpd` in @gambit/openings. */
export function fenToEpd(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Replays a movetext such as `1. e4 e5 2. Nf3` and returns the EPD of the final position. */
export function epdAfterPgn(pgn: string): string {
  const chess = new Chess();
  chess.loadPgn(pgn);
  if (chess.history().length === 0) throw new Error('no moves parsed');
  return fenToEpd(chess.fen());
}

export function buildOpeningTable(rows: readonly OpeningTsvRow[]): OpeningBuildResult {
  const table: OpeningTable = {};
  const errors: OpeningBuildResult['errors'] = [];
  let duplicates = 0;
  for (const row of rows) {
    let epd: string;
    try {
      epd = epdAfterPgn(row.pgn);
    } catch (err) {
      errors.push({ row, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (Object.hasOwn(table, epd)) {
      duplicates++;
      continue;
    }
    table[epd] = [row.eco, row.name];
  }
  return { table, rows: rows.length, duplicates, errors };
}

/** Deterministic, compact serialisation: keys sorted, one entry per line (diff-friendly). */
export function serializeOpeningTable(table: OpeningTable): string {
  const keys = Object.keys(table).sort();
  const lines = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(table[k])}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}
