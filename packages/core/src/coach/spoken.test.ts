import { describe, expect, it } from 'vitest';
import type { PieceType } from '@gambit/shared';
import {
  parseSan,
  pieceGenderRu,
  pieceNameRu,
  sanLineToBubbleRu,
  sanToBubbleRu,
  sanToSpokenRu,
  squareToSpokenRu,
} from './spoken.ts';

const LATIN = /[A-Za-z]/;

describe('squareToSpokenRu', () => {
  it.each([
    ['a1', 'а один'],
    ['b2', 'бэ два'],
    ['c3', 'цэ три'],
    ['d4', 'дэ четыре'],
    ['e5', 'е пять'],
    ['f6', 'эф шесть'],
    ['g7', 'же семь'],
    ['h8', 'аш восемь'],
  ])('%s → %s', (sq, spoken) => {
    expect(squareToSpokenRu(sq)).toBe(spoken);
  });

  it('returns an empty string for non-squares', () => {
    expect(squareToSpokenRu('z9')).toBe('');
    expect(squareToSpokenRu('')).toBe('');
    expect(squareToSpokenRu('e44')).toBe('');
  });
});

describe('pieceNameRu', () => {
  it('declines every piece in four cases', () => {
    const table: Record<PieceType, [string, string, string, string]> = {
      p: ['пешка', 'пешку', 'пешки', 'пешкой'],
      n: ['конь', 'коня', 'коня', 'конём'],
      b: ['слон', 'слона', 'слона', 'слоном'],
      r: ['ладья', 'ладью', 'ладьи', 'ладьёй'],
      q: ['ферзь', 'ферзя', 'ферзя', 'ферзём'],
      k: ['король', 'короля', 'короля', 'королём'],
    };
    for (const [p, [nom, acc, gen, ins]] of Object.entries(table) as [PieceType, [string, string, string, string]][]) {
      expect(pieceNameRu(p, 'nom')).toBe(nom);
      expect(pieceNameRu(p, 'acc')).toBe(acc);
      expect(pieceNameRu(p, 'gen')).toBe(gen);
      expect(pieceNameRu(p, 'ins')).toBe(ins);
    }
  });

  it('knows the grammatical gender', () => {
    expect(pieceGenderRu('p')).toBe('f');
    expect(pieceGenderRu('r')).toBe('f');
    expect(pieceGenderRu('n')).toBe('m');
    expect(pieceGenderRu('q')).toBe('m');
  });
});

