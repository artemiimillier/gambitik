/**
 * What Гамбитик says without a microphone (docs/voice-clips/SPEC.md §8.2, §8.3): the opponent's
 * move named WITHOUT its square, every answer with a valid clip twin, the thought chips gendered by `address`, his
 * replies as a boy («я готов», «я заметил»).
 */
import { describe, expect, it } from 'vitest';
import { CLIP_TAP_LINES, poolKeyOf, validateClipUtterance } from '@gambit/core';
import type { CoachEvent, PieceType, Threat } from '@gambit/shared';
import { askChipsFor, opponentAnswerEvent, pokeClip, repeatEvent, repeatStaleEvent, thoughtChips, thoughtReplyEvent, thoughtText, whyNothingEvent } from './clipAsk.ts';
import { clipPreviewEvent } from './clipSettings.ts';
import dockSource from '../MascotDock.tsx?raw';
import scriptSource from '../../../../../tools/voice-clips/script.giselle-mm1.json?raw';

const SQUARE_WORDS = /(?:^|\s)(?:а|бэ|цэ|дэ|е|эф|же|аш)\s+(?:один|два|три|четыре|пять|шесть|семь|восемь)(?![а-я])/u;

function lines(event: CoachEvent): string[] {
  return (event.clip?.sentences ?? []).flatMap((s) => s.items.map((i) => ('line' in i ? `${i.line}${i.piece ? `@${i.piece}` : ''}` : `slot:${i.slot}`)));
}

