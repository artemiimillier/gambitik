/**
 * Phrase toolkit shared by every CoachEvent builder.
 *
 * A phrase is a `Template`: a function of a `Voice`. Each chosen template is rendered twice —
 * once as SPEECH (moves/squares in Russian words, no Latin at all) and once for the BUBBLE
 * (Russian notation such as «Кf3» allowed). That keeps `text` and `bubbleText` in sync by design.
 */
import type {
  BoardAnnotations,
  CoachEvent,
  CoachEventKind,
  HintLevel,
  MascotPose,
  MotifId,
  MoveJudgement,
  PieceType,
  Square,
  StudentProfile,
  TeachSummary,
} from '@gambit/shared';
import { pieceGenderRu, pieceNameRu, sanToBubbleRu, sanToSpokenRu, squareToSpokenRu } from './spoken.ts';
import type { GrammaticalCase } from './spoken.ts';

/** Random source in [0, 1). Inject a deterministic one in tests. */
export type Rng = () => number;

export interface Voice {
  readonly mode: 'speech' | 'bubble';
  /** child's nickname, '' when it must not be used (empty, or not speakable in Russian) */
  readonly name: string;
  /** gendered form by `profile.address`: g('сходил', 'сходила') */
  g(masculine: string, feminine: string): string;
  /** a move: speech → 'конь на эф три', bubble → 'Кf3'. `fenBefore` refines disambiguation. */
  move(san: string, fenBefore?: string): string;
  /** a square: speech → 'эф три', bubble → 'f3' */
  sq(square: Square): string;
  /** "Name, rest" when a name is available, otherwise "Rest" (capitalised). */
  hey(rest: string): string;
}

export type Template = (v: Voice) => string;

const CYRILLIC_NAME_RE = /^[А-Яа-яЁё][А-Яа-яЁё \-]{0,23}$/;

/** A name is spoken only if it is plain Cyrillic (TTS reads Latin nicknames unpredictably). */
export function speakableName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  return CYRILLIC_NAME_RE.test(name) ? name : '';
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function lowerFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function createVoice(mode: Voice['mode'], profile: StudentProfile): Voice {
  const rawName = (profile.nickname ?? '').trim();
  const name = mode === 'speech' ? speakableName(rawName) : rawName.slice(0, 24);
  return {
    mode,
    name,
    g: (masculine, feminine) => (profile.address === 'f' ? feminine : masculine),
    move: (san, fenBefore) => (mode === 'speech' ? sanToSpokenRu(san, fenBefore) : sanToBubbleRu(san)),
    sq: (square) => (mode === 'speech' ? squareToSpokenRu(square) : square),
    hey: (rest) => (name ? `${name}, ${lowerFirst(rest)}` : capitalize(rest)),
  };
}

/** Collapses whitespace and fixes spaces before punctuation. */
export function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?:;…])/g, '$1')
    .trim();
}

