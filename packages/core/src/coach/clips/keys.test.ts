import { describe, expect, it } from 'vitest';
import type { PieceType } from '@gambit/shared';
import { sanToSpokenRu } from '../spoken.ts';
import { moveInsRu } from '../strategy.ts';
import {
  CLIP_ID_RE,
  CLIP_VOICE_KEY,
  allMoveSlotKeys,
  allSplitSlotKeys,
  buildClipIndex,
  canonicalSlotText,
  clipFile,
  clipId,
  cyrb53,
  fragEndOf,
  fragKey,
  hash13,
  lineUnitKey,
  moveTailsOf,
  normalizeFragment,
  normalizeSan,
  parseSlotKey,
  poolKeyOf,
  slotFormOf,
  slotKeyOf,
  splitOf,
  squareFromSpoken,
  verifyMove,
} from './keys.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** 1.e4 d5 — White to move, exd5 possible */
const SCANDI = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
/** Italian: White may castle short */
const ITALIAN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
/** two rooks can reach d1: Rad1 / Rfd1 */
const TWO_ROOKS = 'k7/8/8/8/8/8/8/R4RK1 w - - 0 1';
const PROMO = '8/4P3/8/8/8/8/k7/4K3 w - - 0 1';
/** en passant: 1.e4 a6 2.e5 d5 */
const EN_PASSANT = 'rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
/** Scholar's mate in one: Qxf7# */
const SCHOLAR = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

const DIAG_STRING_RE = /^[A-Za-z0-9 _.:/+()-]{0,64}$/; // apps/web/src/coach/voiceDiag.ts
const PIECES: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const LETTER: Record<PieceType, string> = { p: '', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };
const SQUARES = [...'abcdefgh'].flatMap((f) => [...'12345678'].map((r) => `${f}${r}`));

describe('clip ids (golden)', () => {
  it('cyrb53 matches the published reference values', () => {
    expect(cyrb53('a')).toBe(7929297801672961);
    expect(cyrb53('b')).toBe(8684336938537663);
    expect(cyrb53('revenge')).toBe(4051478007546757);
    expect(cyrb53('revenue')).toBe(8309097637345594);
  });

  it('pins the ids of paid takes — a change here re-keys the whole library', () => {
    expect(CLIP_VOICE_KEY).toBe('giselle-mm1');
    expect(clipId('giselle-mm1', 'Попробуй так:')).toBe('c4bbe3eca06d0d');
    expect(clipId('giselle-mm1', 'конём на эф шесть', 0)).toBe('c9a6ce27f9ef28');
    expect(clipId('giselle-mm1', 'конём на эф шесть', 0, 2)).toBe('c3c3f98fb9682b');
    expect(clipId('giselle-mm1', 'Мой совет — конь на эф три.<#0.6#>Попробуй так:', 1)).toBe('c7989fdb4c1b07');
    expect(hash13('')).toBe('bdcb81aee8d83');
  });

  it('take 1 is the SPEC formula; later takes and other cuts never collide', () => {
    const ids = new Set([clipId(CLIP_VOICE_KEY, 'Ого!', 0), clipId(CLIP_VOICE_KEY, 'Ого!', 0, 2), clipId(CLIP_VOICE_KEY, 'Ого!', 1), clipId('other-voice', 'Ого!', 0)]);
    expect(ids.size).toBe(4);
    expect(clipId(CLIP_VOICE_KEY, 'Ого!', 0, 1)).toBe(clipId(CLIP_VOICE_KEY, 'Ого!'));
  });

  it('ids are 13 hex characters after a «c», pass the black box filter and map to 256 folders', () => {
    for (const text of ['Ого!', 'конём на эф шесть', 'Смотри, тут подарок!', '']) {
      const id = clipId(CLIP_VOICE_KEY, text);
      expect(id).toMatch(CLIP_ID_RE);
      expect(id).toMatch(DIAG_STRING_RE);
      expect(clipFile(id)).toBe(`${id.slice(1, 3)}/${id}.mp3`);
    }
  });
});

