import { describe, expect, it } from 'vitest';
import { buildOpeningTable, epdAfterPgn, parseOpeningsTsv, serializeOpeningTable } from './openings-build.ts';

const SAMPLE_TSV = [
  'eco\tname\tpgn',
  'C50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4',
  "D06\tQueen's Gambit\t1. d4 d5 2. c4",
  'B20\tSicilian Defense\t1. e4 c5',
  '',
].join('\n');

describe('parseOpeningsTsv', () => {
  it('skips the header and blank lines', () => {
    const rows = parseOpeningsTsv(SAMPLE_TSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ eco: 'C50', name: 'Italian Game', pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4' });
  });

  it('handles CRLF and extra columns (dist/ format with uci + epd)', () => {
    const rows = parseOpeningsTsv('eco\tname\tpgn\tuci\tepd\r\nB20\tSicilian Defense\t1. e4 c5\te2e4 c7c5\tx\r\n');
    expect(rows).toEqual([{ eco: 'B20', name: 'Sicilian Defense', pgn: '1. e4 c5' }]);
  });

  it('throws on malformed lines', () => {
    expect(() => parseOpeningsTsv('eco\tname\tpgn\nC50 Italian Game 1. e4')).toThrow(/malformed line 2/);
  });
});

describe('epdAfterPgn', () => {
  it('returns the first four FEN fields', () => {
    expect(epdAfterPgn('1. e4 c5')).toBe('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -');
  });

  it('keeps the en-passant square only when a capture is possible', () => {
    expect(epdAfterPgn('1. e4 Nf6 2. e5 d5')).toBe('rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6');
  });

  it('throws on illegal or empty movetext', () => {
    expect(() => epdAfterPgn('1. e4 e5 2. Ke3')).toThrow();
    expect(() => epdAfterPgn('')).toThrow();
  });
});

describe('buildOpeningTable', () => {
  it('maps EPD → [eco, name]', () => {
    const result = buildOpeningTable(parseOpeningsTsv(SAMPLE_TSV));
    expect(result.rows).toBe(3);
    expect(result.errors).toEqual([]);
    expect(result.table['rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq -']).toEqual(['D06', "Queen's Gambit"]);
  });

  it('keeps the first name for a repeated position and reports bad PGNs', () => {
    const result = buildOpeningTable([
      { eco: 'B20', name: 'Sicilian Defense', pgn: '1. e4 c5' },
      { eco: 'B20', name: 'Duplicate', pgn: '1. e4 c5' },
      { eco: 'A00', name: 'Broken', pgn: '1. e5' },
    ]);
    expect(result.duplicates).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.row.name).toBe('Broken');
    expect(Object.values(result.table)).toEqual([['B20', 'Sicilian Defense']]);
  });
});

describe('serializeOpeningTable', () => {
  it('is deterministic (sorted keys) and valid JSON', () => {
    const json = serializeOpeningTable({ 'b w - -': ['B00', 'Second'], 'a w - -': ['A00', 'First "quoted"'] });
    expect(json.indexOf('"a w - -"')).toBeLessThan(json.indexOf('"b w - -"'));
    expect(JSON.parse(json)).toEqual({ 'a w - -': ['A00', 'First "quoted"'], 'b w - -': ['B00', 'Second'] });
  });
});
