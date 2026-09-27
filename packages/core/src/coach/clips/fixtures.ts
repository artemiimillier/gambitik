/**
 * Test-only fixture of the «Записи» voice: a tiny catalogue and a manifest index built from it with deterministic ids
 * and durations; `catalogIndex` builds the same from the real catalogue (./catalog.ru.ts) with every move slot.
 * Imported by *.test.ts files only — never by production code, never exported from the barrel.
 */
import type { ClipCatalogLine } from '@gambit/shared';
import { catalogFallbacks, catalogUnits } from './catalog.ts';
import { CLIP_CATALOG } from './catalog.ru.ts';
import { CLIP_VOICE_KEY, allMoveSlotKeys, allSplitSlotKeys, buildClipIndex, canonicalSlotText, clipId, fragKey, fragUnitKey, slotUnitKey } from './keys.ts';
import type { ClipIndexEntry } from './keys.ts';
import type { ClipIndex, FragEnd, SlotKey } from './types.ts';

export const FIXTURE_CATALOG: readonly ClipCatalogLine[] = [
  { id: 'teach.head.advice', role: 'head', join: '—', freq: 4.1, fallback: 'teach.head.arrow', wordings: [{ t: 'Мой совет —' }, { t: 'Попробуй так:' }, { t: 'Смотри, что можно:', mood: 'calm' }] },
  { id: 'teach.head.arrow', role: 'head', join: ':', wordings: [{ t: 'Смотри на зелёную стрелку:' }] },
  { id: 'reason.attack', role: 'tail', byPiece: true, fallback: 'reason.good', wordings: [{ t: '— нападаешь на {коня}!' }, { t: '— и сразу в атаку!' }] },
  { id: 'reason.center', role: 'tail', wordings: [{ t: '— так мы давим на центр.' }] },
  { id: 'reason.good', role: 'tail', wordings: [{ t: '— это крепкий ход.' }] },
  { id: 'ask.find', role: 'whole', byGender: true, freq: 6.2, wordings: [{ t: 'Найдёшь ход {g:сам|сама}?' }, { t: 'Сможешь найти {g:сам|сама}?' }, { t: 'Поищешь?' }] },
  { id: 'danger.hanging', role: 'whole', byPiece: true, wordings: [{ t: '{Твой} {конь} под боем!' }] },
  { id: 'opp.developed', role: 'whole', byPiece: true, wordings: [{ t: 'Соперник вывел {коня}.' }] },
  { id: 'treasure.gift', role: 'whole', freq: 6.5, wordings: [{ t: 'Смотри, тут подарок!' }, { t: 'А тут подарок!' }] },
  { id: 'praise.good', role: 'whole', wordings: [{ t: 'Здорово, я рад!' }, { t: 'Отличный ход!', mood: 'excited' }, { t: 'Хороший ход.', mood: 'calm' }] },
  { id: 'praise.wow', role: 'whole', wordings: [{ t: 'Ого, какой ход!' }] },
  { id: 'bark.cheer', role: 'bark', wordings: [{ t: 'Ого!' }, { t: 'Ух ты!' }] },
  { id: 'bark.think', role: 'bark', wordings: [{ t: 'Хм…' }] },
  { id: 'generic.teachTurn.turn', role: 'whole', wordings: [{ t: 'Смотри на зелёную стрелку!' }, { t: 'Глянь на доску — там подсказка.' }] },
  { id: 'generic.teachTurn', role: 'whole', wordings: [{ t: 'Смотри на доску!' }] },
  { id: 'generic', role: 'whole', wordings: [{ t: 'Давай дальше!' }] },
];

/** Whole move units and the split set the fixture has recorded. */
export const FIXTURE_SLOTS: readonly SlotKey[] = [
  'ins:n:f3',
  'nom:n:f3',
  'ins:p:e4',
  'nom:p:e4',
  'cap:p:d5',
  'ins:b:c4',
  'nom:castle:short',
  'sq:f6',
  'sq:f3',
  'xsq:d5',
  'head:ins:n',
  'head:nom:n',
  'head:nom:p',
  'head:ins:b',
];

/** Compiled fragments the fixture has recorded (text as heard, its end). */
export const FIXTURE_FRAGS: readonly (readonly [string, FragEnd])[] = [
  ['Мой совет —', '—'],
  ['так мы давим на центр.', '.'],
  ['Соперник вывел коня', ''],
  ['Смотри, тут подарок!', '!'],
  ['Найдёшь ход сам?', '?'],
  ['Ходи', ''],
];