/** Last line of defence for the "no Latin in `text`" contract. */
function stripLatin(s: string): string {
  return /[A-Za-z]/.test(s) ? tidy(s.replace(/[A-Za-z][A-Za-z0-9+#=\-]*/g, '')) : s;
}

export function render(template: Template, profile: StudentProfile): { text: string; bubbleText: string } {
  return {
    text: stripLatin(tidy(template(createVoice('speech', profile)))),
    bubbleText: tidy(template(createVoice('bubble', profile))),
  };
}

/** Joins sentence templates with a space. */
export function join(...parts: Template[]): Template {
  return (v) => parts.map((p) => p(v)).join(' ');
}

export const say =
  (s: string): Template =>
  () =>
    s;

// ───────────────────────── variant picking ─────────────────────────

/** Last index served per pool — only used with the default rng, to avoid saying the same line twice in a row. */
const lastPickByPool = new WeakMap<object, number>();
const lastPickByKey = new Map<string, number>();

/**
 * Picks one element. With an injected `rng` the choice is a pure function of `rng()`;
 * with the default `Math.random` an immediate repeat from the same pool is avoided
 * (pools built on the fly pass a stable `memoryKey`, static pools are remembered by identity).
 */
export function pick<T>(pool: readonly T[], rng: Rng = Math.random, memoryKey?: string): T {
  if (pool.length === 0) throw new Error('pick: empty pool');
  const r = rng();
  let i = Number.isFinite(r) ? Math.floor(r * pool.length) : 0;
  i = Math.min(pool.length - 1, Math.max(0, i));
  if (rng === Math.random && pool.length > 1) {
    const last = memoryKey === undefined ? lastPickByPool.get(pool) : lastPickByKey.get(memoryKey);
    if (last === i) i = (i + 1) % pool.length;
    if (memoryKey === undefined) lastPickByPool.set(pool, i);
    else lastPickByKey.set(memoryKey, i);
  }
  return pool[i]!;
}

// ───────────────────────── piece grammar ─────────────────────────

export function pieceWord(p: PieceType, c: GrammaticalCase): string {
  return pieceNameRu(p, c);
}

/** 'твой конь' / 'твоя ладья' */
export function yourPieceNom(p: PieceType): string {
  return `${pieceGenderRu(p) === 'f' ? 'твоя' : 'твой'} ${pieceNameRu(p, 'nom')}`;
}

/** 'своего коня' / 'свою ладью' */
export function ownPieceAcc(p: PieceType): string {
  return `${pieceGenderRu(p) === 'f' ? 'свою' : 'своего'} ${pieceNameRu(p, 'acc')}`;
}

export function pronounNom(p: PieceType): string {
  return pieceGenderRu(p) === 'f' ? 'она' : 'он';
}

export function pronounAcc(p: PieceType): string {
  return pieceGenderRu(p) === 'f' ? 'её' : 'его';
}

export function pronounDat(p: PieceType): string {
  return pieceGenderRu(p) === 'f' ? 'ей' : 'ему';
}

/** Verb ending agreeing with the piece's grammatical gender: pieceG(p, 'вышел', 'вышла'). */
export function pieceG(p: PieceType, masculine: string, feminine: string): string {
  return pieceGenderRu(p) === 'f' ? feminine : masculine;
}

// ───────────────────────── event assembly ─────────────────────────

let eventCounter = 0;

function nextEventId(kind: CoachEventKind): string {
  eventCounter = (eventCounter + 1) % 1_000_000;
  return `${kind}-${Date.now().toString(36)}-${eventCounter.toString(36)}`;
}

export interface EventSpec {
  kind: CoachEventKind;
  priority: 0 | 1 | 2;
  pose: MascotPose;
  pauseClock: boolean;
  template: Template;
  profile: StudentProfile;
  board?: BoardAnnotations;
  hintLevel?: HintLevel;
  motif?: MotifId;
  judgement?: MoveJudgement;
  /** situation brief for conversational voices (see ./brief.ts) — facts + goal, never a script */
  brief?: string;
  /** teacher mode: what was advised (docs/TEACHER-MODE.md §6.4) */
  teach?: TeachSummary;
}

export function makeEvent(spec: EventSpec): CoachEvent {
  const { text, bubbleText } = render(spec.template, spec.profile);
  const event: CoachEvent = {
    id: nextEventId(spec.kind),
    kind: spec.kind,
    priority: spec.priority,
    text,
    bubbleText,
    pose: spec.pose,
    pauseClock: spec.pauseClock,
  };
  if (spec.board && (spec.board.arrows.length > 0 || spec.board.highlights.length > 0)) event.board = spec.board;
  if (spec.hintLevel !== undefined) event.hintLevel = spec.hintLevel;
  if (spec.motif !== undefined) event.motif = spec.motif;
  if (spec.judgement !== undefined) event.judgement = spec.judgement;
  if (spec.brief !== undefined && spec.brief.trim() !== '') event.brief = spec.brief;
  if (spec.teach !== undefined) event.teach = spec.teach;
  return event;
}

// ───────────────────────── text metrics (used by tests and by length-aware builders) ─────────────────────────

export function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => /[A-Za-zА-Яа-яЁё0-9]/.test(w)).length;
}

export function countSentences(s: string): number {
  return s.split(/[.!?…]+/).filter((part) => /[A-Za-zА-Яа-яЁё0-9]/.test(part)).length;
}

/** Renders candidates in order and returns the first whose SPEECH fits `maxWords`; else the last. */
export function firstFitting(candidates: readonly Template[], profile: StudentProfile, maxWords: number): Template {
  for (const c of candidates) {
    if (countWords(render(c, profile).text) <= maxWords) return c;
  }
  return candidates[candidates.length - 1]!;
}
