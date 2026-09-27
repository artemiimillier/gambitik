/**
 * The clip planner of the «Записи» voice (docs/voice-clips/SPEC.md §3.1, §5.3, §6, §7): a builder's `ClipUtterance`
 * (or the compiled text of an unported family) + the library's manifest → the exact clips to play, their gaps and
 * what will be heard. Pure and fast (≤ 2 ms): no audio, no network, no storage — the web layer schedules the result.
 *
 * Grammar (§3.1): a sentence is W, H·S, S·T or H·S·T — ≤ 1 slot and ≤ 3 clips; seams only at `—`, `:`, sentence ends.
 * The ladder (§6.1), per sentence, nothing ever generated and no voice mixed inside a sentence:
 *   L1 any recorded wording / take of the pool (least recently heard first)
 *   L2 a missing whole move unit → the split form «конём» · «— на эф шесть»
 *   L3 a missing line → its catalogue sibling (piece variant → plain line → `fallback`); a missing tail is dropped;
 *      a compiled sentence is trimmed after its slot — never before it, never a slot without its piece fragment
 *   L4 an optional sentence (prio < 100) that still misses → dropped
 *   L5 a core sentence that still misses (or names a move the SAN guard refuses) → the moment's generic line
 *   L6 no library / no generic line → nothing is voiced (silent timing + bubble)
 * Then the caps (§3.5): over the sentence / time budget the bark goes first, then sentences with prio < 100, then tails.
 *
 * «Дозапись голоса»: a W sentence whose wording the bubble shows is known (`PlanContext.wordings`) plays that wording's
 * own take first, so the voice says the bubble's words; the plan lists the whole sentences that have no recording at
 * all (`lineMissing`, see `lineMissingOf`) for the web to request.
 */
import type { ClipGenLine, ClipItem, ClipSentence, ClipUtterance, CoachEventKind, PieceType } from '@gambit/shared';
import { capitalize } from '../phrase.ts';
import { CLIP_ID_RE, canonicalSlotText, fragUnitKey, normalizeSan, poolKeyOf, slotKeyOf, slotUnitKey, splitOf, verifyMove } from './keys.ts';
import { cheapestLineWording, lineRequestOf, lineUnitKeyOf, lineWordingOf, lineWordingText, recordableLineWordings, takesForLine } from './lines.ts';
import type {
  ClipCaps,
  ClipIndex,
  ClipInput,
  ClipLevel,
  ClipMiss,
  ClipPlan,
  ClipRecency,
  CompiledSentence,
  CompiledText,
  FragEnd,
  PlanContext,
  PlannedClip,
  PlannedRole,
  PlannedSentence,
} from './types.ts';

// ───────────────────────── constants (SPEC §3.5, §5.3, §7) ─────────────────────────

/** Silence at each boundary, measured in whole takes of this voice (docs/voice-clips/SPEC.md §5.3). */
export const CLIP_GAPS_MS = { sentence: 450, question: 500, dash: 280, colon: 240, semicolon: 260, split: 250, bark: 200 } as const;
export const CLIP_GAP_JITTER_MS = 30;
export const CLIP_BLITZ_GAP_FACTOR = 0.75;
/** A bark goes before ≈ 35 % of priority-1 utterances. */
export const CLIP_BARK_P = 0.35;
export const CLIP_MAX_SENTENCES = 2;
export const CLIP_MAX_CLIPS_PER_SENTENCE = 3;
/** No identical take within this many plays of its pool; greeting / game start / game end remember longer. */
export const CLIP_RECENCY_WINDOW = 10;
export const CLIP_RECENCY_WINDOW_LONG = 20;
/** Remembered takes (≈ 16 bytes each as JSON: 240 ≈ 3.8 KB, within the 4 KB of `gambit.clipRecency`). */
export const CLIP_RECENCY_CAPACITY = 240;
/** Word budgets for clip twins (the planner caps time; words are the builders' job). */
export const CLIP_TEACH_MAX_WORDS = 18;
export const CLIP_SHORT_MAX_WORDS = 10;
export const CLIP_CAPS: Readonly<Record<'teacher' | 'short' | 'other', ClipCaps>> = {
  teacher: { maxSentences: 2, maxMs: 12_000 },
  short: { maxSentences: 1, maxMs: 7_000 },
  other: { maxSentences: 2, maxMs: 9_000 },
};

const TEACHER_KINDS: ReadonlySet<CoachEventKind> = new Set(['teachTurn', 'teachReaction']);

