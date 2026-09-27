/**
 * Types of the «Записи» voice mode (docs/voice-clips/SPEC.md §3.3, §4.2, §6): pre-recorded Giselle clips instead of
 * live speech. The utterance types a builder emits live in @gambit/shared (CoachEvent.clip); this file adds what only
 * core, the web layer and the tools share: slot keys, the manifest, the planner's input and output.
 *
 * Pure types — no runtime code, no DOM, no Node.
 */
import type { ClipGenLine, ClipLineId, ClipUtterance, MascotPose, PieceType, Square } from '@gambit/shared';

export type { ClipCatalogLine, ClipItem, ClipLineId, ClipSentence, ClipUtterance, ClipWording } from '@gambit/shared';

/** A catalogue line id (alias of the shared `ClipLineId`, as SPEC §3.3 names it). */
export type LineId = ClipLineId;

// ───────────────────────── slot keys (SPEC §3.2) ─────────────────────────

/** How a move is said: 'nom' «конь на эф шесть», 'cap' «конь бьёт на дэ пять», 'ins' «конём на эф шесть». */
export type SlotForm = 'nom' | 'cap' | 'ins';

/**
 * A whole move unit: `ins:n:f6`, `nom:p:e4`, `cap:q:h7`; castling `nom:castle:short` («короткая рокировка»),
 * `ins:castle:long` («длинной рокировкой»). Disambiguation, promotion and check are never part of the key: the arrow
 * shows which piece moves, promotion / check / mate are tails of their own.
 */
export type MoveSlotKey = `${SlotForm}:${PieceType}:${Square}` | `${'nom' | 'ins'}:castle:${'short' | 'long'}`;

/**
 * The split set (ships in every tier, ladder L2): `sq:f6` «на эф шесть», `xsq:d5` «бьёт на дэ пять»,
 * `head:ins:n` «конём», `head:nom:n` «конь».
 */
export type SplitSlotKey = `sq:${Square}` | `xsq:${Square}` | `head:${'nom' | 'ins'}:${PieceType}`;

export type SlotKey = MoveSlotKey | SplitSlotKey;

export type ParsedSlotKey =
  | { kind: 'move'; form: SlotForm; piece: PieceType; square: Square }
  | { kind: 'castle'; form: 'nom' | 'ins'; side: 'short' | 'long' }
  | { kind: 'square'; capture: boolean; square: Square }
  | { kind: 'head'; form: 'nom' | 'ins'; piece: PieceType };

// ───────────────────────── the manifest (SPEC §4.2) ─────────────────────────

/** One recorded take. `on` / `off` = the audible onset / offset inside the file (ms), `ms` = the file's length. */
export interface ClipUnitMeta {
  /** the unit key this take was recorded for: `line:<pool>#<n>`, `slot:<slotKey>`, `frag:f:<norm>|<end>` */
  key?: string;
  /** what is heard (journal, bubble, QA); for a slot the canonical spoken text */
  text: string;
  take?: number;
  ms: number;
  on?: number;
  off?: number;
  file?: string;
  mood?: string;
  qa?: string;
  sylps?: number;
  tier?: string;
  /** an interjection («Ого!», «Ой-ой!»): never gets a bark in front of it */
  interj?: boolean;
  /**
   * «Дозапись голоса»: a lead take whose end did not fall (F0 > 210 Hz) — it may only be played right before its tail,
   * never as a lead said alone. Absent = usable anywhere its key is.
   */
  ctx?: 'cont';
}

export interface ClipManifest {
  v: 1;
  voiceKey: string;
  libraryVersion: number;
  voice?: { provider: string; model: string; variant: string; voiceType: string; voiceId: string };
  codec?: { c: string; kbps: number; hz: number; ch: number };
  loudness?: { lufs: number; truePeak: number };
  units: Record<string, ClipUnitMeta>;
  /** pool key (`poolKeyOf`) → every recorded wording and take of that line variant */
  pools: Record<string, string[]>;
  /** unit key → its takes: `slot:ins:n:f6`, `frag:f:смотри, тут подарок|!`, `line:teach.head.advice#1` */
  keys: Record<string, string[]>;
  /** the catalogue's L3 siblings (`fallback`), copied into the manifest by the tools */
  fallbacks?: Record<ClipLineId, ClipLineId>;
  /**
   * «Дозапись голоса» (the overlay only): unit keys that will not be recorded — their paid attempts are used up or the
   * take was rejected. The book does not grow a pool with them; the server never requests them again.
   */
  blocked?: string[];
}

