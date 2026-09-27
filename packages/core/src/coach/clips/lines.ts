/**
 * «Дозапись голоса» for the builders' events (greeting, «Спроси» answers, thought replies, take-back replies, game start …):
 * a whole sentence of the clip catalogue — a W item of a clip twin — as request ids (`ClipGenLine`), and back to its
 * exact words. The same functions run in the browser (which wording the bubble shows, which one is missing), on the
 * server (which words to record: it never accepts text) and in the tools (which words a unit key names, its twins, the
 * words its placeholders produced), so a take recorded on demand is exactly a starter-set take of the same wording:
 * the key `line:<poolKey>#<n>` and the pools of `catalogUnits`.
 *
 * Two namespaces never meet: the lesson pools of @gambit/content all start with `v3.` (they are requested as
 * `parts` / `quiz`), every other line id is the clip catalogue's. `spokenLineOf` reads a key of either.
 *
 * What may be recorded as a `line`: a catalogue line of role 'whole' — never a head, a tail or a bark (they only exist
 * around a move slot or before a line), never a generic stand-in of ladder L5 (it is not what the bubble says), never
 * the settings' voice preview (the parent's demo is not the child's game).
 */
import type { ClipCatalogLine, ClipGenLine, ClipItem, CoachEvent, PieceType } from '@gambit/shared';
import { lessonLine } from '@gambit/content';
import { catalogUnits, expandWording, linePieces, usesGender, usesPiece } from './catalog.ts';
import type { CatalogUnit } from './catalog.ts';
import { CLIP_CATALOG, clipCatalogLine } from './catalog.ru.ts';
import { splitSentences, stripName } from './compile.ts';
import { lineUnitKey, poolKeyOf, takesForUnit } from './keys.ts';
import type { ClipIndex, MergedClipIndex } from './types.ts';
import { ttsPartText } from './tts.ts';

// ───────────────────────── one lookup for both sources ─────────────────────────

/** Every lesson pool id starts with this; no catalogue line does (lines.test.ts keeps them apart). */
export const LESSON_POOL_PREFIX = 'v3.';

export function isLessonPoolId(id: string): boolean {
  return id.startsWith(LESSON_POOL_PREFIX);
}

const ALL_PIECES: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];

/** A spoken line of either source, as a unit key names it. */
export interface SpokenLine {
  id: string;
  source: 'lesson' | 'catalog';
  role: 'whole' | 'lead' | 'tail' | 'head' | 'bark';
  wordings: readonly { t: string; mood?: 'calm' | 'excited' }[];
  /**
   * the pieces a wording with a piece placeholder is recorded for: a catalogue line its `linePieces`; a lesson pool
   * every piece (the book names the subject's piece — the king too where it moves)
   */
  pieces: readonly PieceType[];
  /** a wording with `{g:…}` is recorded for each gender (a lesson pool: always; a catalogue line: when `byGender`) */
  byGender: boolean;
}

/** The line a pool / line id names: `v3.*` from the lesson library, anything else from the clip catalogue. */
export function spokenLineOf(pool: string): SpokenLine | undefined {
  if (isLessonPoolId(pool)) {
    const l = lessonLine(pool);
    return l ? { id: l.id, source: 'lesson', role: l.role, wordings: l.wordings, pieces: ALL_PIECES, byGender: true } : undefined;
  }
  const c = clipCatalogLine(pool);
  return c ? { id: c.id, source: 'catalog', role: c.role, wordings: c.wordings, pieces: linePieces(c), byGender: c.byGender === true } : undefined;
}