describe('canonicalSlotText agrees with the spoken builders', () => {
  it('nom / cap for every piece × square equal sanToSpokenRu', () => {
    for (const p of PIECES) {
      for (const sq of SQUARES) {
        expect(canonicalSlotText(`nom:${p}:${sq}`)).toBe(sanToSpokenRu(`${LETTER[p]}${sq}`));
        const otherFile = sq[0] === 'a' ? 'b' : 'a';
        const cap = p === 'p' ? `${otherFile}x${sq}` : `${LETTER[p]}x${sq}`;
        expect(canonicalSlotText(`cap:${p}:${sq}`)).toBe(sanToSpokenRu(cap));
      }
    }
  });

  it('ins for every piece × square equals moveInsRu (pawns off the last ranks)', () => {
    for (const p of PIECES) {
      for (const sq of SQUARES) {
        if (p === 'p' && (sq[1] === '1' || sq[1] === '8')) continue;
        expect(canonicalSlotText(`ins:${p}:${sq}`)).toBe(moveInsRu(`${LETTER[p]}${sq}`));
      }
    }
  });

  it('castling says the whole line in both forms', () => {
    expect(canonicalSlotText('nom:castle:short')).toBe(sanToSpokenRu('O-O'));
    expect(canonicalSlotText('nom:castle:long')).toBe(sanToSpokenRu('O-O-O'));
    expect(canonicalSlotText('ins:castle:short')).toBe(moveInsRu('O-O'));
    expect(canonicalSlotText('ins:castle:long')).toBe(moveInsRu('O-O-O'));
  });

  it('drops disambiguation, promotion and check — they are the arrow and tails of their own', () => {
    const rook = slotKeyOf('Rad1', TWO_ROOKS, 'nom');
    expect(rook).toBe('nom:r:d1');
    expect(canonicalSlotText(rook as string)).toBe(sanToSpokenRu('Rd1'));
    expect(sanToSpokenRu('Rad1', TWO_ROOKS)).toBe('ладья с а один на дэ один');
    const promo = slotKeyOf('e8=Q', PROMO, 'nom');
    expect(promo).toBe('nom:p:e8');
    expect(sanToSpokenRu('e8=Q').startsWith(canonicalSlotText(promo as string))).toBe(true);
    expect(moveTailsOf('e8=Q', PROMO)).toEqual({ promotion: 'q' });
    const mate = slotKeyOf('Qxf7#', SCHOLAR, 'cap');
    expect(mate).toBe('cap:q:f7');
    expect(sanToSpokenRu('Qxf7#')).toBe(`${canonicalSlotText(mate as string)}, мат`);
    expect(moveTailsOf('Qxf7#', SCHOLAR)).toEqual({ check: 'mate' });
    expect(moveTailsOf('Nf3', START)).toEqual({});
  });

  it('says the split set', () => {
    expect(canonicalSlotText('sq:f6')).toBe('на эф шесть');
    expect(canonicalSlotText('xsq:d5')).toBe('бьёт на дэ пять');
    expect(canonicalSlotText('head:ins:n')).toBe('конём');
    expect(canonicalSlotText('head:nom:r')).toBe('ладья');
  });

  it('refuses anything that is not a slot key', () => {
    for (const bad of ['', 'nom', 'nom:n', 'nom:x:f3', 'nom:n:z9', 'cap:castle:short', 'foo:n:f3', 'sq:i9', 'head:cap:n', 'nom:castle:middle']) {
      expect(parseSlotKey(bad)).toBeNull();
      expect(canonicalSlotText(bad)).toBe('');
    }
  });
});

describe('slotKeyOf works on chess.js-verified SAN only', () => {
  it('keys a quiet move in its forms', () => {
    expect(slotKeyOf('Nf3', START, 'nom')).toBe('nom:n:f3');
    expect(slotKeyOf('Nf3', START, 'ins')).toBe('ins:n:f3');
    expect(slotKeyOf('Nf3!?', START, 'ins')).toBe('ins:n:f3');
    expect(slotKeyOf('e4', START, 'ins')).toBe('ins:p:e4');
    expect(slotKeyOf('Nf3', START, 'cap')).toBeNull();
  });

  it('keys captures (en passant too) only as cap', () => {
    expect(slotKeyOf('exd5', SCANDI, 'cap')).toBe('cap:p:d5');
    expect(slotKeyOf('exd5', SCANDI, 'nom')).toBeNull();
    expect(slotKeyOf('exd5', SCANDI, 'ins')).toBeNull();
    expect(slotKeyOf('exd6', EN_PASSANT, 'cap')).toBe('cap:p:d6');
    expect(slotFormOf('exd5', SCANDI, 'ins')).toBe('cap');
  });

  it('keys castling and promotion', () => {
    expect(slotKeyOf('O-O', ITALIAN, 'nom')).toBe('nom:castle:short');
    expect(slotKeyOf('O-O', ITALIAN, 'ins')).toBe('ins:castle:short');
    expect(slotKeyOf('O-O', ITALIAN, 'cap')).toBeNull();
    expect(slotKeyOf('e8=Q', PROMO, 'ins')).toBeNull();
    expect(slotFormOf('e8=Q', PROMO, 'ins')).toBe('nom');
    expect(slotFormOf('O-O', ITALIAN, 'ins')).toBe('ins');
  });

  it('never keys an illegal move or a broken position — the piece comes from the board, not from text', () => {
    expect(slotKeyOf('Nf6', START, 'nom')).toBeNull(); // Black's move, White to play
    expect(slotKeyOf('Bc4', START, 'nom')).toBeNull(); // blocked
    expect(slotKeyOf('Nf3', 'not a fen', 'nom')).toBeNull();
    expect(slotKeyOf('', START, 'nom')).toBeNull();
    expect(verifyMove('Nf3', START)).toMatchObject({ piece: 'n', from: 'g1', to: 'f3', capture: false, san: 'Nf3' });
  });

  it('normalises SAN for the guard', () => {
    expect(normalizeSan('Qxf7#')).toBe('Qxf7');
    expect(normalizeSan(' e8=Q+ ')).toBe('e8Q');
    expect(normalizeSan('0-0')).toBe('O-O');
    expect(normalizeSan('0-0-0')).toBe('O-O-O');
    expect(normalizeSan('Nf3!?')).toBe('Nf3');
  });
});