describe('«Что задумал соперник?» — piece-only, never a square', () => {
  const cases: [string, string, string, string, RegExp][] = [
    // [what, fen before the bot's move, the bot's move, line, text]
    ['a developed knight', 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', 'Nf6', 'opp.developed@n', /^Соперник вывел коня\.$/],
    ['a pawn move', 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', 'e5', 'opp.pawn', /^Соперник пошёл пешкой\.$/],
    ['a capture', 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2', 'Qxd5', 'opp.took@p', /^Соперник забрал твою пешку\.$/],
    ['an attack on a piece', 'rnbqkbnr/pppp1ppp/8/4p3/8/3P1N2/PPP1PPPP/RNBQKB1R b KQkq - 0 2', 'e4', 'opp.attack@n', /^Соперник напал на твоего коня!$/],
    ['a check', 'rnbqkbnr/pppp1ppp/8/4p3/4PP2/8/PPPP2PP/RNBQKBNR b KQkq f3 0 2', 'Qh4+', 'opp.check', /шах/],
    ['castling', 'rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 5 4', 'O-O', 'opp.castled', /рокировку/],
    ['a mate threat (the static mate-in-one check)', 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3', 'Qh5', 'ask.opp.mate', /^Он грозит матом!$/],
    ['another piece move', 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2', 'Qf6', 'opp.moved@q', /^Соперник пошёл ферзём\.$/],
  ];
  it.each(cases)('%s', (_what, fenBefore, san, line, text) => {
    const event = opponentAnswerEvent({ san, fenBefore });
    expect(lines(event)).toEqual([line]);
    expect(event.text).toMatch(text);
    expect(event.bubbleText).toBe(event.text);
    expect(event.text).not.toMatch(SQUARE_WORDS);
    expect(event.text).not.toMatch(/[A-Za-z]/);
    expect(event.kind).toBe('answer');
    expect(event.pauseClock).toBe(true);
    expect(validateClipUtterance(event.clip as NonNullable<CoachEvent['clip']>)).toEqual([]);
  });

  it('no bot move yet (or a broken one): «ход за тобой» — its own line, never «ничего страшного не задумал»', () => {
    for (const last of [null, { san: 'Zz9', fenBefore: 'broken' }]) {
      const event = opponentAnswerEvent(last);
      expect(lines(event)).toEqual(['ask.opp.notYet']);
      expect(event.text).toBe('Соперник ещё не ходил — ход за тобой!');
    }
  });
});

describe('«Что задумал соперник?» — his THREAT first (the null-move search the game already made), never a square', () => {
  // after 1.e4 e5 2.Nf3 the bot (Black) played 2…Nc6: the child (White) to move
  const last = { san: 'Nc6', fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' };
  const threat = (motif: Threat['motif'], targetSquares: Threat['targetSquares']): Threat => ({ uci: 'c6d4', san: 'Nd4', motif, targetSquares, gainCp: 300 });
  const cases: [string, Threat, string, RegExp][] = [
    ['a mate', threat('mateIn2', ['e1']), 'ask.opp.mate', /^Он грозит матом!$/],
    ['a fork', threat('fork', ['d1', 'h1']), 'ask.opp.fork', /^Он готовит вилку!$/],
    ['a piece he wants to take', threat('hangingPiece', ['f3']), 'ask.opp.hanging@n', /^Он хочет забрать твоего коня!$/],
    ['a pawn he wants to take', threat('hangingPiece', ['e4']), 'ask.opp.hanging@p', /^Он хочет забрать твою пешку!$/],
    ['another idea', threat('pin', ['e8']), 'ask.opp.threat', /посмотри внимательно/],
  ];
  it.each(cases)('%s', (_what, t, line, text) => {
    const event = opponentAnswerEvent(last, t);
    expect(lines(event)).toEqual([line]);
    expect(event.text).toMatch(text);
    expect(event.text).not.toMatch(SQUARE_WORDS);
    // the board shows where (red), the words never do
    expect(event.board?.highlights.every((h) => h.color === 'red')).toBe(true);
    expect(event.board?.arrows).toEqual([]);
    expect(validateClipUtterance(event.clip as NonNullable<CoachEvent['clip']>)).toEqual([]);
  });

  it('no threat found by the engine: his move, then «пока ничего страшного он не задумал» (an optional second sentence)', () => {
    const event = opponentAnswerEvent(last, null);
    expect(lines(event)).toEqual(['opp.developed@n', 'ask.opp.none']);
    expect(event.text).toBe('Соперник вывел коня. Пока ничего страшного он не задумал.');
    expect(event.clip?.sentences.map((x) => x.prio)).toEqual([100, 60]);
    expect(event.board).toBeUndefined();
    // not known (the search did not run): nothing is claimed about his plans
    expect(lines(opponentAnswerEvent(last))).toEqual(['opp.developed@n']);
  });

  it('a check comes first, whatever the threat', () => {
    const check = opponentAnswerEvent({ san: 'Qh4+', fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4PP2/8/PPPP2PP/RNBQKBNR b KQkq f3 0 2' }, threat('hangingPiece', ['e4']));
    expect(lines(check)).toEqual(['opp.check']);
  });
});

describe('the other answers', () => {
  it('«Почему так?» with nothing to explain asks the child a question — its own line, never «просто хороший ход»', () => {
    const event = whyNothingEvent();
    expect(lines(event)).toEqual(['ask.why.think']);
    expect(event.text).toBe('Давай подумаем вместе: какая фигура ещё не в игре?');
    expect(validateClipUtterance(event.clip as NonNullable<CoachEvent['clip']>)).toEqual([]);
  });

  it('«Повтори» after the board changed: a short recorded line — no board, no move', () => {
    const event = repeatStaleEvent();
    expect(lines(event)).toEqual(['ask.repeat.stale']);
    expect(event.board).toBeUndefined();
    expect(event.text).not.toMatch(SQUARE_WORDS);
    expect(validateClipUtterance(event.clip as NonNullable<CoachEvent['clip']>)).toEqual([]);
  });

  it('«Повтори»: the same words and twin under a new id', () => {
    const last = whyNothingEvent();
    const again = repeatEvent(last);
    expect(again.id).not.toBe(last.id);
    expect(again.text).toBe(last.text);
    expect(again.clip).toEqual(last.clip);
  });

  it('a poke is a recorded catchphrase with a bark pose', () => {
    expect(pokeClip('cheer')).toEqual({ sentences: [{ items: [{ line: 'poke' }], prio: 100, end: '!' }], generic: 'generic.answer.poke', bark: 'cheer' });
  });

  it('the «Спроси» chips name the hint after the style', () => {
    expect(askChipsFor({ coachStyle: 'teacher', hintAvailable: true }).map((c) => c.label)).toEqual(['Почему так?', 'Что задумал соперник?', 'Совет', 'Повтори']);
    expect(askChipsFor({ coachStyle: 'helper', hintAvailable: false }).map((c) => c.kind)).toEqual(['why', 'opponent', 'repeat']);
  });
});

describe('after the game: «Как тебе партия?»', () => {
  it('chips are gendered by the child\'s address', () => {
    expect(thoughtChips('m').map((c) => c.label)).toEqual(['Было легко', 'Было трудно', 'Я нашёл хороший ход', 'Понял свою ошибку', 'Хочу реванш!']);
    expect(thoughtChips('f').map((c) => c.label)).toEqual(['Было легко', 'Было трудно', 'Я нашла хороший ход', 'Поняла свою ошибку', 'Хочу реванш!']);
    expect(thoughtText('hard', 'f')).toBe('Было трудно (выбрала кнопкой)');
  });

  it('his replies are recorded lines, short and warm — and he speaks of himself as a boy', () => {
    for (const chip of ['easy', 'hard', 'goodMove', 'mistake', 'rematch'] as const) {
      const reply = thoughtReplyEvent(chip);
      expect(lines(reply)).toEqual([`thought.${chip}`]);
      expect(reply.text.split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(reply.text.toLowerCase()).not.toMatch(/(?<![а-яё])(?:готова|заметила|рада)(?![а-яё])/u);
      expect(validateClipUtterance(reply.clip as NonNullable<CoachEvent['clip']>)).toEqual([]);
    }
    expect(thoughtReplyEvent('rematch').text).toContain('Я готов');
    expect(thoughtReplyEvent('goodMove').text).toContain('заметил');
  });
});

// ───────────────────────── every tap line is recorded early ─────────────────────────

interface ScriptUnitLike {
  key: string;
  line?: string;
  pools?: string[];
  tier?: string;
}

const SCRIPT = JSON.parse(scriptSource) as { units: ScriptUnitLike[] };
/** the sources of this folder (tests left out) and the dock */
const SOURCES: Record<string, string> = import.meta.glob(['./*.ts', './*.tsx', '!./*.test.ts', '!./*.test.tsx'], { query: '?raw', import: 'default', eager: true });
const EARLY = SCRIPT.units.filter((u) => u.tier === 'pilot' || u.tier === 'starter');

/** Every (line, piece) the web layer's taps can emit, by exercising clipAsk / the dock's poke / the settings preview. */
function emittedTapPools(): Set<string> {
  const events: CoachEvent[] = [whyNothingEvent(), repeatStaleEvent(), opponentAnswerEvent(null), clipPreviewEvent(1)];
  const opp = (fenBefore: string, san: string, threat?: Threat | null): void => void events.push(opponentAnswerEvent({ san, fenBefore }, threat));
  const E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  opp(E4, 'Nf6', null);
  opp(E4, 'e5', null);
  opp('rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2', 'Qxd5', null);
  opp('rnbqkbnr/pppp1ppp/8/4p3/8/3P1N2/PPP1PPPP/RNBQKB1R b KQkq - 0 2', 'e4');
  opp('rnbqkbnr/pppp1ppp/8/4p3/4PP2/8/PPPP2PP/RNBQKBNR b KQkq f3 0 2', 'Qh4+');
  opp('rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 5 4', 'O-O', null);
  opp('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2', 'Qf6', null);
  const t = (motif: Threat['motif']): Threat => ({ uci: 'c6d4', san: 'Nd4', motif, targetSquares: ['f3'], gainCp: 300 });
  const after = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
  for (const m of ['mateIn1', 'fork', 'hangingPiece', 'pin'] as const) opp(after, 'Nc6', m === 'pin' ? { ...t(m), targetSquares: ['e8'] } : t(m));
  for (const chip of ['easy', 'hard', 'goodMove', 'mistake', 'rematch'] as const) events.push(thoughtReplyEvent(chip));
  const pools = new Set<string>();
  for (const e of events) for (const x of e.clip?.sentences ?? []) for (const i of x.items) if ('line' in i) pools.add(poolKeyOf(i.line, i.piece, i.g));
  for (const i of pokeClip('talk').sentences[0]?.items ?? []) if ('line' in i) pools.add(i.line);
  return pools;
}

describe('the tap lines (CLIP_TAP_LINES of @gambit/core) — what the web says on a tap is recorded in the `pilot` or Starter tier', () => {
  const tapPools = new Set(CLIP_TAP_LINES.flatMap((t) => (t.pieces ?? [undefined]).map((p) => poolKeyOf(t.line, p as PieceType | undefined))));

  it('clipAsk, the poke and «Послушать» emit only tap lines', () => {
    const emitted = emittedTapPools();
    expect([...emitted].filter((p) => !tapPools.has(p) && !tapPools.has(p.replace(/@[pnbrqk]$/u, '')))).toEqual([]);
    // (and every tap line is really emitted by something)
    const lines = new Set([...emitted].map((p) => p.replace(/@[pnbrqk]$/u, '')));
    expect(CLIP_TAP_LINES.map((t) => t.line).filter((l) => !lines.has(l))).toEqual([]);
  });

  it('every tap line (each piece it can name) has a `pilot` or Starter tier recording in the committed script', () => {
    const uncovered = [...tapPools].filter((pool) => !EARLY.some((u) => u.pools?.includes(pool)));
    expect(uncovered).toEqual([]);
  });

  it('every line id written in apps/web/src/coach/clips/*.ts and the dock has a `pilot` or Starter tier recording', () => {
    const texts = [...Object.values(SOURCES), dockSource];
    expect(Object.keys(SOURCES)).toContain('./clipAsk.ts');
    const ids = new Set<string>();
    for (const text of texts) for (const m of text.matchAll(/\bline: '([a-zA-Z][\w.]*)'/gu)) ids.add(m[1] as string);
    expect(ids.size).toBeGreaterThan(10);
    expect([...ids].filter((id) => !EARLY.some((u) => u.line === id))).toEqual([]);
  });
});