const LINE_KEY_RE = /^line:([^@/#]+)(?:@([pnbrqk]))?(?:\/([mf]))?#(\d+)$/;

/** `line:v3.lead.subject@p/f#4` → its pool, piece, gender and wording number; null for any other key. */
export function parseLineUnitKey(key: string): { pool: string; piece?: PieceType; g?: 'm' | 'f'; n: number } | null {
  const m = LINE_KEY_RE.exec(key);
  if (!m) return null;
  return { pool: m[1] as string, ...(m[2] ? { piece: m[2] as PieceType } : {}), ...(m[3] ? { g: m[3] as 'm' | 'f' } : {}), n: Number(m[4]) };
}

function wordingOfKey(key: string): { k: NonNullable<ReturnType<typeof parseLineUnitKey>>; line: SpokenLine; t: string } | null {
  const k = parseLineUnitKey(key);
  const line = k ? spokenLineOf(k.pool) : undefined;
  const w = k && line ? line.wordings[k.n - 1] : undefined;
  return k && line && w ? { k, line, t: w.t } : null;
}

/**
 * The words a line unit key names in today's content (null: not a line key, or its wording is gone). Writers insert
 * lesson wordings (docs/voice-clips/ONDEMAND.md), so a key's number can come to name other words than a take recorded under it.
 */
export function lineKeyText(key: string): string | null {
  const x = wordingOfKey(key);
  if (!x) return null;
  return expandWording(x.t, { ...(x.k.piece ? { piece: x.k.piece } : {}), ...(x.k.g ? { g: x.k.g } : {}) });
}

/** exact words → every whole catalogue sentence (any line) that says them, as unit keys; built once */
let wholeKeysByText: Map<string, string[]> | null = null;

function wholeKeysOfText(text: string): readonly string[] {
  if (wholeKeysByText === null) {
    const map = new Map<string, string[]>();
    for (const line of CLIP_CATALOG) {
      if (line.role !== 'whole') continue;
      for (const u of unitsOf(line)) {
        if (u.text === null) continue;
        const keys = map.get(u.text) ?? [];
        if (!keys.includes(u.unitKey)) keys.push(u.unitKey);
        map.set(u.text, keys);
      }
    }
    wholeKeysByText = map;
  }
  return wholeKeysByText.get(text) ?? [];
}

const twinsMemo = new Map<string, readonly string[]>();

/**
 * Other unit keys a take serves — the same words under another key: the piece / gender variants of the same wording
 * («{он} ушёл» is «он ушёл» for the knight, the bishop and the king), and a whole catalogue sentence of ANOTHER line
 * whose words are exactly these («Привет!» of the day greeting, the opener and the game's hello; «Поторопись!» of the
 * teacher and of the game) — only while the key names these words today. One take is published under all of them
 * (the overlay), the web and the server find it under any of them (`takesForLine`), and the server counts them as one
 * unit, so the same words are never paid for twice. A head, a tail, a bark or a lesson part only joins its own
 * variants: said another way, the same letters are not the same recording.
 */
export function lineKeyTwins(key: string, text: string): string[] {
  const memo = twinsMemo.get(`${key}|${text}`);
  if (memo !== undefined) return [...memo];
  const x = wordingOfKey(key);
  if (!x) return [];
  const pieces: (PieceType | undefined)[] = usesPiece(x.t) && x.line.pieces.length > 0 ? [...x.line.pieces] : [undefined];
  const genders: ('m' | 'f' | undefined)[] = usesGender(x.t) && x.line.byGender ? ['m', 'f'] : [undefined];
  const out: string[] = [];
  for (const piece of pieces) {
    for (const g of genders) {
      const twin = lineUnitKey(poolKeyOf(x.k.pool, piece, g), x.k.n);
      if (twin === key || out.includes(twin)) continue;
      if (expandWording(x.t, { ...(piece ? { piece } : {}), ...(g ? { g } : {}) }) === text) out.push(twin);
    }
  }
  if (x.line.source === 'catalog' && x.line.role === 'whole' && lineKeyText(key) === text) {
    for (const twin of wholeKeysOfText(text)) if (twin !== key && !out.includes(twin)) out.push(twin);
  }
  twinsMemo.set(`${key}|${text}`, out);
  return [...out];
}

/**
 * The takes that say exactly `text` for a line unit — under its own key, else under a twin's (`lineKeyTwins`: the
 * static library publishes a take under its own key only). [] = no recording of these words at all.
 */
export function takesForLine(index: ClipIndex | MergedClipIndex, key: string, text: string): string[] {
  const out = takesForUnit(index, key, text);
  for (const twin of lineKeyTwins(key, text)) for (const id of takesForUnit(index, twin, text)) if (!out.includes(id)) out.push(id);
  return out;
}

/** The words each placeholder of a wording produced for this variant (`{Конём}` → «Конём», `{g:сам|сама}` → «сама»). */
export function placeholderWordsOf(template: string, variant: { piece?: PieceType; g?: 'm' | 'f' }): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{[^{}]+\}/gu)) {
    const word = expandWording(m[0], variant);
    if (word) out.push(...word.split(/\s+/u).filter((x) => x !== ''));
  }
  return out;
}