describe('the slot domains', () => {
  it('the split set is 140 units: 64 «на X», 64 «бьёт на X», 6 + 6 heads', () => {
    const keys = allSplitSlotKeys();
    expect(keys).toHaveLength(140);
    expect(new Set(keys).size).toBe(140);
    for (const k of keys) expect(canonicalSlotText(k)).not.toBe('');
  });

  it('every whole move unit is sayable, short and Latin-free', () => {
    const keys = allMoveSlotKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(6 * 64 * 2 + 5 * 64 + 48 + 4);
    for (const k of keys) {
      const t = canonicalSlotText(k);
      expect(t).not.toBe('');
      expect(t).not.toMatch(/[A-Za-z]/);
      expect(t.split(' ').length).toBeLessThanOrEqual(5);
    }
  });

  it('splits a whole move into its head and square; castling has no split form', () => {
    expect(splitOf('ins:n:f6')).toEqual(['head:ins:n', 'sq:f6']);
    expect(splitOf('nom:p:e4')).toEqual(['head:nom:p', 'sq:e4']);
    expect(splitOf('cap:q:h7')).toEqual(['head:nom:q', 'xsq:h7']);
    expect(splitOf('nom:castle:short')).toBeNull();
  });

  it('reads spoken squares back', () => {
    expect(squareFromSpoken('эф', 'шесть')).toBe('f6');
    expect(squareFromSpoken('а', 'один')).toBe('a1');
    expect(squareFromSpoken('же', 'восемь')).toBe('g8');
    expect(squareFromSpoken('зэ', 'один')).toBeNull();
  });
});

describe('unit and pool keys', () => {
  it('pool keys carry the piece and the child-gender variant', () => {
    expect(poolKeyOf('reason.attack')).toBe('reason.attack');
    expect(poolKeyOf('reason.attack', 'n')).toBe('reason.attack@n');
    expect(poolKeyOf('ask.find', undefined, 'f')).toBe('ask.find/f');
    expect(poolKeyOf('praise.x', 'q', 'm')).toBe('praise.x@q/m');
    expect(lineUnitKey('teach.head.advice', 1)).toBe('line:teach.head.advice#1');
  });

  it('fragment keys: lower case, ё → е, quotes / stress dropped, commas and hyphens kept, the end after «|»', () => {
    expect(fragKey('Смотри, тут подарок!', '!')).toBe('f:смотри, тут подарок|!');
    expect(fragKey('Мой совет —', '—')).toBe('f:мой совет|—');
    expect(fragKey('  Найдёшь  ход сам? ', '?')).toBe('f:найдешь ход сам|?');
    expect(fragKey('Жми «Подсказка»', '.')).toBe('f:жми подсказка|.');
    expect(normalizeFragment('Так-так…')).toBe('так-так');
    expect(normalizeFragment('И-го-го!')).toBe('и-го-го');
    expect(normalizeFragment('— так мы давим на центр.')).toBe('так мы давим на центр');
    expect(normalizeFragment('ла́дья')).toBe('ладья');
  });

  it('maps punctuation runs to fragment ends', () => {
    expect(fragEndOf('?!')).toBe('?');
    expect(fragEndOf('...')).toBe('…');
    expect(fragEndOf('!!')).toBe('!');
    expect(fragEndOf(' — ')).toBe('—');
    expect(fragEndOf(':')).toBe(':');
    expect(fragEndOf('')).toBe('');
  });

  it('builds an index: units, pools and keys, deduplicated', () => {
    const idx = buildClipIndex(
      [
        { id: 'c0000000000001', key: 'line:a#1', text: 'Ого!', ms: 500, pools: ['a', 'a@n'], alsoKeys: ['frag:f:ого|!'] },
        { id: 'c0000000000001', key: 'line:a#1', text: 'Ого!', ms: 500, pools: ['a'] },
        { id: 'c0000000000002', key: 'slot:sq:f6', text: 'на эф шесть', ms: 700 },
      ],
      { a: 'b' },
    );
    expect(idx.pools).toEqual({ a: ['c0000000000001'], 'a@n': ['c0000000000001'] });
    expect(idx.keys['line:a#1']).toEqual(['c0000000000001']);
    expect(idx.keys['frag:f:ого|!']).toEqual(['c0000000000001']);
    expect(idx.keys['slot:sq:f6']).toEqual(['c0000000000002']);
    expect(idx.units['c0000000000002']).toEqual({ key: 'slot:sq:f6', text: 'на эф шесть', ms: 700 });
    expect(idx.fallbacks).toEqual({ a: 'b' });
  });
});
