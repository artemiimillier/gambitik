/**
 * «Дозапись голоса» — a lesson utterance played from recorded units by their EXACT keys (never the pool route, no
 * generic line, no sentence caps: the bubble shows every sentence, so the voice says every sentence or none).
 *
 *  - a sentence is a whole wording, a lead said alone, a lead + its tail, or the stage 1–2 quiz options sentence
 *    (`event.saySentences`); a part's key is `lessonUnitKey(say)`, the options sentence's `lessonQuizKey(text)`;
 *  - a take is used only when its manifest text is exactly the part's expansion (`expectedPartText`) and the parts
 *    joined are exactly the sentence (`joinSentence`) — what is heard is what the bubble shows (stale takes are silent);
 *    a take whose wording number shifted is found by its pool variant and text (`takesForUnit`, merged index);
 *  - an utterance is voiced whole or not at all; a silent plan lists the sentences that may be requested
 *    (`lessonMissing`); an utterance with a sentence that can never be recorded (no parts and no quiz, a quiz-button or
 *    never-said pool, a tail alone, words that are not the bubble's) is never voiced and never requested;
 *  - a lead is never played without its tail; a `ctx: 'cont'` lead take only right before its tail;
 *  - the gaps are `LESSON_GAPS_MS` (±`CLIP_GAP_JITTER_MS` from the injected rng, ×`CLIP_BLITZ_GAP_FACTOR` in blitz);
 *    the take of a unit is chosen by the planner's rules (`createTakePicker`: not the one heard recently).
 *
 * The same text functions serve the server that renders a request from ids (it never accepts text), so a recording is
 * always made of exactly the words the child's bubble shows.
 */
import type { ClipGenSentence, CoachEvent, LessonSay, LessonSaySentence, PieceType, QuizKind } from '@gambit/shared';
import { lessonLine } from '@gambit/content';
import { VOICE_NEUTRAL_POOL, lessonUnitKey } from '../lesson/book.ts';
import { joinSentence } from '../lesson/render.ts';
import { isOptionPool, pieceLabel, quizOptionLabel, quizOptionsText } from '../lesson/quizWords.ts';
import { expandWording, usesGender, usesPiece } from './catalog.ts';
import { lessonQuizKey, takesForUnit } from './keys.ts';
import { CLIP_BLITZ_GAP_FACTOR, CLIP_GAPS_MS, CLIP_GAP_JITTER_MS, createTakePicker, planRoll } from './plan.ts';
import type { ClipIndex, ClipMiss, ClipPlan, MergedClipIndex, PlanContext, PlannedClip, PlannedRole, PlannedSentence } from './types.ts';

/**
 * Silence before the next clip of a lesson utterance (ms), before the ±`CLIP_GAP_JITTER_MS` jitter and the
 * ×`CLIP_BLITZ_GAP_FACTOR` of a blitz game: a falling lead → its «—» tail, a `ctx: 'cont'` lead → its tail (a natural
 * continuation dash measured 60–160 ms), a tail starting with «:» / «;», after «.» «!» «…», after «?».
 */
export const LESSON_GAPS_MS = { dash: 280, cont: 140, colon: 240, semicolon: 260, sentence: 450, question: 500 } as const;

/** A voiced lesson plan longer than this is flagged `long` (a diag only: nothing is dropped, the bubble shows it all). */
export const LESSON_LONG_MS = 20_000;

/** What the lesson planner reads of an event. */
export type LessonPlanEvent = Pick<CoachEvent, 'text' | 'say' | 'saySentences'>;

/** The planner context a lesson plan uses (no caps, no SAN guard, no barks). */
export type LessonPlanContext = Pick<PlanContext, 'rng' | 'recency' | 'recencyWindow' | 'available' | 'blitz' | 'mood' | 'jitter'>;

/** A lesson plan: `lessonMissing` is always present ([] when voiced, or when nothing may be requested). */
export type LessonClipPlan = ClipPlan & { lessonMissing: number[] };

