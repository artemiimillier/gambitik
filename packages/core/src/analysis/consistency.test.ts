import { Chess } from 'chess.js';
import type { Square as ChessSquare } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { attackersOf, parsePlacement, squareName } from './board.ts';
import { computePositionFacts } from './facts.ts';
import { findHanging } from './hanging.ts';
import { describeMotif } from './motifs.ts';
import { materialSwing } from './pv.ts';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random playouts that prefer captures a little, to reach sharp and sparse positions. */
function randomPositions(seed: number, games: number, maxPlies: number): { fen: string; continuation: string[] }[] {
  const random = rng(seed);
  const out: { fen: string; continuation: string[] }[] = [];
  for (let g = 0; g < games; g++) {
    const chess = new Chess();
    const fens: string[] = [];
    const ucis: string[] = [];
    for (let ply = 0; ply < maxPlies && !chess.isGameOver(); ply++) {
      const moves = chess.moves({ verbose: true });
      const captures = moves.filter((m) => m.isCapture());
      const pool = captures.length > 0 && random() < 0.4 ? captures : moves;
      const move = pool[Math.floor(random() * pool.length)];
      if (!move) break;
      fens.push(chess.fen());
      ucis.push(`${move.from}${move.to}${move.promotion ?? ''}`);
      chess.move(move);
    }
    fens.forEach((fen, i) => out.push({ fen, continuation: ucis.slice(i, i + 6) }));
  }
  return out;
}

const SAMPLE = randomPositions(20260921, 12, 120);

describe('consistency with chess.js on random positions', () => {
  it('has a meaningful sample', () => {
    expect(SAMPLE.length).toBeGreaterThan(500);
  });

  it('attack generation agrees with chess.js attackers()', () => {
    for (const { fen } of SAMPLE.filter((_, i) => i % 5 === 0)) {
      const chess = new Chess(fen);
      const board = parsePlacement(fen);
      for (let sq = 0; sq < 64; sq++) {
        for (const color of ['w', 'b'] as const) {
          const mine = attackersOf(board, sq, color).map(squareName).sort();
          const theirs = [...chess.attackers(squareName(sq) as ChessSquare, color)].sort();
          expect(mine, `${fen} ${squareName(sq)} ${color}`).toEqual(theirs);
        }
      }
    }
  });

  it('every piece reported as hanging for the side to move can really be captured, and facts never throw', () => {
    for (const { fen } of SAMPLE) {
      const chess = new Chess(fen);
      const legalCaptureTargets = new Set(chess.moves({ verbose: true }).filter((m) => m.isCapture()).map((m) => m.to as string));
      const facts = computePositionFacts(fen);
      expect(facts.hanging).toEqual(findHanging(fen));
      for (const h of facts.hanging) {
        expect(h.seeLossCp).toBeGreaterThan(0);
        expect(h.piece).not.toBe('k');
        expect(h.attackers.length).toBeGreaterThan(0);
        if (h.color !== facts.sideToMove) expect(legalCaptureTargets.has(h.square), `${fen} ${h.square}`).toBe(true);
      }
      expect(facts.material.diff).toBe(facts.material.w - facts.material.b);
      expect(facts.legalMoveCount).toBe(chess.moves().length);
    }
  });

  it('motif detection and material swing are total functions on arbitrary legal lines', () => {
    for (const { fen, continuation } of SAMPLE) {
      const detail = describeMotif(fen, continuation);
      if (detail) {
        expect(detail.ply % 2).toBe(0);
        expect(detail.ply).toBeLessThan(continuation.length);
      }
      const swing = materialSwing(fen, continuation);
      expect(Number.isInteger(swing)).toBe(true);
      expect(Math.abs(swing)).toBeLessThanOrEqual(39);
    }
  });
});