/** Teacher ≤ 2 sentences / 12 s; short style and 5-minute games ≤ 1 sentence / 7 s; other events ≤ 9 s. */
export function clipCapsFor(o: { kind: CoachEventKind; style?: 'full' | 'short' | 'concept'; blitz?: boolean }): ClipCaps {
  if (!TEACHER_KINDS.has(o.kind)) return CLIP_CAPS.other;
  return o.style === 'short' || o.blitz ? CLIP_CAPS.short : CLIP_CAPS.teacher;
}

const LONG_MEMORY_RE = /^(?:generic\.)?(?:greeting|gameStart|gameEnd)(?:[.@/#]|$)/;

/** 20 plays for greeting / game start / game end pools (heard once a game: they must not repeat across games), else 10. */
export function defaultRecencyWindow(pool: string): number {
  return LONG_MEMORY_RE.test(pool) ? CLIP_RECENCY_WINDOW_LONG : CLIP_RECENCY_WINDOW;
}

/** «Ого!», «Ой-ой!», «Хм…» … — a line that already starts with one gets no bark in front. */
const INTERJECTION_RE = /^[\s«"]*(?:ого|ого-го|ух|ух ты|ой|ой-ой|хм|так-так|и-го-го|ура|упс|ах|эх|вау|ай|ну|о)(?![а-яё])/iu;

// ───────────────────────── grammar ─────────────────────────

export type ClipSentenceShape = 'W' | 'HS' | 'ST' | 'HST';

function isSlotItem(i: ClipItem): i is Extract<ClipItem, { slot: unknown }> {
  return 'slot' in i;
}

/** The §3.1 shape of a sentence's items, or null when the planner may not build it. */
export function clipSentenceShape(items: readonly ClipItem[]): ClipSentenceShape | null {
  if (items.length === 0 || items.length > CLIP_MAX_CLIPS_PER_SENTENCE) return null;
  const slots = items.map((it, i) => (isSlotItem(it) ? i : -1)).filter((i) => i >= 0);
  if (slots.length === 0) return items.length === 1 ? 'W' : null;
  if (slots.length > 1) return null;
  const at = slots[0] as number;
  if (items.length === 2) return at === 1 ? 'HS' : 'ST';
  if (items.length === 3) return at === 1 ? 'HST' : null;
  return null;
}

/** What is wrong with a clip twin's utterance ([] = fine): sentence count, shapes, SAN verifiable, generic set. */
export function validateClipUtterance(u: ClipUtterance): string[] {
  const errors: string[] = [];
  if (u.sentences.length === 0) errors.push('no sentences');
  if (u.sentences.length > CLIP_MAX_SENTENCES) errors.push(`${u.sentences.length} sentences > ${CLIP_MAX_SENTENCES}`);
  if (!u.generic) errors.push('no generic line');
  u.sentences.forEach((s, i) => {
    if (!clipSentenceShape(s.items)) errors.push(`sentence ${i}: not W / H·S / S·T / H·S·T`);
    for (const it of s.items) if (isSlotItem(it) && !slotKeyOf(it.san, it.fen, it.slot)) errors.push(`sentence ${i}: slot ${it.slot} ${it.san} is not a legal move in that form`);
  });
  return errors;
}

// ───────────────────────── recency (§7.3) ─────────────────────────

/**
 * An in-memory record of recently heard takes. The web layer persists `snapshot()` in `localStorage`
 * (`gambit.clipRecency`, try/catch, may come back empty) and calls `note(plan ids)` when a plan is really heard.
 */
export function createClipRecency(opts: { capacity?: number; init?: readonly string[] } = {}): ClipRecency {
  const capacity = Math.max(1, Math.floor(opts.capacity ?? CLIP_RECENCY_CAPACITY));
  const seq = new Map<string, number>();
  let counter = 0;
  const note = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (typeof id !== 'string' || !CLIP_ID_RE.test(id)) continue;
      seq.delete(id);
      seq.set(id, ++counter);
    }
    while (seq.size > capacity) seq.delete(seq.keys().next().value as string);
  };
  const recency: ClipRecency = {
    lastPlayed: (id) => seq.get(id),
    note,
    snapshot: () => [...seq.keys()],
    restore: (ids) => {
      seq.clear();
      counter = 0;
      note(Array.isArray(ids) ? ids : []);
    },
  };
  if (opts.init) recency.restore(opts.init);
  return recency;
}

// ───────────────────────── take choice (shared with the lesson planner) ─────────────────────────

/** The planner's random source, clamped to [0, 1) (a broken injected rng rolls 0). */
export function planRoll(rng: () => number = Math.random): () => number {
  return () => {
    const r = rng();
    return Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999) : 0;
  };
}