/** The options of a quiz sentence as ids, resolved to the wordings said (the request / server shape). */
export type LessonQuizIds = Extract<ClipGenSentence, { quiz: unknown }>['quiz'];

/**
 * The exact text of one said part: its wording expanded for its piece / gender — the same text the book said and the
 * manifest's `unit.text` must equal. null when the pool or wording does not exist, or the variant does not match the
 * wording (a piece without a piece placeholder or none with one; the same for the gender): such ids are never valid.
 */
export function expectedPartText(say: LessonSay): string | null {
  if (!Number.isInteger(say.n) || say.n < 1) return null;
  const w = lessonLine(say.pool)?.wordings[say.n - 1];
  if (!w) return null;
  if (usesPiece(w.t) !== (say.piece !== undefined)) return null;
  if (usesGender(w.t) !== (say.g !== undefined)) return null;
  return expandWording(w.t, { ...(say.piece ? { piece: say.piece } : {}), ...(say.g ? { g: say.g } : {}) });
}

/** The sentence of 1 (whole / a lead alone) or 2 (lead + tail) parts exactly as the bubble shows it; null if a part is invalid. */
export function expectedSentenceText(parts: readonly LessonSay[]): string | null {
  if (parts.length < 1 || parts.length > 2) return null;
  const texts = parts.map(expectedPartText);
  return texts.every((t): t is string => t !== null) ? joinSentence(texts) : null;
}

/**
 * The stage 1–2 options sentence of a quiz from ids: «Ладью, коня или слона?». A `say` option must be a quiz-button
 * wording (`v3.quiz.opt.*` / `v3.quiz.cat.*`, no piece); exactly three options. null otherwise.
 */
export function expectedQuizText(quiz: LessonQuizIds): string | null {
  if (quiz.options.length !== 3) return null;
  const labels: string[] = [];
  for (const o of quiz.options) {
    if ('piece' in o) {
      labels.push(pieceLabel(o.piece, quiz.kind));
      continue;
    }
    if (!isOptionPool(o.say.pool) || o.say.piece !== undefined) return null;
    const text = expectedPartText(o.say);
    if (text === null) return null;
    labels.push(quizOptionLabel(text));
  }
  return quizOptionsText(labels as [string, string, string]);
}

/**
 * The sentences of a lesson event for the recorded voice: `event.saySentences`; for an event without it, derived
 * from the parts' roles (a whole wording or a lead starts a sentence, a tail ends the lead's) — [] when that does not
 * reproduce `text` exactly, or the event has the quiz options sentence (its piece buttons are not in `say`).
 */
export function lessonSentencesOf(event: LessonPlanEvent): LessonSaySentence[] {
  if (event.saySentences) return event.saySentences;
  const say = event.say ?? [];
  const out: LessonSaySentence[] = [];
  for (let i = 0; i < say.length; i++) {
    const part = say[i] as LessonSay;
    const role = lessonLine(part.pool)?.role;
    // (a tail here has no lead in front of it: the lead takes its tail below)
    if (role === undefined || role === 'tail' || isOptionPool(part.pool)) return [];
    const next = say[i + 1];
    const parts = role === 'lead' && next !== undefined && lessonLine(next.pool)?.role === 'tail' ? [i, i + 1] : [i];
    const text = expectedSentenceText(parts.map((k) => say[k] as LessonSay));
    if (text === null) return [];
    out.push({ text, parts });
    i += parts.length - 1;
  }
  return out.length > 0 && out.map((x) => x.text).join(' ') === event.text ? out : [];
}

/**
 * One sentence as request ids (POST /voice/clips/request), resolving its `say` indexes. null = it can never be recorded
 * (no parts and no quiz, an index out of range, more than two parts) — such an utterance is never requested.
 */