/** The placeholder words of a line unit key: a recording must be heard to say each of them (the overlay's ASR check). */
export function lineKeyPlaceholderWords(key: string): string[] {
  const x = wordingOfKey(key);
  if (!x) return [];
  return placeholderWordsOf(x.t, { ...(x.k.piece ? { piece: x.k.piece } : {}), ...(x.k.g ? { g: x.k.g } : {}) });
}

// ───────────────────────── a whole catalogue sentence as request ids ─────────────────────────

/** Why a `ClipGenLine` names nothing that may be recorded (the server maps these onto its refusal codes). */
export type LineRequestProblem = 'unknown' | 'lesson' | 'role' | 'bark' | 'excluded' | 'bad-n' | 'variant' | 'piece' | 'text';

/** A generic stand-in (ladder L5) or the parent's voice preview: said by the app, never recorded on demand. */
export function isExcludedLine(id: string): boolean {
  return id === 'generic' || id.startsWith('generic.') || id === 'preview';
}

const unitsMemo = new WeakMap<ClipCatalogLine, CatalogUnit[]>();

function unitsOf(line: ClipCatalogLine): CatalogUnit[] {
  let units = unitsMemo.get(line);
  if (!units) {
    units = catalogUnits(line);
    unitsMemo.set(line, units);
  }
  return units;
}

export type LineResolution = { ok: true; line: ClipCatalogLine; unit: CatalogUnit & { text: string } } | { ok: false; problem: LineRequestProblem };

/**
 * The catalogue unit a `ClipGenLine` names — exactly one of `catalogUnits(line)`, so its key, text and pools are the
 * starter set's. The variant must be the wording's own: a piece only when the wording names one (and the line is recorded
 * for that piece), a gender only when the line is `byGender` and the wording uses `{g:…}`. `recordable` (default)
 * also refuses what is never recorded on demand: a lesson id, a head / tail / bark, a generic stand-in, the preview.
 */
export function resolveClipGenLine(l: ClipGenLine, o: { recordable?: boolean } = {}): LineResolution {
  const recordable = o.recordable !== false;
  if (typeof l.id !== 'string' || l.id === '') return { ok: false, problem: 'unknown' };
  if (isLessonPoolId(l.id)) return { ok: false, problem: 'lesson' };
  const line = clipCatalogLine(l.id);
  if (!line) return { ok: false, problem: 'unknown' };
  if (recordable) {
    if (line.role === 'bark') return { ok: false, problem: 'bark' };
    if (line.role !== 'whole') return { ok: false, problem: 'role' };
    if (isExcludedLine(line.id)) return { ok: false, problem: 'excluded' };
  }
  if (!Number.isInteger(l.n) || l.n < 1 || l.n > line.wordings.length) return { ok: false, problem: 'bad-n' };
  const w = line.wordings[l.n - 1];
  if (!w) return { ok: false, problem: 'bad-n' };
  const pieces = linePieces(line);
  if ((pieces.length > 0 && usesPiece(w.t)) !== (l.piece !== undefined)) return { ok: false, problem: 'variant' };
  if (l.piece !== undefined && !pieces.includes(l.piece)) return { ok: false, problem: 'piece' };
  if ((line.byGender === true && usesGender(w.t)) !== (l.g !== undefined)) return { ok: false, problem: 'variant' };
  const unit = unitsOf(line).find((u) => u.wording === l.n && u.piece === l.piece && u.g === l.g);
  if (!unit) return { ok: false, problem: 'variant' };
  if (unit.text === null) return { ok: false, problem: 'text' };
  return { ok: true, line, unit: unit as CatalogUnit & { text: string } };
}