/** What the planner reads: any manifest (or a merged manifest + overlay) — only these four fields. */
export type ClipIndex = Pick<ClipManifest, 'units' | 'pools' | 'keys' | 'fallbacks'>;

/**
 * «Дозапись голоса»: the static library merged with the recorded overlay (`mergeClipIndexes`). Every reload builds NEW
 * objects (the planner caches by object identity), so it is never mutated after it is built.
 */
export interface MergedClipIndex extends ClipIndex {
  fallbacks: Record<ClipLineId, ClipLineId>;
  /**
   * `unitTextKey(unitKey, text)` → take ids: a `line:` take found by its pool variant and exact text when its wording
   * number has shifted (writers inserted a wording), so audio that exists is never paid for again.
   */
  textIndex: Record<string, string[]>;
  /** unit keys that will not be recorded (the overlay's `blocked[]`) */
  blocked: ReadonlySet<string>;
}

// ───────────────────────── the text compiler (bridge, SPEC §3.4 route 2) ─────────────────────────

/** The right edge of a compiled fragment: a seam (`—` `:` `;`), a sentence end, or '' right before a square slot. */
export type FragEnd = '—' | ':' | ';' | '.' | '!' | '?' | '…' | '';

export type CompiledUnit =
  /** a fixed piece of text, resolved by exact key `frag:f:<norm>|<end>` */
  | { kind: 'frag'; key: string; text: string; end: FragEnd }
  /**
   * a lone piece word merged with its square: a whole move unit (`slot:ins:n:f6`), split fallback «конём — на эф шесть».
   * `end` = the seam right after it ('' when words of the same fragment follow).
   */
  | { kind: 'move'; key: MoveSlotKey; text: string; end: FragEnd; san?: string }
  /** a square after the fragment that carries its piece word («Соперник вывел коня» · «на эф шесть») */
  | { kind: 'square'; key: `sq:${Square}` | `xsq:${Square}`; text: string; end: FragEnd; san?: string };

export interface CompiledSentence {
  units: CompiledUnit[];
  end: '.' | '!' | '?' | '…';
  /** the sentence as written (name stripped) */
  text: string;
  /** index of the slot unit ('move' / 'square'), -1 without one */
  slotAt: number;
  /** why the sentence can never be voiced from clips (it falls down the ladder at once) */
  bad?: 'mismatch' | 'noPiece' | 'twoSlots' | 'bareSquare' | 'empty';
}

export interface CompiledText {
  src: 'text';
  sentences: CompiledSentence[];
  generic: ClipLineId;
  bark?: MascotPose;
  moment?: string;
}

/** Whatever `planClips` accepts: a builder's clip twin or the compiled text of an unported family. */
export type ClipInput = ClipUtterance | CompiledText;

// ───────────────────────── the planner (SPEC §3.1, §5.3, §6) ─────────────────────────

/** Recently played takes, most recent = biggest number (a play counter). Filled by the layer, read by the planner. */
export interface ClipRecencyView {
  lastPlayed(id: string): number | undefined;
}

export interface ClipRecency extends ClipRecencyView {
  /** the layer calls it when a plan is actually heard (the planner itself never writes) */
  note(ids: readonly string[]): void;
  /** ids, oldest first — for `localStorage` `gambit.clipRecency` (≤ 4 KB) */
  snapshot(): string[];
  restore(ids: readonly string[]): void;
}

export interface ClipCaps {
  maxSentences: number;
  maxMs: number;
}