export function requestSentenceOf(event: Pick<CoachEvent, 'say'>, s: LessonSaySentence): ClipGenSentence | null {
  const say = event.say ?? [];
  const at = (i: number): LessonSay | null => (Number.isInteger(i) && i >= 0 && i < say.length ? (say[i] as LessonSay) : null);
  if (s.quiz) {
    const options: ({ say: LessonSay } | { piece: PieceType })[] = [];
    for (const o of s.quiz.options) {
      if ('piece' in o) options.push({ piece: o.piece });
      else {
        const part = at(o.say);
        if (!part) return null;
        options.push({ say: part });
      }
    }
    const kind: QuizKind = s.quiz.kind;
    return { quiz: { kind, options } };
  }
  const parts = s.parts.map(at);
  if (parts.length === 1 && parts[0]) return { parts: [parts[0]] };
  if (parts.length === 2 && parts[0] && parts[1]) return { parts: [parts[0], parts[1]] };
  return null;
}

/** One recorded unit of a sentence, with the takes that say exactly its text. */
interface LessonUnit {
  key: string;
  text: string;
  role: PlannedRole;
  /** a lead right before its tail (a `ctx: 'cont'` take may serve it) */
  beforeTail: boolean;
  takes: string[];
}

/** A sentence resolved against the index: its units, or why it can never be voiced ('shape' / 'text:mismatch'). */
type ResolvedSentence = { units: LessonUnit[] } | { never: string };

/** The seam gap between a lead and its tail: by the tail's first mark; a lead that keeps rising (`cont`) goes on at once. */
function seamGap(tail: string, cont: boolean): number {
  if (cont) return LESSON_GAPS_MS.cont;
  const first = tail.trim().charAt(0);
  if (first === '—' || first === '–') return LESSON_GAPS_MS.dash;
  if (first === ':') return LESSON_GAPS_MS.colon;
  if (first === ';') return LESSON_GAPS_MS.semicolon;
  // (no tail starts otherwise today; a comma seam would be the split gap)
  return CLIP_GAPS_MS.split;
}