/** The unit key of a catalogue sentence: `line:<poolKey>#<n>` (the starter set's key for the same wording). */
export function lineUnitKeyOf(l: Pick<ClipGenLine, 'id' | 'n' | 'piece' | 'g'>): string {
  return lineUnitKey(poolKeyOf(l.id, l.piece, l.g), l.n);
}

/** The exact words of wording `n` for its variant (any role); null when the id, `n` or the variant does not fit. */
export function lineWordingText(l: ClipGenLine): string | null {
  const r = resolveClipGenLine(l, { recordable: false });
  return r.ok ? r.unit.text : null;
}

/**
 * A twin's item said with wording `n`, normalised to that wording's variant (the item's piece / gender kept only when
 * the wording uses it); null when the wording needs a variant the item does not carry, or the id / `n` is unknown.
 * Any role (the planner plays a W sentence by its exact wording with it).
 */
export function lineWordingOf(item: { line: string; piece?: PieceType; g?: 'm' | 'f' }, n: number): ClipGenLine | null {
  const line = isLessonPoolId(item.line) ? undefined : clipCatalogLine(item.line);
  const w = line && Number.isInteger(n) && n >= 1 ? line.wordings[n - 1] : undefined;
  if (!line || !w) return null;
  const needP = linePieces(line).length > 0 && usesPiece(w.t);
  const needG = line.byGender === true && usesGender(w.t);
  if ((needP && item.piece === undefined) || (needG && item.g === undefined)) return null;
  const l: ClipGenLine = { id: line.id, n, ...(needP ? { piece: item.piece as PieceType } : {}), ...(needG ? { g: item.g as 'm' | 'f' } : {}) };
  return resolveClipGenLine(l, { recordable: false }).ok ? l : null;
}

/** `lineWordingOf`, and only for a sentence that may be recorded on demand (see `resolveClipGenLine`). */
export function lineRequestOf(item: { line: string; piece?: PieceType; g?: 'm' | 'f' }, n: number): ClipGenLine | null {
  const l = lineWordingOf(item, n);
  return l !== null && resolveClipGenLine(l).ok ? l : null;
}

/** Every wording of an item that may be recorded on demand (`lineRequestOf`), with its unit key and exact words. */
export function recordableLineWordings(item: { line: string; piece?: PieceType; g?: 'm' | 'f' }): { n: number; key: string; text: string }[] {
  const line = isLessonPoolId(item.line) ? undefined : clipCatalogLine(item.line);
  const out: { n: number; key: string; text: string }[] = [];
  for (let n = 1; n <= (line?.wordings.length ?? 0); n++) {
    const req = lineRequestOf(item, n);
    const text = req ? lineWordingText(req) : null;
    if (req && text !== null) out.push({ n, key: lineUnitKeyOf(req), text });
  }
  return out;
}

const PRICE_BLOCK_CHARS = 50;

/**
 * The wording of an item to record when the bubble's own wording is not known: the most reusable and cheapest one —
 * without placeholders first (it joins every piece / gender pool), then the fewest 50-character price blocks, then
 * the lowest `n`. `skip` leaves out unit keys that will never be recorded (the overlay's `blocked[]`). null when the
 * line may not be recorded on demand or nothing fits.
 */
export function cheapestLineWording(item: { line: string; piece?: PieceType; g?: 'm' | 'f' }, o: { skip?: (unitKey: string) => boolean } = {}): number | null {
  const line = isLessonPoolId(item.line) ? undefined : clipCatalogLine(item.line);
  if (!line) return null;
  let best: { n: number; placeholders: number; blocks: number } | null = null;
  line.wordings.forEach((w, i) => {
    const req = lineRequestOf(item, i + 1);
    const text = req ? lineWordingText(req) : null;
    if (!req || text === null || o.skip?.(lineUnitKeyOf(req)) === true) return;
    const placeholders = usesPiece(w.t) || usesGender(w.t) ? 1 : 0;
    const blocks = Math.ceil([...ttsPartText(text, 'whole')].length / PRICE_BLOCK_CHARS);
    if (best === null || placeholders < best.placeholders || (placeholders === best.placeholders && blocks < best.blocks)) best = { n: i + 1, placeholders, blocks };
  });
  return (best as { n: number } | null)?.n ?? null;
}

// ───────────────────────── which wording the bubble shows ─────────────────────────

