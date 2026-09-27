import { describe, expect, it } from 'vitest';
import { LineCollector, isCriticalErrorLine, parseBestmoveLine, parseInfoLine } from './parseUci.ts';
import type { ParsedInfo } from './parseUci.ts';

describe('parseInfoLine', () => {
  it('parses a real Stockfish 19 cp line', () => {
    const info = parseInfoLine(
      'info depth 3 seldepth 4 multipv 1 score cp 15 nodes 1180 nps 107272 hashfull 0 time 11 pv e2e4 e7e5 g1f3',
    );
    expect(info).toEqual({
      multipv: 1,
      depth: 3,
      cp: 15,
      mate: null,
      pvUci: ['e2e4', 'e7e5', 'g1f3'],
      seldepth: 4,
      bound: null,
      nodes: 1180,
      nps: 107272,
      timeMs: 11,
    });
  });

  it('parses negative centipawn scores and higher multipv indices', () => {
    const info = parseInfoLine('info depth 10 seldepth 14 multipv 3 score cp -243 nodes 5 nps 5 time 1 pv g8f6 e4e5');
    expect(info?.multipv).toBe(3);
    expect(info?.cp).toBe(-243);
    expect(info?.mate).toBeNull();
    expect(info?.pvUci).toEqual(['g8f6', 'e4e5']);
  });

  it('parses mate scores with both signs', () => {
    const winning = parseInfoLine('info depth 5 seldepth 2 multipv 1 score mate 1 nodes 40 nps 4000 time 1 pv h5f7');
    expect(winning?.mate).toBe(1);
    expect(winning?.cp).toBeNull();
    const losing = parseInfoLine('info depth 12 seldepth 6 multipv 2 score mate -3 nodes 40 nps 4000 time 1 pv g8h8 d1h5 h7h6 h5h6');
    expect(losing?.mate).toBe(-3);
    expect(losing?.multipv).toBe(2);
  });

  it('skips the wdl triple and keeps promotions in the pv', () => {
    const info = parseInfoLine('info depth 8 multipv 1 score cp 910 wdl 998 2 0 nodes 9 nps 9 time 1 pv e7e8q d8e8');
    expect(info?.cp).toBe(910);
    expect(info?.pvUci).toEqual(['e7e8q', 'd8e8']);
  });

  it('defaults multipv to 1 when the token is missing', () => {
    expect(parseInfoLine('info depth 2 score cp 33 pv d2d4')?.multipv).toBe(1);
  });

  it('flags aspiration-window bounds', () => {
    expect(parseInfoLine('info depth 20 seldepth 30 multipv 1 score cp 55 lowerbound nodes 1 nps 1 time 3100 pv e2e4')?.bound).toBe('lower');
    expect(parseInfoLine('info depth 20 seldepth 30 multipv 1 score cp 12 upperbound nodes 1 nps 1 time 3100 pv e2e4')?.bound).toBe('upper');
  });

  it('ignores lines without a score + pv', () => {
    expect(parseInfoLine('info string NNUE evaluation using nn-61e7af4bb97d.nnue (1MiB, (768, 1024, 32, 32, 1))')).toBeNull();
    expect(parseInfoLine('info string depth 5 score cp 10 pv e2e4')).toBeNull();
    expect(parseInfoLine('info depth 0 score mate 0')).toBeNull();
    expect(parseInfoLine('info depth 0 score cp 0')).toBeNull();
    expect(parseInfoLine('info depth 12 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseInfoLine('bestmove e2e4 ponder e7e5')).toBeNull();
    expect(parseInfoLine('')).toBeNull();
  });
});

describe('parseBestmoveLine', () => {
  it('parses bestmove with and without ponder', () => {
    expect(parseBestmoveLine('bestmove e2e4 ponder e7e5')).toEqual({ bestmove: 'e2e4', ponder: 'e7e5' });
    expect(parseBestmoveLine('bestmove a7a8q')).toEqual({ bestmove: 'a7a8q', ponder: null });
  });

  it('maps "(none)" to null', () => {
    expect(parseBestmoveLine('bestmove (none)')).toEqual({ bestmove: null, ponder: null });
  });

  it('returns null for other lines', () => {
    expect(parseBestmoveLine('info depth 1 score cp 0 pv e2e4')).toBeNull();
    expect(parseBestmoveLine('readyok')).toBeNull();
  });
});

describe('isCriticalErrorLine', () => {
  it('detects the Stockfish 19 strict-validation message', () => {
    expect(isCriticalErrorLine('info string CRITICAL ERROR: Command `` failed. Reason: Illegal move: e2e5')).toBe(true);
    expect(isCriticalErrorLine('info string NNUE evaluation using nn-61e7af4bb97d.nnue')).toBe(false);
  });
});

describe('LineCollector', () => {
  const info = (multipv: number, depth: number, cp: number, pv: string, bound: ParsedInfo['bound'] = null): ParsedInfo => ({
    multipv,
    depth,
    cp,
    mate: null,
    pvUci: pv.split(' '),
    seldepth: null,
    bound,
    nodes: null,
    nps: null,
    timeMs: null,
  });

  it('keeps the deepest line per multipv, sorted by multipv', () => {
    const collector = new LineCollector();
    collector.add(info(2, 5, 10, 'd2d4 d7d5'));
    collector.add(info(1, 5, 30, 'e2e4 e7e5'));
    collector.add(info(1, 6, 28, 'e2e4 c7c5'));
    collector.add(info(2, 6, 12, 'g1f3 d7d5'));
    // A stale shallower line arriving late must not overwrite the deeper one.
    expect(collector.add(info(1, 4, 99, 'a2a3'))).toBe(false);
    expect(collector.snapshot()).toEqual([
      { multipv: 1, depth: 6, cp: 28, mate: null, pvUci: ['e2e4', 'c7c5'] },
      { multipv: 2, depth: 6, cp: 12, mate: null, pvUci: ['g1f3', 'd7d5'] },
    ]);
  });

  it('ignores inexact bound scores', () => {
    const collector = new LineCollector();
    collector.add(info(1, 9, 20, 'e2e4'));
    expect(collector.add(info(1, 10, 300, 'e2e4', 'lower'))).toBe(false);
    expect(collector.snapshot()[0]?.cp).toBe(20);
  });

  it('removes a root move duplicated by an interrupted iteration and renumbers ranks', () => {
    const collector = new LineCollector();
    collector.add(info(1, 12, 40, 'e2e4 e7e5'));
    collector.add(info(2, 12, 35, 'd2d4 d7d5'));
    collector.add(info(3, 12, 20, 'c2c4 e7e5'));
    // Depth 13 was interrupted after the first PV: d2d4 took over rank 1, the old rank-2 entry is stale.
    collector.add(info(1, 13, 42, 'd2d4 g8f6'));
    expect(collector.snapshot().map((line) => [line.multipv, line.pvUci[0], line.depth])).toEqual([
      [1, 'd2d4', 13],
      [2, 'c2c4', 12],
    ]);
  });
});