describe('sanToSpokenRu', () => {
  it.each([
    // the three examples from ARCHITECTURE §3
    ['Nf3', 'конь на эф три'],
    ['exd5', 'пешка бьёт на дэ пять'],
    ['O-O', 'короткая рокировка'],
    // pieces
    ['e4', 'пешка на е четыре'],
    ['Bc4', 'слон на цэ четыре'],
    ['Rd1', 'ладья на дэ один'],
    ['Qh5', 'ферзь на аш пять'],
    ['Kg2', 'король на же два'],
    // captures
    ['Nxe5', 'конь бьёт на е пять'],
    ['Bxf7+', 'слон бьёт на эф семь, шах'],
    ['Qxh7#', 'ферзь бьёт на аш семь, мат'],
    ['B:f7', 'слон бьёт на эф семь'],
    // check / mate suffixes
    ['Qe2+', 'ферзь на е два, шах'],
    ['Re8#', 'ладья на е восемь, мат'],
    // castling
    ['O-O-O', 'длинная рокировка'],
    ['0-0', 'короткая рокировка'],
    ['0-0-0', 'длинная рокировка'],
    ['O-O+', 'короткая рокировка, шах'],
    ['O-O-O#', 'длинная рокировка, мат'],
    // promotion
    ['e8=Q', 'пешка на е восемь превращается в ферзя'],
    ['e8Q', 'пешка на е восемь превращается в ферзя'],
    ['a1=N', 'пешка на а один превращается в коня'],
    ['h8=R+', 'пешка на аш восемь превращается в ладью, шах'],
    ['c1=B', 'пешка на цэ один превращается в слона'],
    ['dxe8=Q#', 'пешка бьёт на е восемь и превращается в ферзя, мат'],
    // disambiguation without a FEN
    ['Rad1', 'ладья с линии а на дэ один'],
    ['Nbd7', 'конь с линии бэ на дэ семь'],
    ['R1d2', 'ладья с первого ряда на дэ два'],
    ['N5xf3', 'конь с пятого ряда бьёт на эф три'],
    ['Ra1d1', 'ладья с а один на дэ один'],
    ['Qh4xe1+', 'ферзь с аш четыре бьёт на е один, шах'],
    // annotation glyphs are ignored
    ['Nf3!', 'конь на эф три'],
    ['Qxe5+??', 'ферзь бьёт на е пять, шах'],
  ])('%s → %s', (san, spoken) => {
    expect(sanToSpokenRu(san)).toBe(spoken);
  });

  it('uses the FEN to say the full origin square («ладья с а один на дэ один»)', () => {
    expect(sanToSpokenRu('Rad1', '4k3/8/8/8/8/8/8/R4RK1 w - - 0 1')).toBe('ладья с а один на дэ один');
    expect(sanToSpokenRu('Rfd1', '4k3/8/8/8/8/8/8/R4RK1 w - - 0 1')).toBe('ладья с эф один на дэ один');
    // knights on b1 and f3 can both reach d2
    expect(sanToSpokenRu('Nbd2', '4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1')).toBe('конь с бэ один на дэ два');
  });

  it('falls back to the partial origin when the FEN does not match the move', () => {
    expect(sanToSpokenRu('Rad1', '4k3/8/8/8/8/8/8/4K3 w - - 0 1')).toBe('ладья с линии а на дэ один');
    expect(sanToSpokenRu('Rad1', 'not a fen')).toBe('ладья с линии а на дэ один');
  });

  it('never leaks Latin letters, even for garbage input', () => {
    for (const san of ['Nf3', 'exd5', 'O-O-O', 'Rad1', 'e8=Q+', 'hello', '', 'Zz9', 'Nf8=Q', '   ']) {
      expect(sanToSpokenRu(san)).not.toMatch(LATIN);
    }
    expect(sanToSpokenRu('hello')).toBe('этот ход');
  });

  it('speaks every legal move of a busy position without Latin', async () => {
    const { Chess } = await import('chess.js');
    const chess = new Chess('r3k2r/pPp1qppp/2n2n2/1B1pp1B1/1b1PP1b1/2N2N2/P1P1QPPP/R3K2R w KQkq - 0 10');
    const moves = chess.moves();
    expect(moves.length).toBeGreaterThan(30);
    for (const san of moves) {
      const spoken = sanToSpokenRu(san, chess.fen());
      expect(spoken, san).not.toMatch(LATIN);
      expect(spoken, san).not.toBe('этот ход');
    }
  });
});

describe('parseSan', () => {
  it('parses the parts of a move', () => {
    expect(parseSan('Nbxd7+')).toEqual({
      kind: 'move',
      piece: 'n',
      fromFile: 'b',
      fromRank: undefined,
      capture: true,
      to: 'd7',
      promotion: undefined,
      suffix: '+',
    });
    expect(parseSan('O-O-O')?.kind).toBe('castleLong');
    expect(parseSan('nonsense')).toBeNull();
  });
});

describe('sanToBubbleRu', () => {
  it.each([
    ['Nf3', 'Кf3'],
    ['Kg2', 'Крg2'],
    ['Qxh7#', 'Фxh7#'],
    ['Rad1', 'Лad1'],
    ['Bb5+', 'Сb5+'],
    ['e4', 'e4'],
    ['exd5', 'exd5'],
    ['e8=Q', 'e8=Ф'],
    ['dxe8=N+', 'dxe8=К+'],
    ['b1=R', 'b1=Л'],
    ['O-O', '0-0'],
    ['O-O-O+', '0-0-0+'],
    ['Nf3!', 'Кf3!'],
  ])('%s → %s', (san, bubble) => {
    expect(sanToBubbleRu(san)).toBe(bubble);
  });

  it('leaves unknown strings untouched', () => {
    expect(sanToBubbleRu('hello')).toBe('hello');
  });

  it('converts a whole line', () => {
    expect(sanLineToBubbleRu(['Nxc2+', 'Kd2', 'Nxa1'])).toBe('Кxc2+ Крd2 Кxa1');
  });
});