/** One plan's take choice (`createTakePicker`). */
export interface TakePicker {
  /** a take of these ids (a pool's or a unit key's), or null when none exists / is available */
  pick(ids: readonly string[] | undefined, pool: string): string | null;
  /** gives a picked take back (a split move whose second half is missing) */
  release(id: string): void;
}

/**
 * The take choice of one plan (§7.3), shared by `planClips` and `planLessonClips`: a take that exists and is available,
 * never twice in this plan (unless it is the only one), a mood match first, never one heard within the pool's recency
 * window — when every one was, the least recently heard; the rng among the fresh ones.
 */
export function createTakePicker(index: ClipIndex, ctx: Pick<PlanContext, 'recency' | 'recencyWindow' | 'available' | 'mood'>, roll: () => number): TakePicker {
  const available = ctx.available ?? (() => true);
  const windowOf = ctx.recencyWindow ?? defaultRecencyWindow;
  const used = new Set<string>();
  return {
    pick(ids, pool) {
      const all = (ids ?? []).filter((id) => index.units[id] !== undefined && available(id));
      if (all.length === 0) return null;
      let cands = all.filter((id) => !used.has(id));
      if (cands.length === 0) cands = all;
      if (ctx.mood) {
        const moody = cands.filter((id) => {
          const m = index.units[id]?.mood;
          return m === undefined || m === ctx.mood;
        });
        if (moody.length > 0) cands = moody;
      }
      const last = (id: string): number | undefined => ctx.recency?.lastPlayed(id);
      const played = cands.filter((id) => last(id) !== undefined).sort((a, b) => (last(b) as number) - (last(a) as number));
      const rank = new Map(played.map((id, i) => [id, i]));
      const window = windowOf(pool);
      const fresh = cands.filter((id) => !rank.has(id) || (rank.get(id) as number) >= window);
      const chosen = fresh.length > 0 ? (fresh[Math.floor(roll() * fresh.length)] as string) : (played[played.length - 1] as string);
      used.add(chosen);
      return chosen;
    },
    release(id) {
      used.delete(id);
    },
  };
}

// ───────────────────────── the planner ─────────────────────────

interface RClip {
  id: string;
  role: PlannedRole;
  text: string;
  dur: number;
  /** the seam right after this clip when its text does not show it (compiled slots, pre-slot fragments) */
  after?: FragEnd;
  /** after the slot: may be dropped (L3 / caps) */
  tail?: boolean;
}

interface RSentence {
  clips: RClip[];
  prio: number;
  end: '.' | '!' | '?' | '…';
  level: ClipLevel;
  generic?: boolean;
  slot?: 'whole' | 'split';
}

interface Failure {
  fail: true;
  prio: number;
  miss: string;
  mismatch?: boolean;
}

type Resolved = RSentence | Failure;

function isFailure(r: Resolved): r is Failure {
  return 'fail' in r;
}

const POOL_KEY_RE = /^(.*?)(?:@([pnbrqk]))?(?:\/([mf]))?$/;
const variantMemo = new WeakMap<object, { piece: Set<string>; gender: Set<string> }>();

/** Which lines of the index have piece / gender variant pools (a dropped variant then counts as L3). */
function variantsOf(index: ClipIndex): { piece: Set<string>; gender: Set<string> } {
  const hit = variantMemo.get(index.pools);
  if (hit) return hit;
  const v = { piece: new Set<string>(), gender: new Set<string>() };
  for (const key of Object.keys(index.pools)) {
    const m = POOL_KEY_RE.exec(key);
    if (!m) continue;
    if (m[2]) v.piece.add(m[1] as string);
    if (m[3]) v.gender.add(m[1] as string);
  }
  variantMemo.set(index.pools, v);
  return v;
}

function trailingSeam(text: string): FragEnd | null {
  const t = text.trim();
  const last = t.charAt(t.length - 1);
  if (last === '—' || last === '–') return '—';
  if (last === ':' || last === ';') return last;
  if (/[.!?…]/u.test(last)) return '.';
  return null;
}

function gapBetween(prev: RClip, next: RClip): number {
  if (prev.role === 'bark') return CLIP_GAPS_MS.bark;
  if (prev.role === 'split' && next.role === 'split') return CLIP_GAPS_MS.split;
  if (/^[\s]*[—–]/u.test(next.text)) return CLIP_GAPS_MS.dash;
  const seam = trailingSeam(prev.text) ?? prev.after ?? '';
  switch (seam) {
    case '—':
      return CLIP_GAPS_MS.dash;
    case ':':
      return CLIP_GAPS_MS.colon;
    case ';':
      return CLIP_GAPS_MS.semicolon;
    case '':
      // a word seam right before a slot («Соперник вывел коня» · «на эф шесть»): the bridge's slot pause
      return CLIP_GAPS_MS.split;
    default:
      return CLIP_GAPS_MS.dash;
  }
}

