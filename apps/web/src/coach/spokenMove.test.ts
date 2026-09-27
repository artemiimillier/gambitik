import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { normalizeMoveArgument, parsePieceWord, parseSpokenMove } from './spokenMove.ts';

const move = (m: string): { kind: 'move'; move: string } => ({ kind: 'move', move: m });

describe('parseSpokenMove — the move a child names, in Russian speech', () => {
  it('piece + square in any case form, spoken files and ranks', () => {
    expect(parseSpokenMove('а если я пойду конём на эф три?')).toEqual(move('Nf3'));
    expect(parseSpokenMove('Конь эф-три')).toEqual(move('Nf3'));
    expect(parseSpokenMove('можно слоном на цэ четыре')).toEqual(move('Bc4'));
    expect(parseSpokenMove('ладью на дэ один')).toEqual(move('Rd1'));
    expect(parseSpokenMove('ферзём аш пять')).toEqual(move('Qh5'));
    expect(parseSpokenMove('король на жэ один')).toEqual(move('Kg1'));
    expect(parseSpokenMove('пешка е четыре нормально?')).toEqual(move('e4'));
    expect(parseSpokenMove('а если пешкой бэ пять')).toEqual(move('b5'));
  });

  it('squares as a speech-to-text engine writes them: Latin, digits, look-alike Cyrillic letters', () => {
    expect(parseSpokenMove('конь на f3')).toEqual(move('Nf3'));
    expect(parseSpokenMove('слон с4')).toEqual(move('Bc4')); // Cyrillic «с»
    expect(parseSpokenMove('е4')).toEqual(move('e4')); // Cyrillic «е»
    expect(parseSpokenMove('конь эф 3')).toEqual(move('Nf3'));
  });

  it('two squares = from and to (UCI)', () => {
    expect(parseSpokenMove('е два е четыре')).toEqual(move('e2e4'));
    expect(parseSpokenMove('конь с жэ один на эф три')).toEqual(move('g1f3'));
    expect(parseSpokenMove('e2-e4')).toEqual(move('e2e4'));
  });

  it('castling', () => {
    expect(parseSpokenMove('короткая рокировка')).toEqual(move('O-O'));
    expect(parseSpokenMove('а можно сделать рокировку?')).toEqual(move('O-O'));
    expect(parseSpokenMove('длинная рокировка')).toEqual(move('O-O-O'));
    expect(parseSpokenMove('O-O-O')).toEqual(move('O-O-O'));
  });

  it('notation a model typed is taken as it is (a spurious capture sign of a piece move dropped)', () => {
    expect(parseSpokenMove('Nf3')).toEqual(move('Nf3'));
    expect(parseSpokenMove('ход Nxe5!')).toEqual(move('Ne5'));
    expect(parseSpokenMove('exd5')).toEqual(move('exd5'));
    expect(parseSpokenMove('Кf3')).toEqual(move('Nf3'));
    expect(parseSpokenMove('Nbd2')).toEqual(move('Nbd2'));
  });

  it('about a move, but which one is unclear → partial (the model asks again)', () => {
    expect(parseSpokenMove('а если на эф три?')).toEqual({ kind: 'partial' });
    expect(parseSpokenMove('а если пойти конём?')).toEqual({ kind: 'partial' });
    expect(parseSpokenMove('можно съесть пешку?')).toEqual({ kind: 'partial' });
  });

  it('no move at all', () => {
    expect(parseSpokenMove('')).toEqual({ kind: 'none' });
    expect(parseSpokenMove('что хочет соперник?')).toEqual({ kind: 'none' });
    expect(parseSpokenMove('почему конь такой смешной')).toEqual({ kind: 'none' });
    expect(parseSpokenMove('а где мама')).toEqual({ kind: 'none' });
  });
});

describe('normalizeMoveArgument — the evaluate_move argument of a voice model', () => {
  it('SAN / UCI / castling / Russian words; null when unclear or not a string', () => {
    expect(normalizeMoveArgument('Nf3')).toBe('Nf3');
    expect(normalizeMoveArgument('Bxc6+')).toBe('Bc6');
    expect(normalizeMoveArgument('e7e8q')).toBe('e7e8q');
    expect(normalizeMoveArgument('e8=Q')).toBe('e8=Q');
    expect(normalizeMoveArgument('0-0')).toBe('O-O');
    expect(normalizeMoveArgument('конь на эф три')).toBe('Nf3');
    expect(normalizeMoveArgument('конём')).toBeNull();
    expect(normalizeMoveArgument('')).toBeNull();
    expect(normalizeMoveArgument(undefined)).toBeNull();
    expect(normalizeMoveArgument(3)).toBeNull();
  });

  it('what it produces is accepted by chess.js (the rules library of the tool host)', () => {
    const chess = new Chess('rnbqkbnr/ppp1pppp/8/3p4/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 1 2');
    // «конь бьёт на дэ пять»: SAN without «x» is accepted for a capture, a spurious «x» would not be
    for (const [spoken, san] of [
      ['конь на дэ пять', 'Nxd5'],
      ['Nxd5', 'Nxd5'],
      ['exd5', 'exd5'],
      ['конь жэ один на эф три', 'Nf3'],
    ] as const) {
      const normalized = normalizeMoveArgument(spoken);
      expect(normalized).not.toBeNull();
      expect(chess.move(normalized ?? '', { strict: false }).san).toBe(san);
      chess.undo();
    }
  });
});

describe('parsePieceWord — «а почему не ферзём?» (teacher mode, docs/TEACHER-MODE.md §7.1)', () => {
  it('any case form of every piece; the first one named wins; a model\'s bare letter works too', () => {
    expect(parsePieceWord('а почему не ферзём?')).toBe('q');
    expect(parsePieceWord('почему не конем')).toBe('n');
    expect(parsePieceWord('а не лучше слоном?')).toBe('b');
    expect(parsePieceWord('почему бы не ладьёй')).toBe('r');
    expect(parsePieceWord('а пешкой?')).toBe('p');
    expect(parsePieceWord('почему не королём')).toBe('k');
    expect(parsePieceWord('ферзь')).toBe('q');
    expect(parsePieceWord('почему не конём, а слоном')).toBe('n');
    expect(parsePieceWord('Q')).toBe('q');
    expect(parsePieceWord('а если не так?')).toBeNull();
    expect(parsePieceWord('')).toBeNull();
  });
});