export interface FixtureOptions {
  /** pool keys, unit keys (`line:…#n`, `slot:…`, `frag:…`) or slot keys to leave out — a missing recording */
  omit?: readonly string[];
  slots?: readonly SlotKey[];
  frags?: readonly (readonly [string, FragEnd])[];
  /** takes per unit (default 1) */
  takes?: number;
  /** audible ms per character (default 70) */
  msPerChar?: number;
}

/** A manifest body from the fixture catalogue: ids = clipId(voice, text, 0, take), 30 ms onset, ≈ 70 ms per char. */
export function fixtureIndex(opts: FixtureOptions = {}): ClipIndex {
  const omit = new Set(opts.omit ?? []);
  const takes = Math.max(1, opts.takes ?? 1);
  const perChar = opts.msPerChar ?? 70;
  const entries: ClipIndexEntry[] = [];
  const timing = (text: string): { ms: number; on: number; off: number } => {
    const audible = [...text].length * perChar;
    return { ms: audible + 100, on: 30, off: audible + 30 };
  };
  const addTakes = (key: string, text: string, extra: Partial<ClipIndexEntry> = {}): void => {
    for (let take = 1; take <= takes; take++) entries.push({ id: clipId(CLIP_VOICE_KEY, `${key}\n${text}`, 0, take), key, text, take, ...timing(text), ...extra });
  };
  for (const line of FIXTURE_CATALOG) {
    for (const u of catalogUnits(line)) {
      if (u.text === null || omit.has(u.unitKey)) continue;
      const pools = u.pools.filter((p) => !omit.has(p));
      if (pools.length === 0) continue;
      addTakes(u.unitKey, u.text, { pools, ...(u.mood ? { mood: u.mood } : {}), ...(line.role === 'bark' ? { interj: true } : {}) });
    }
  }
  for (const key of opts.slots ?? FIXTURE_SLOTS) {
    const unit = slotUnitKey(key);
    if (omit.has(unit) || omit.has(key)) continue;
    addTakes(unit, canonicalSlotText(key));
  }
  for (const [text, end] of opts.frags ?? FIXTURE_FRAGS) {
    const unit = fragUnitKey(fragKey(text, end));
    if (omit.has(unit)) continue;
    addTakes(unit, text);
  }
  return buildClipIndex(entries, catalogFallbacks(FIXTURE_CATALOG));
}

/**
 * A manifest body of the REAL catalogue (./catalog.ru.ts) with every move slot and the split set recorded — «the whole
 * library» for twin tests: whatever a builder's twin says must plan at level 1 here. `omit` as in `fixtureIndex`.
 */
export function catalogIndex(opts: { omit?: readonly string[]; msPerChar?: number; lines?: readonly ClipCatalogLine[] } = {}): ClipIndex {
  const omit = new Set(opts.omit ?? []);
  const perChar = opts.msPerChar ?? 70;
  const entries: ClipIndexEntry[] = [];
  const timing = (text: string): { ms: number; on: number; off: number } => {
    const audible = [...text].length * perChar;
    return { ms: audible + 100, on: 30, off: audible + 30 };
  };
  const lines = opts.lines ?? CLIP_CATALOG;
  for (const line of lines) {
    for (const u of catalogUnits(line)) {
      if (u.text === null || omit.has(u.unitKey)) continue;
      const pools = u.pools.filter((p) => !omit.has(p));
      if (pools.length === 0) continue;
      entries.push({ id: clipId(CLIP_VOICE_KEY, `${u.unitKey}\n${u.text}`), key: u.unitKey, text: u.text, take: 1, pools, ...timing(u.text), ...(u.mood ? { mood: u.mood } : {}), ...(line.role === 'bark' ? { interj: true } : {}) });
    }
  }
  for (const key of [...allMoveSlotKeys(), ...allSplitSlotKeys()]) {
    const unit = slotUnitKey(key);
    if (omit.has(unit) || omit.has(key)) continue;
    const text = canonicalSlotText(key);
    entries.push({ id: clipId(CLIP_VOICE_KEY, `${unit}\n${text}`), key: unit, text, take: 1, ...timing(text) });
  }
  return buildClipIndex(entries, catalogFallbacks(lines));
}