function sentenceGap(prevHeard: string): number {
  return prevHeard.trim().endsWith('?') ? CLIP_GAPS_MS.question : CLIP_GAPS_MS.sentence;
}

/** The heard text of one sentence: seams spelled out, first letter capitalised, the sentence end ensured. */
function heardOf(clips: readonly RClip[], end: string): string {
  let out = '';
  clips.forEach((c, i) => {
    const text = c.text.trim();
    if (i === 0) {
      out = text;
      return;
    }
    const prev = clips[i - 1] as RClip;
    let sep = ' ';
    if (prev.role === 'split' && c.role === 'split') sep = ' — ';
    else if (prev.after && trailingSeam(prev.text) === null && !/^[—–]/u.test(text)) sep = prev.after === '—' ? ' — ' : `${prev.after} `;
    out += sep + text;
  });
  out = capitalize(out.trim());
  return /[.!?…]$/u.test(out) ? out : `${out}${end}`;
}

/**
 * Plans one utterance. `index` null = the library is not loaded (L6: silent timing + bubble). The result lists
 * exactly the takes to play with their gaps; the caller notes `clips` in its recency when they are really heard.
 */
export function planClips(input: ClipInput | null | undefined, index: ClipIndex | null | undefined, ctx: PlanContext = {}): ClipPlan {
  const misses: ClipMiss[] = [];
  const empty = (level: ClipLevel, src: ClipPlan['src'] = 'none'): ClipPlan => ({
    clips: [],
    sentences: [],
    ms: 0,
    heard: '',
    level,
    src,
    bark: false,
    misses,
    mismatch: false,
    long: false,
    stats: { units: 0, slots: 0, split: 0, generic: 0, dropped: 0 },
    ...(input?.moment ? { moment: input.moment } : {}),
  });
  if (!index) {
    misses.push({ key: 'library', level: 6 });
    return empty(6);
  }
  if (!input) return empty(6);

  const roll = planRoll(ctx.rng);
  const takes = createTakePicker(index, ctx, roll);
  const pickFrom = takes.pick;
  const variants = variantsOf(index);
  const allowed = ctx.allowedSans ? new Set(ctx.allowedSans.map(normalizeSan)) : null;
  let mismatch = false;

  const durOf = (id: string): number => {
    const u = index.units[id];
    if (!u) return 0;
    return Math.max(0, (u.off ?? u.ms) - (u.on ?? 0));
  };
  const textOf = (id: string, fallback: string): string => index.units[id]?.text?.trim() || fallback;

  /** A line through its variants, siblings and (for generic lines) dotted parents. */
  const resolveLine = (item: { line: string; piece?: PieceType; g?: 'm' | 'f' }, role: PlannedRole): { clip: RClip; level: 1 | 3; pool: string } | null => {
    const chain: string[] = [];
    const push = (line: string): void => {
      for (let cur: string | undefined = line, n = 0; cur && n < 6 && !chain.includes(cur); cur = index.fallbacks?.[cur], n++) chain.push(cur);
    };
    push(item.line);
    if (item.line.startsWith('generic.')) {
      const parts = item.line.split('.');
      if (parts.length > 2 && parts[parts.length - 1] === 'think') {
        // a danger or a hidden treasure (pose «think»): no arrow is drawn, so the walk never reaches a parent that
        // names one («Смотри на стрелку — это хороший ход!») — only the kind's own «think» line, then the root
        push(`generic.${parts[1] as string}.think`);
        push('generic');
      } else for (let k = parts.length - 1; k >= 1; k--) push(parts.slice(0, k).join('.'));
    }
    for (let i = 0; i < chain.length; i++) {
      const line = chain[i] as string;
      // the exact variant, then the variants it does not depend on (a plain wording joins every variant pool);
      // dropping a variant the line really has is L3
      const hasP = variants.piece.has(line);
      const hasG = variants.gender.has(line);
      const options: { pool: string; dropped: boolean }[] = [{ pool: poolKeyOf(line, item.piece, item.g), dropped: false }];
      if (item.piece && item.g) options.push({ pool: poolKeyOf(line, item.piece), dropped: hasG });
      if (item.piece) options.push({ pool: poolKeyOf(line, undefined, item.g), dropped: hasP });
      if (item.piece || item.g) options.push({ pool: poolKeyOf(line), dropped: (!!item.piece && hasP) || (!!item.g && hasG) });
      for (const o of options) {
        const id = pickFrom(index.pools[o.pool], o.pool);
        if (id) return { clip: { id, role, text: textOf(id, ''), dur: durOf(id) }, level: i === 0 && !o.dropped ? 1 : 3, pool: o.pool };
      }
    }
    return null;
  };

  /** Is this move one the event may name (§6.2)? */
  const sanAllowed = (san: string, fen: string): boolean => {
    if (!allowed) return true;
    if (allowed.has(normalizeSan(san))) return true;
    const m = verifyMove(san, fen);
    if (!m || !ctx.allowedSans) return false;
    return ctx.allowedSans.some((a) => {
      const o = verifyMove(a, fen);
      return !!o && o.from === m.from && o.to === m.to && o.promotion === m.promotion;
    });
  };

  /** A whole move unit, else its split form (L2). */
  const resolveMoveKey = (key: Parameters<typeof splitOf>[0], textFallback: string): { clips: RClip[]; level: 1 | 2 } | null => {
    const unit = slotUnitKey(key);
    const whole = pickFrom(index.keys[unit], unit);
    if (whole) return { clips: [{ id: whole, role: 'slot', text: textOf(whole, textFallback), dur: durOf(whole) }], level: 1 };
    const split = splitOf(key);
    if (!split) return null;
    const [headKey, sqKey] = split;
    const head = pickFrom(index.keys[slotUnitKey(headKey)], slotUnitKey(headKey));
    const sq = head ? pickFrom(index.keys[slotUnitKey(sqKey)], slotUnitKey(sqKey)) : null;
    if (!head || !sq) {
      if (head) takes.release(head);
      return null;
    }
    misses.push({ key: unit, level: 2 });
    return {
      clips: [
        { id: head, role: 'split', text: textOf(head, canonicalSlotText(headKey)), dur: durOf(head) },
        { id: sq, role: 'split', text: textOf(sq, canonicalSlotText(sqKey)), dur: durOf(sq) },
      ],
      level: 2,
    };
  };

  /** The take of wording `n` of a W line, exactly its words (the bubble's own wording, when known; another line's take of the same words too). */
  const resolveWording = (item: { line: string; piece?: PieceType; g?: 'm' | 'f' }, n: number): RClip | null => {
    const l = lineWordingOf(item, n);
    const text = l ? lineWordingText(l) : null;
    if (!l || text === null) return null;
    const id = pickFrom(takesForLine(index, lineUnitKeyOf(l), text), poolKeyOf(l.id, l.piece, l.g));
    return id ? { id, role: 'whole', text: textOf(id, text), dur: durOf(id) } : null;
  };

  // ── route 1: a clip twin's sentence ──
  const resolveTwin = (s: ClipSentence, si: number): Resolved => {
    const shape = clipSentenceShape(s.items);
    if (!shape) return { fail: true, prio: s.prio, miss: 'shape' };
    const clips: RClip[] = [];
    let level: ClipLevel = 1;
    let slotKind: RSentence['slot'];
    let cut = false;
    const slotAt = s.items.findIndex(isSlotItem);
    for (let i = 0; i < s.items.length; i++) {
      const it = s.items[i] as ClipItem;
      if (isSlotItem(it)) {
        if (!sanAllowed(it.san, it.fen)) return { fail: true, prio: s.prio, miss: `san:${it.slot}`, mismatch: true };
        const key = slotKeyOf(it.san, it.fen, it.slot);
        if (!key) return { fail: true, prio: s.prio, miss: `san:${it.slot}`, mismatch: true };
        const r = resolveMoveKey(key, canonicalSlotText(key));
        if (!r) return { fail: true, prio: s.prio, miss: slotUnitKey(key) };
        clips.push(...r.clips);
        slotKind = r.level === 2 ? 'split' : 'whole';
        if (r.level > level) level = r.level;
        continue;
      }
      const isTail = slotAt >= 0 && i > slotAt;
      const role: PlannedRole = shape === 'W' ? 'whole' : isTail ? 'tail' : 'head';
      const n = shape === 'W' ? ctx.wordings?.[si] : undefined;
      const exact = typeof n === 'number' ? resolveWording(it, n) : null;
      if (exact) {
        clips.push(exact);
        continue;
      }
      const r = resolveLine(it, role);
      if (!r) {
        const missKey = `line:${poolKeyOf(it.line, it.piece, it.g)}`;
        if (isTail) {
          // L3: a tail without a recording is dropped — the move is still said
          misses.push({ key: missKey, level: 3 });
          if (level < 3) level = 3;
          cut = true;
          continue;
        }
        return { fail: true, prio: s.prio, miss: missKey };
      }
      if (r.level === 3) {
        misses.push({ key: `line:${poolKeyOf(it.line, it.piece, it.g)}`, level: 3 });
        if (level < 3) level = 3;
      }
      clips.push({ ...r.clip, ...(isTail ? { tail: true } : {}) });
    }
    // ≤ 3 clips: a split move with a head and a tail loses the tail (L3)
    while (clips.length > CLIP_MAX_CLIPS_PER_SENTENCE && clips[clips.length - 1]?.tail) {
      clips.pop();
      if (level < 3) level = 3;
      cut = true;
    }
    if (clips.length > CLIP_MAX_CLIPS_PER_SENTENCE) return { fail: true, prio: s.prio, miss: 'shape' };
    // (without its tail the sentence ends on the slot, recorded with a plain final fall)
    return { clips, prio: s.prio, end: cut ? '.' : s.end, level, ...(slotKind ? { slot: slotKind } : {}) };
  };

  // ── route 2: a compiled sentence (the bridge) ──
  const resolveCompiled = (s: CompiledSentence, prio: number): Resolved => {
    if (s.bad) return { fail: true, prio, miss: `text:${s.bad}`, ...(s.bad === 'mismatch' ? { mismatch: true } : {}) };
    const clips: RClip[] = [];
    let level: ClipLevel = 1;
    let slotKind: RSentence['slot'];
    let slotEnd = -1; // clips.length right after the slot
    let cut = false;
    for (let i = 0; i < s.units.length; i++) {
      const u = s.units[i] as CompiledSentence['units'][number];
      const afterSlot = s.slotAt >= 0 && i > s.slotAt;
      if (u.kind === 'frag') {
        const key = fragUnitKey(u.key);
        const id = pickFrom(index.keys[key], key);
        if (!id) {
          if (afterSlot) {
            // L3b: trim after the slot; everything before it is voiced as written
            misses.push({ key, level: 3 });
            if (level < 3) level = 3;
            cut = true;
            break;
          }
          // never drop a fragment before the slot, never voice a slot without the fragment that carries its piece
          return { fail: true, prio, miss: key };
        }
        clips.push({ id, role: 'frag', text: textOf(id, u.text), dur: durOf(id), after: u.end, ...(afterSlot ? { tail: true } : {}) });
        continue;
      }
      if (u.kind === 'move') {
        const r = resolveMoveKey(u.key, u.text);
        if (!r) return { fail: true, prio, miss: slotUnitKey(u.key) };
        r.clips[r.clips.length - 1] = { ...(r.clips[r.clips.length - 1] as RClip), after: u.end };
        clips.push(...r.clips);
        slotKind = r.level === 2 ? 'split' : 'whole';
        if (r.level > level) level = r.level;
      } else {
        const key = slotUnitKey(u.key);
        const id = pickFrom(index.keys[key], key);
        if (!id) return { fail: true, prio, miss: key };
        clips.push({ id, role: 'slot', text: textOf(id, u.text), dur: durOf(id), after: u.end });
        slotKind = 'whole';
      }
      slotEnd = clips.length;
    }
    if (clips.length > CLIP_MAX_CLIPS_PER_SENTENCE) {
      if (slotEnd < 0 || slotEnd > CLIP_MAX_CLIPS_PER_SENTENCE) return { fail: true, prio, miss: 'shape' };
      clips.length = slotEnd;
      if (level < 3) level = 3;
      cut = true;
    }
    if (clips.length === 0) return { fail: true, prio, miss: 'text:empty' };
    return { clips, prio, end: cut ? '.' : s.end, level, ...(slotKind ? { slot: slotKind } : {}) };
  };

  const isText = (x: ClipInput): x is CompiledText => 'src' in x && x.src === 'text';
  // (a compiled text has no priorities: its core is the sentence that names an advised move, else the first one)
  const textCore = (t: CompiledText): number => Math.max(0, t.sentences.findIndex((s) => s.units.some((u) => u.kind !== 'frag' && u.san !== undefined)));
  let resolved: Resolved[];
  if (isText(input)) {
    const core = textCore(input);
    resolved = input.sentences.map((s, i) => resolveCompiled(s, i === core ? 100 : 50));
  } else resolved = input.sentences.map((s, si) => resolveTwin(s, si));
  const src: ClipPlan['src'] = isText(input) ? 'text' : 'clip';

  // ── L4 / L5 / L6 ──
  const sentences: RSentence[] = [];
  let dropped = 0;
  let worst: ClipLevel = 1;
  let genericDone = false;
  const bump = (l: ClipLevel): void => {
    if (l > worst) worst = l;
  };
  const addGeneric = (): void => {
    if (genericDone) return;
    genericDone = true;
    const g = resolveLine({ line: input.generic }, 'generic');
    if (!g) {
      misses.push({ key: `line:${input.generic}`, level: 6 });
      bump(6);
      return;
    }
    if (g.level === 3) misses.push({ key: `line:${input.generic}`, level: 3 });
    sentences.push({ clips: [g.clip], prio: 100, end: '.', level: 5, generic: true });
    bump(5);
  };
  for (const r of resolved) {
    if (isFailure(r)) {
      // (a move the SAN guard refuses is never voiced: an optional sentence is dropped, a core one becomes the generic)
      if (r.mismatch) mismatch = true;
      if (r.prio < 100) {
        misses.push({ key: r.miss, level: 4 });
        dropped++;
        bump(4);
      } else {
        misses.push({ key: r.miss, level: 5 });
        addGeneric();
      }
      continue;
    }
    sentences.push(r);
    bump(r.level);
  }
  if (sentences.length === 0 && !genericDone) addGeneric();

  // ── bark (§7.5): ≈ 35 % of priority-1 utterances, never twice in a row, never before an interjection, never in blitz ──
  let bark: RClip | null = null;
  const first = sentences[0]?.clips[0];
  const firstInterj = !!first && (index.units[first.id]?.interj === true || INTERJECTION_RE.test(first.text));
  if (input.bark && first && !ctx.blitz && (ctx.priority ?? 1) === 1 && !ctx.prevBark && !firstInterj && roll() < CLIP_BARK_P) {
    const pool = `bark.${input.bark}`;
    const id = pickFrom(index.pools[pool], pool);
    if (id) bark = { id, role: 'bark', text: textOf(id, ''), dur: durOf(id) };
  }

  // ── caps (§3.5): the bark, then prio < 100 sentences, then tails ──
  const caps = ctx.caps ?? CLIP_CAPS.teacher;
  const factor = ctx.blitz ? CLIP_BLITZ_GAP_FACTOR : 1;
  const baseMs = (): number => {
    let ms = 0;
    let prev: RClip | null = bark;
    if (bark) ms += bark.dur;
    sentences.forEach((s, si) => {
      s.clips.forEach((c, ci) => {
        if (prev) ms += (ci === 0 && si > 0 ? sentenceGap(heardOf((sentences[si - 1] as RSentence).clips, (sentences[si - 1] as RSentence).end)) : gapBetween(prev, c)) * factor;
        ms += c.dur;
        prev = c;
      });
    });
    return ms;
  };
  for (let guard = 0; guard < 16; guard++) {
    const overSentences = sentences.length > caps.maxSentences;
    const overMs = baseMs() > caps.maxMs;
    if (!overSentences && !overMs) break;
    if (overMs && bark) {
      bark = null;
      continue;
    }
    let drop = -1;
    sentences.forEach((s, i) => {
      if (s.prio >= 100 || s.generic) return;
      if (drop < 0 || s.prio <= (sentences[drop] as RSentence).prio) drop = i;
    });
    // (a cap is no library miss: nothing goes to the miss log and the level stays)
    if (drop >= 0) {
      sentences.splice(drop, 1);
      dropped++;
      continue;
    }
    if (!overMs) break;
    let cut = false;
    for (let i = sentences.length - 1; i >= 0 && !cut; i--) {
      const s = sentences[i] as RSentence;
      if (s.clips.length > 1 && s.clips[s.clips.length - 1]?.tail) {
        while (s.clips.length > 1 && s.clips[s.clips.length - 1]?.tail) s.clips.pop();
        s.end = '.';
        cut = true;
      }
    }
    if (!cut) break;
  }

  // ── timing ──
  const withJitter = ctx.jitter !== false;
  const gap = (base: number): number => {
    const scaled = base * factor;
    const j = withJitter ? (roll() * 2 - 1) * CLIP_GAP_JITTER_MS : 0;
    return Math.max(0, Math.round(scaled + j));
  };
  const clips: PlannedClip[] = [];
  const planned: PlannedSentence[] = [];
  let t = 0;
  let prevClip: RClip | null = null;
  const place = (c: RClip, baseGap: number, sentence: number): PlannedClip => {
    const g = prevClip ? gap(baseGap) : 0;
    t += g;
    const pc: PlannedClip = { id: c.id, role: c.role, text: c.text, gapBeforeMs: g, atMs: t, ms: c.dur, sentence };
    clips.push(pc);
    t += c.dur;
    prevClip = c;
    return pc;
  };
  if (bark) place(bark, 0, 0);
  sentences.forEach((s, si) => {
    // (a bark belongs to the first sentence: that sentence is heard from 0)
    let fromMs = si === 0 ? 0 : -1;
    s.clips.forEach((c, ci) => {
      const base = !prevClip ? 0 : ci === 0 && si > 0 ? sentenceGap(planned[si - 1]?.text ?? '') : gapBetween(prevClip, c);
      const pc = place(c, base, si);
      if (fromMs < 0) fromMs = pc.atMs;
    });
    planned.push({ level: s.level, text: heardOf(s.clips, s.end), fromMs, toMs: t });
  });
  const heardSentences = planned.map((p) => p.text);
  const heard = [bark ? capitalize(bark.text.trim()) : '', ...heardSentences].filter(Boolean).join(' ');

  const level: ClipLevel = clips.length === 0 ? 6 : worst;
  const genericCount = sentences.filter((s) => s.generic).length;
  const lineMissing = isText(input) ? [] : lineMissingOf(input, index, ctx.wordings, ctx.grow);
  return {
    clips,
    sentences: planned,
    ms: t,
    heard,
    level,
    src: clips.length === 0 ? 'none' : genericCount === sentences.length ? 'generic' : src,
    bark: !!bark,
    misses,
    mismatch,
    long: t > caps.maxMs,
    stats: {
      units: clips.length,
      slots: sentences.filter((s) => s.slot).length,
      split: sentences.filter((s) => s.slot === 'split').length,
      generic: genericCount,
      dropped,
    },
    ...(input.moment ? { moment: input.moment } : {}),
    ...(lineMissing.length > 0 ? { lineMissing } : {}),
  };
}