/** The gap after a whole sentence: a question waits for its answer a little longer. */
function sentenceGap(prev: string): number {
  return /\?[»"”)]*$/u.test(prev.trim()) ? LESSON_GAPS_MS.question : LESSON_GAPS_MS.sentence;
}

/**
 * Plans one lesson utterance from exact keys (see the module comment): whole or nothing, `src: 'lesson'` when voiced,
 * a silent plan (level 6, `src: 'none'`) with `lessonMissing` otherwise. `index` null = no library (silent, nothing
 * requested). A plain `ClipIndex` works too (no text-index fallback).
 */
export function planLessonClips(event: LessonPlanEvent, index: ClipIndex | MergedClipIndex | null | undefined, opts: LessonPlanContext = {}): LessonClipPlan {
  const misses: ClipMiss[] = [];
  const silent = (lessonMissing: number[] = []): LessonClipPlan => ({
    clips: [],
    sentences: [],
    ms: 0,
    heard: '',
    level: 6,
    src: 'none',
    bark: false,
    misses,
    mismatch: false,
    long: false,
    stats: { units: 0, slots: 0, split: 0, generic: 0, dropped: 0 },
    lessonMissing,
  });
  if (!index) {
    misses.push({ key: 'library', level: 6 });
    return silent();
  }
  if (event.text.trim() === '') return silent();
  const sents = lessonSentencesOf(event);
  if (sents.length === 0 || sents.map((x) => x.text).join(' ') !== event.text) {
    misses.push({ key: 'text:mismatch', level: 6 });
    return silent();
  }

  const say = event.say ?? [];
  const available = opts.available ?? (() => true);
  const usable = (unit: Omit<LessonUnit, 'takes'>): string[] =>
    takesForUnit(index, unit.key, unit.text).filter((id) => available(id) && (unit.beforeTail || index.units[id]?.ctx !== 'cont'));

  const resolve = (s: LessonSaySentence): ResolvedSentence => {
    if (s.quiz) {
      const ids = requestSentenceOf(event, s);
      if (!ids || !('quiz' in ids)) return { never: 'shape' };
      if (expectedQuizText(ids.quiz) !== s.text) return { never: 'text:mismatch' };
      const unit = { key: lessonQuizKey(s.text), text: s.text, role: 'frag' as const, beforeTail: false };
      return { units: [{ ...unit, takes: usable(unit) }] };
    }
    if (s.parts.length < 1 || s.parts.length > 2) return { never: 'shape' };
    const parts = s.parts.map((k) => (Number.isInteger(k) && k >= 0 && k < say.length ? (say[k] as LessonSay) : null));
    if (parts.some((p) => p === null || VOICE_NEUTRAL_POOL(p.pool))) return { never: 'shape' };
    const roles = (parts as LessonSay[]).map((p) => lessonLine(p.pool)?.role);
    const shapeOk = roles.length === 1 ? roles[0] === 'whole' || roles[0] === 'lead' : roles[0] === 'lead' && roles[1] === 'tail';
    if (!shapeOk) return { never: 'shape' };
    const texts = (parts as LessonSay[]).map(expectedPartText);
    if (texts.some((t) => t === null) || joinSentence(texts as string[]) !== s.text) return { never: 'text:mismatch' };
    return {
      units: (parts as LessonSay[]).map((p, k) => {
        const unit = {
          key: lessonUnitKey(p),
          text: texts[k] as string,
          role: (roles[k] === 'whole' ? 'whole' : roles[k] === 'lead' ? 'head' : 'tail') as PlannedRole,
          beforeTail: roles[k] === 'lead' && parts.length === 2,
        };
        return { ...unit, takes: usable(unit) };
      }),
    };
  };

  const resolved = sents.map(resolve);
  const never = resolved.find((r): r is { never: string } => 'never' in r);
  if (never) {
    misses.push({ key: never.never, level: 6 });
    return silent();
  }
  const units = resolved.map((r) => (r as { units: LessonUnit[] }).units);
  const missing = units.flatMap((list, i) => (list.some((u) => u.takes.length === 0) ? [i] : []));
  if (missing.length > 0) {
    for (const list of units) for (const u of list) if (u.takes.length === 0) misses.push({ key: u.key, level: 6 });
    return silent(missing);
  }

  // ── every unit has a take: choose them (spoken order), then the timing ──
  const roll = planRoll(opts.rng);
  const picker = createTakePicker(index, opts, roll);
  const chosen = units.map((list) => list.map((u) => ({ u, id: picker.pick(u.takes, u.key) as string })));
  const factor = opts.blitz ? CLIP_BLITZ_GAP_FACTOR : 1;
  const withJitter = opts.jitter !== false;
  const gap = (base: number): number => Math.max(0, Math.round(base * factor + (withJitter ? (roll() * 2 - 1) * CLIP_GAP_JITTER_MS : 0)));
  const durOf = (id: string): number => {
    const u = index.units[id];
    return u ? Math.max(0, (u.off ?? u.ms) - (u.on ?? 0)) : 0;
  };
  const clips: PlannedClip[] = [];
  const planned: PlannedSentence[] = [];
  let t = 0;
  chosen.forEach((list, si) => {
    let fromMs = -1;
    list.forEach(({ u, id }, ci) => {
      let g = 0;
      if (clips.length > 0) {
        const lead = ci > 0 ? list[ci - 1] : undefined;
        g = gap(lead ? seamGap(u.text, index.units[lead.id]?.ctx === 'cont') : sentenceGap((sents[si - 1] as LessonSaySentence).text));
      }
      t += g;
      if (fromMs < 0) fromMs = t;
      const ms = durOf(id);
      clips.push({ id, role: u.role, text: index.units[id]?.text.trim() || u.text, gapBeforeMs: g, atMs: t, ms, sentence: si });
      t += ms;
    });
    planned.push({ level: 1, text: (sents[si] as LessonSaySentence).text, fromMs, toMs: t });
  });
  return {
    clips,
    sentences: planned,
    ms: t,
    heard: planned.map((p) => p.text).join(' '),
    level: 1,
    src: 'lesson',
    bark: false,
    misses,
    mismatch: false,
    long: t > LESSON_LONG_MS,
    stats: { units: clips.length, slots: 0, split: 0, generic: 0, dropped: 0 },
    lessonMissing: [],
  };
}