/** Text as the match compares it: NFC, «...» as «…», spaces collapsed. */
function norm(text: string): string {
  return text.normalize('NFC').replace(/\.\.\./g, '…').replace(/\s+/g, ' ').trim();
}

/** Every wording a W sentence may say for its item's variant, with its words (normalised). */
function candidatesOf(items: readonly ClipItem[]): { n: number; t: string }[] {
  if (items.length !== 1) return [];
  const it = items[0] as ClipItem;
  if (!('line' in it)) return [];
  const line = clipCatalogLine(it.line);
  if (!line) return [];
  const out: { n: number; t: string }[] = [];
  for (let n = 1; n <= line.wordings.length; n++) {
    const l = lineWordingOf(it, n);
    const t = l ? lineWordingText(l) : null;
    if (t !== null) out.push({ n, t: norm(t) });
  }
  return out;
}

/**
 * The wording of every sentence of `event.clip` when the whole bubble (the child's name stripped) is exactly those
 * wordings joined, in order — the recordings can say it whole —, else null (a sentence says what no wording does: the
 * opponent's name, the practice idea, other words). The lowest numbers win a tie.
 */
export function twinWholeWordings(event: Pick<CoachEvent, 'text' | 'clip'>, o: { name?: string } = {}): number[] | null {
  const sentences = event.clip?.sentences ?? [];
  if (sentences.length === 0) return null;
  const text = norm(stripName(event.text, o.name));
  const cands = sentences.map((s) => candidatesOf(s.items));
  const whole = (i: number, prefix: string, picked: number[]): number[] | null => {
    if (i === cands.length) return prefix === text ? picked : null;
    for (const c of cands[i] as { n: number; t: string }[]) {
      const next = prefix === '' ? c.t : `${prefix} ${c.t}`;
      if (!text.startsWith(next)) continue;
      const found = whole(i + 1, next, [...picked, c.n]);
      if (found) return found;
    }
    return null;
  };
  return whole(0, '', []);
}

/**
 * Per sentence of `event.clip`, the wording number whose words are exactly the bubble's (the child's name stripped),
 * or null: a sentence that is no W line, or whose words no wording has (the builder said more, or other words). First
 * the whole text as one combination, then each sentence against a run of the bubble's sentences, in order. [] without
 * a twin. The planner plays that wording first (`PlanContext.wordings`) and asks for it when it has no recording.
 */
export function twinWordingsOf(event: Pick<CoachEvent, 'text' | 'clip'>, o: { name?: string } = {}): (number | null)[] {
  const sentences = event.clip?.sentences ?? [];
  if (sentences.length === 0) return [];
  const all = twinWholeWordings(event, o);
  if (all) return all;
  const text = norm(stripName(event.text, o.name));
  const cands = sentences.map((s) => candidatesOf(s.items));
  // 2. each sentence against a run of the bubble's sentences, in order: as many sentences matched as possible, then as
  //    much of the bubble covered (a wording that says more of it wins), then the earliest runs
  const parts = splitSentences(text).map(norm);
  const matchRun = (i: number, from: number, to: number): number | null => {
    const run = parts.slice(from, to).join(' ');
    return (cands[i] as { n: number; t: string }[]).find((c) => c.t === run)?.n ?? null;
  };
  let best: (number | null)[] = sentences.map(() => null);
  let bestScore = [0, 0];
  const walk = (i: number, from: number, acc: (number | null)[], covered: number): void => {
    if (i === sentences.length) {
      const count = acc.filter((x) => x !== null).length;
      if (count > (bestScore[0] as number) || (count === bestScore[0] && covered > (bestScore[1] as number))) {
        best = acc;
        bestScore = [count, covered];
      }
      return;
    }
    // this sentence matched to a run that starts at or after `from` …
    for (let a = from; a < parts.length; a++) {
      for (let b = a + 1; b <= parts.length; b++) {
        const n = matchRun(i, a, b);
        if (n !== null) walk(i + 1, b, [...acc, n], covered + (b - a));
      }
    }
    // … or unmatched
    walk(i + 1, from, [...acc, null], covered);
  };
  walk(0, 0, [], 0);
  return best;
}