// ───────────────────────── «Дозапись голоса»: what a twin may ask to have recorded ─────────────────────────

/**
 * The whole catalogue sentences of a twin that have no recording (`ClipPlan.lineMissing`): per W sentence of a line
 * that may be recorded on demand (`lineRequestOf`: role 'whole', no generic stand-in, no preview) —
 *  - its bubble's wording `n` (`wordings`) when no take of exactly those words exists (under a twin's key neither),
 *    even while the pool voiced another wording (the next time the voice says the bubble's words);
 *  - a free-worded answer (`grow`): while its line has fewer than `grow` recorded wordings, its cheapest unrecorded one
 *    (the bubble takes whatever words are heard, so the pool's variety grows, one wording at a time);
 *  - no wording known at all (no `wordings`): only when the line's own pool has no take at all (the sentence fell to a
 *    sibling, L4, L5 or L6), its cheapest wording that is not blocked;
 *  - a bubble sentence that is known to be no wording (a null in `wordings`): nothing — any wording would be words the
 *    bubble does not show.
 * Existence only: a take that exists but failed to load is not missing (asking again would pay for it twice). Heads,
 * tails, barks, slots, the generic line and compiled text are never asked for. Deduplicated by unit key.
 */
function lineMissingOf(input: ClipUtterance, index: ClipIndex, wordings: PlanContext['wordings'], grow: number | undefined): ClipGenLine[] {
  const out: ClipGenLine[] = [];
  const seen = new Set<string>();
  const blocked = 'blocked' in index && index.blocked instanceof Set ? (index.blocked as ReadonlySet<string>) : null;
  const add = (l: ClipGenLine | null): void => {
    if (l === null) return;
    const key = lineUnitKeyOf(l);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };
  input.sentences.forEach((s, si) => {
    const it = s.items.length === 1 ? s.items[0] : undefined;
    if (!it || !('line' in it)) return;
    const n = wordings?.[si];
    // the bubble's words are known to be no wording of this line (a name, other words): whatever the line has, its
    // recording would say words the bubble does not show — nothing is asked for
    if (wordings !== undefined && n === null) return;
    const exact = typeof n === 'number' ? lineRequestOf(it, n) : null;
    if (exact !== null) {
      const text = lineWordingText(exact);
      if (text !== null && takesForLine(index, lineUnitKeyOf(exact), text).length === 0) add(exact);
      return;
    }
    if (grow !== undefined && grow > 0) {
      const recorded = new Set(recordableLineWordings(it).flatMap((w) => (takesForLine(index, w.key, w.text).length > 0 ? [w.key] : [])));
      if (recorded.size >= grow) return;
      const next = cheapestLineWording(it, { skip: (key) => recorded.has(key) || blocked?.has(key) === true });
      add(next === null ? null : lineRequestOf(it, next));
      return;
    }
    const pool = poolKeyOf(it.line, it.piece, it.g);
    const ids = Object.hasOwn(index.pools, pool) ? (index.pools[pool] ?? []) : [];
    if (ids.some((id) => Object.hasOwn(index.units, id))) return;
    const cheapest = cheapestLineWording(it, blocked ? { skip: (key) => blocked.has(key) } : {});
    add(cheapest === null ? null : lineRequestOf(it, cheapest));
  });
  return out;
}