export interface PlanContext {
  /** random source in [0, 1): bark chance, take choice, gap jitter */
  rng?: () => number;
  recency?: ClipRecencyView;
  /** plays of a pool within which a take is not repeated (default 10, greeting / start / end 20) */
  recencyWindow?: (pool: string) => number;
  /** false for a take the library failed to load (it is skipped like a missing one) */
  available?: (id: string) => boolean;
  /** a 5-minute game: gaps × 0.75, no barks, the short caps */
  blitz?: boolean;
  /** the event's priority: barks go only before priority-1 utterances */
  priority?: 0 | 1 | 2;
  /** the previous utterance had a bark (never two in a row) */
  prevBark?: boolean;
  /** SAN guard (§6.2): a move slot must be one of these (normalised SAN); [] = no move may be named; undefined = no guard */
  allowedSans?: readonly string[];
  /** duration / sentence caps (`clipCapsFor`); default 2 sentences / 12 s */
  caps?: ClipCaps;
  /** preferred take mood ('calm' | 'excited'); takes without a mood always qualify */
  mood?: string;
  /** false: exact table gaps without the ±30 ms jitter (tests, the review page) */
  jitter?: boolean;
  /**
   * «Дозапись голоса»: per sentence of a clip twin, the wording number the bubble shows (`twinWordingsOf`; null /
   * undefined = not known). A W sentence plays that wording's own take first (`line:<poolKey>#<n>` with its exact words),
   * else any take of the pool as before; it is also the wording `lineMissing` asks for. Ignored for a compiled text.
   */
  wordings?: readonly (number | null | undefined)[];
  /**
   * «Дозапись голоса» for a free-worded answer (a «Спроси» answer, a thought reply, a poke — its bubble takes the words
   * heard, so no wording is known): the pool plays any recorded wording as before, and `lineMissing` asks for one more
   * wording while the line has fewer than this many recorded (its variety grows to a few, one at a time). Absent: only
   * a line with no take at all asks.
   */
  grow?: number;
}

export type PlannedRole = 'bark' | 'whole' | 'head' | 'slot' | 'split' | 'tail' | 'frag' | 'generic';

export interface PlannedClip {
  id: string;
  role: PlannedRole;
  text: string;
  /** silence before this clip (0 for the first) */
  gapBeforeMs: number;
  /** planned audible start from the plan's start */
  atMs: number;
  /** audible duration (`off − on`) */
  ms: number;
  /** index into `plan.sentences` (a bark belongs to the first sentence) */
  sentence: number;
}

/** 1 as written (any wording / take), 2 split move, 3 sibling / trimmed tail, 5 generic line, 6 nothing voiced. */
export type ClipLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface PlannedSentence {
  level: ClipLevel;
  text: string;
  fromMs: number;
  toMs: number;
}

export interface ClipMiss {
  /** the unit key that was missing (`slot:ins:n:f6`, `line:reason.attack@n`, `frag:f:…|.`), or 'library' */
  key: string;
  level: 2 | 3 | 4 | 5 | 6;
}

export interface ClipPlan {
  clips: PlannedClip[];
  sentences: PlannedSentence[];
  /** audible length: clips + gaps */
  ms: number;
  /** exactly what will be heard (the bubble / journal / black box) */
  heard: string;
  /** the worst level any sentence fell to (4 = a sentence was dropped) */
  level: ClipLevel;
  /** 'lesson' = a lesson utterance played by its exact unit keys (`planLessonClips`) */
  src: 'clip' | 'text' | 'generic' | 'lesson' | 'none';
  bark: boolean;
  misses: ClipMiss[];
  /** a move slot failed the SAN guard (voiceDiag `clip.mismatch`) */
  mismatch: boolean;
  /** still over `caps.maxMs` after every drop (voiceDiag `clip.long`) */
  long: boolean;
  stats: { units: number; slots: number; split: number; generic: number; dropped: number };
  moment?: string;
  /**
   * a lesson plan (`planLessonClips`): indexes into `lessonSentencesOf(event)` of the sentences that have no recording and
   * may be requested («Дозапись голоса»). Non-empty only when the plan is silent (an utterance is voiced whole or not at all).
   */
  lessonMissing?: number[];
  /**
   * «Дозапись голоса» for a clip twin: the whole catalogue sentences (W lines of role 'whole', never a generic stand-in
   * or a head / tail / bark / slot, never from a compiled text) that have no recording at all and may be requested —
   * the bubble's own wording (`PlanContext.wordings`) when its take is missing, even while the pool voiced another
   * one; a free-worded answer (`PlanContext.grow`) its cheapest unrecorded wording while its line has fewer recorded
   * than that; without a known wording (none given at all), the line's cheapest wording, only when the line itself has
   * no take (it fell to a sibling, L4, L5 or L6) — never when the bubble's words are known to be no wording (a null in
   * `wordings`: that would record words the bubble does not show). «No recording» means none exists (a take that
   * failed to load is not missing). Absent = none.
   */
  lineMissing?: ClipGenLine[];
}
