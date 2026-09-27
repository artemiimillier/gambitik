/**
 * Clip twins (docs/voice-clips/SPEC.md §3.4 route 1): the builders of the ported families (teacher turn, reveal,
 * «Совет», take-back, praise, game start / end, greeting — teacher.ts, events.ts) describe the SAME parts they put
 * into `text` as catalogue line ids + at most one typed move slot per sentence, and attach the result as
 * `CoachEvent.clip`. The web's clip layer plans it (`planClips`); layers other than 'clips' ignore it. Everything
 * here is pure and deterministic: a twin never draws from the builder's `rng` (the text's random choices stay exactly
 * as they were) — the variety of the recorded voice comes from the pools, wordings and takes the planner picks.
 *
 * Rules the twins keep (SPEC §3.1–§3.2):
 *  - only lines of the catalogue (./catalog.ru.ts) and slots keyed from chess.js-verified SAN; never free text — the
 *    strategist's `introRu` / `planRu` / `whyRu` are never voiced;
 *  - the opponent's move, a danger, a treasure are named without a square; a square is said only by the advised move;
 *  - ≤ 2 sentences (1 in the short style), ≤ `CLIP_TEACH_MAX_WORDS` / `CLIP_SHORT_MAX_WORDS` words by the catalogue's
 *    mean wording (`fitTwin`).
 *
 * Interpretation (documented, SPEC §3.5 says «drop sentences with prio < 100, then tails»): a reason tail weighs
 * `TWIN_TAIL_WEIGHT` (65) against the optional sentences' prio — over the word budget the lightest goes first, so a
 * danger (90) or «Поторопись!» (85) outlives the reason of the move, the opponent's move (40–45) or a praise (50) does
 * not. A mate / promotion tail says what the move IS and weighs more (95 / 90).
 */
import type { ClipItem, ClipSentence, ClipUtterance, CoachEvent, CoachEventKind, MascotPose, PieceType, StudentProfile } from '@gambit/shared';
import { pieceAt, resolveUciMove } from '../board.ts';
import { countWords } from '../phrase.ts';
import { expandWording, linePieces } from './catalog.ts';
import { clipCatalogLine, hasClipLine, planGoalLineOf, strategyLineOf } from './catalog.ru.ts';
import { genericLineOf } from './compile.ts';
import { canonicalSlotText, moveTailsOf, slotFormOf, slotKeyOf, verifyMove } from './keys.ts';
import { CLIP_MAX_SENTENCES, CLIP_SHORT_MAX_WORDS, CLIP_TEACH_MAX_WORDS, validateClipUtterance } from './plan.ts';

// ───────────────────────── sentences with weights ─────────────────────────

/** A twin sentence before fitting: the shared `ClipSentence` plus how much its last item (a tail) weighs. */
export interface TwinSentence extends ClipSentence {
  /** the last item is a tail that may be dropped over the word budget; its weight against the optional sentences */
  tailWeight?: number;
}

/** A reason tail against the optional sentences (see the file comment). */
export const TWIN_TAIL_WEIGHT = 65;
/** «— и это мат!» / «— и станет ферзём!»: the move's own news. */
export const TWIN_MATE_TAIL_WEIGHT = 95;
export const TWIN_PROMO_TAIL_WEIGHT = 90;
/** Word budget of the events that are no teacher turn (greeting, game start / end, praise, take-back). */
export const TWIN_OTHER_MAX_WORDS = 24;

/** Which slot form follows a head (the head's wordings are written for it). A head not listed takes 'nom'. */
export const HEAD_SLOT_FORM: Readonly<Record<string, 'nom' | 'ins'>> = {
  'teach.head.advice': 'ins',
  'teach.head.go': 'ins',
  'teach.head.calm': 'ins',
  'teach.head.answer': 'ins',
  'teach.head.answer.plan': 'ins',
  'teach.head.arrow': 'nom',
  'teach.head.good': 'nom',
  'teach.head.plan': 'nom',
  'teach.head.planNext': 'nom',
  'teach.head.planStep': 'nom',
  'teach.head.replan': 'nom',
  'teach.head.alt': 'nom',
  'reveal.head': 'nom',
  'repeat.head': 'nom',
  'start.head.first': 'nom',
  'takeback.head.advice': 'nom',
};

/** The child's gender for the `byGender` lines. */
export function genderOf(profile: Pick<StudentProfile, 'address'> | null | undefined): 'm' | 'f' {
  return profile?.address === 'f' ? 'f' : 'm';
}

/**
 * A catalogue line as a sentence item: the piece only when the line is recorded for that piece (else its plain,
 * piece-neutral pool), the gender only for a `byGender` line.
 */
export function lineItem(id: string, variant: { piece?: PieceType | null; g?: 'm' | 'f' | null } = {}): Extract<ClipItem, { line: string }> {
  const line = clipCatalogLine(id);
  const item: Extract<ClipItem, { line: string }> = { line: id };
  if (line && variant.piece && linePieces(line).includes(variant.piece)) item.piece = variant.piece;
  if (line?.byGender && variant.g) item.g = variant.g;
  return item;
}

/** The sentence end a whole line is recorded with (its first wording). */
function endOf(id: string): ClipSentence['end'] {
  const t = clipCatalogLine(id)?.wordings[0]?.t.trim() ?? '';
  if (t.endsWith('?')) return '?';
  if (t.endsWith('!')) return '!';
  return '.';
}

/** A whole-line sentence (W). */
export function wholeSentence(item: ClipItem | string, prio: number): TwinSentence {
  const it = typeof item === 'string' ? lineItem(item) : item;
  return { items: [it], prio, end: 'line' in it ? endOf(it.line) : '.' };
}

/**
 * A move slot in the form a head wants: castling is always said «короткая рокировка» (nom), a capture «конь бьёт на …»
 * (cap), a promotion in the nominative; null when the move is not legal in `fen`.
 */
export function slotItem(san: string, fen: string, prefer: 'nom' | 'ins' = 'nom'): Extract<ClipItem, { slot: string }> | null {
  const m = verifyMove(san, fen);
  if (!m) return null;
  const form = m.castle ? 'nom' : slotFormOf(m.san, fen, prefer);
  if (!form || !slotKeyOf(m.san, fen, form)) return null;
  return { slot: form, san: m.san, fen };
}

/** What the move itself says, instead of a reason: mate / promotion (and a check when there is no reason). */
export function moveTailItem(san: string, fen: string): { item: ClipItem; weight: number; check?: boolean } | null {
  const t = moveTailsOf(san, fen);
  if (!t) return null;
  if (t.check === 'mate') return { item: lineItem('reason.mate'), weight: TWIN_MATE_TAIL_WEIGHT };
  if (t.promotion) return { item: lineItem('move.promo', { piece: t.promotion }), weight: TWIN_PROMO_TAIL_WEIGHT };
  if (t.check === 'check') return { item: lineItem('reason.check'), weight: TWIN_TAIL_WEIGHT, check: true };
  return null;
}

/**
 * The advice sentence: [head ·] move [· tail] — H·S·T, H·S, S·T. The move's own news (mate, promotion) replaces the
 * reason; a check is said only when there is no reason. null when the move is not legal in `fen`.
 */
export function moveSentence(o: {
  head?: string | null;
  san: string;
  fen: string;
  reason?: ClipItem | null;
  prio: number;
  /** the move's own news (mate / promotion / check) may be the tail — true for an advised move */
  moveNews?: boolean;
  /** the weight of `reason` (default `TWIN_TAIL_WEIGHT`) */
  reasonWeight?: number;
}): TwinSentence | null {
  const prefer = o.head ? (HEAD_SLOT_FORM[o.head] ?? 'nom') : 'nom';
  const slot = slotItem(o.san, o.fen, prefer);
  if (!slot) return null;
  const items: ClipItem[] = [];
  if (o.head) items.push(lineItem(o.head));
  items.push(slot);
  let tail: { item: ClipItem; weight: number } | null = null;
  const news = o.moveNews ? moveTailItem(o.san, o.fen) : null;
  if (news && !news.check) tail = news;
  else if (o.reason) tail = { item: o.reason, weight: o.reasonWeight ?? TWIN_TAIL_WEIGHT };
  else if (news) tail = news;
  if (tail) items.push(tail.item);
  return { items, prio: o.prio, end: '.', ...(tail ? { tailWeight: tail.weight } : {}) };
}

// ───────────────────────── reasons: an idea of ./moveIdeas.ts → its tail ─────────────────────────

/** The piece an idea is about — the attacked / captured / saved / developed one — for its `byPiece` tail. */
export function ideaPieceOf(idea: { id: string; squares: readonly string[] }, fen: string, uci: string): PieceType | undefined {
  const mv = resolveUciMove(fen, uci);
  if (!mv) return undefined;
  const at = (sq: string | undefined): PieceType | undefined => (sq ? pieceAt(mv.fenAfter, sq)?.piece : undefined);
  switch (idea.id) {
    case 'freeCapture':
    case 'winMaterial':
    case 'recapture':
      return mv.captured;
    case 'develop':
    case 'escape':
    case 'improvePiece':
      return mv.piece;
    case 'attack':
    case 'defend':
    case 'block':
    case 'trappedPiece':
      return at(idea.squares[0]);
    default:
      return undefined;
  }
}

/** `reason.<ideaId>` with its piece, or null when the catalogue has no such reason. */
export function reasonOfIdea(idea: { id: string; squares: readonly string[] } | undefined, fen: string, uci: string): ClipItem | null {
  if (!idea) return null;
  const id = `reason.${idea.id}`;
  if (!hasClipLine(id)) return null;
  return lineItem(id, { piece: ideaPieceOf(idea, fen, uci) ?? null });
}

/** A plan goal of the strategy library (its text) → its goal tail, else the plain plan tail (`teach.tail.plan`). */
export function goalItemOf(goalRu: string | null | undefined): ClipItem {
  return lineItem(planGoalLineOf(goalRu) ?? 'teach.tail.plan');
}

// ───────────────────────── the strategy intro (gameStart / the first teacher turn) ─────────────────────────

/**
 * «Разыграем Итальянскую партию: …!» · «Первый ход — пешка на е четыре.» (Black: «Отвечаем так: пешкой на е пять.»)
 * — the library's own intro line (never the strategist's free `introRu`); a strategy the catalogue does not know
 * says the plain teacher start. `first` = the child's first move of the strategy (null: no move sentence).
 */
export function strategyIntroSentences(
  strategy: { strategyId: string } | null | undefined,
  first: { san: string; fenBefore: string } | null,
  childColor: 'w' | 'b',
  g: 'm' | 'f',
): TwinSentence[] {
  const intro = strategyLineOf(strategy?.strategyId);
  const out: TwinSentence[] = [wholeSentence(intro ? lineItem(intro) : lineItem('start.teacher.plain', { g }), 100)];
  if (first) {
    // (core, like the intro itself: the text says both in one part — the first move is never cut for the word budget)
    const s = moveSentence({ head: childColor === 'w' ? 'start.head.first' : 'teach.head.answer', san: first.san, fen: first.fenBefore, prio: 100 });
    if (s) out.push(s);
  }
  return out;
}

// ───────────────────────── fitting: sentences and words ─────────────────────────

const wordsMemo = new Map<string, number>();

/** Words of one item as heard: a slot's canonical text; a line's mean wording for its variant (rounded). */
export function itemWords(item: ClipItem): number {
  if ('slot' in item) {
    const key = slotKeyOf(item.san, item.fen, item.slot);
    return key ? countWords(canonicalSlotText(key)) : 4;
  }
  const memoKey = `${item.line}@${item.piece ?? ''}/${item.g ?? ''}`;
  const hit = wordsMemo.get(memoKey);
  if (hit !== undefined) return hit;
  const line = clipCatalogLine(item.line);
  let n = 3;
  if (line && line.wordings.length > 0) {
    const counts = line.wordings.map((wd) => {
      const text = expandWording(wd.t, { ...(item.piece ? { piece: item.piece } : { piece: 'n' as const }), ...(item.g ? { g: item.g } : { g: 'm' as const }) }) ?? wd.t;
      return countWords(text);
    });
    n = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
  }
  wordsMemo.set(memoKey, n);
  return n;
}

function sentenceWords(s: TwinSentence): number {
  return s.items.reduce((sum, it) => sum + itemWords(it), 0);
}

export interface TwinCaps {
  maxSentences: number;
  maxWords: number;
}

/** Teacher turn: 2 sentences / 18 words; the short style: 1 / 10 (SPEC §3.5); other events: 2 / 24. */
export function twinCapsFor(o: { teacher: boolean; style?: 'full' | 'short' | 'concept' | null }): TwinCaps {
  if (!o.teacher) return { maxSentences: CLIP_MAX_SENTENCES, maxWords: TWIN_OTHER_MAX_WORDS };
  return o.style === 'short' ? { maxSentences: 1, maxWords: CLIP_SHORT_MAX_WORDS } : { maxSentences: CLIP_MAX_SENTENCES, maxWords: CLIP_TEACH_MAX_WORDS };
}

/**
 * The sentences that fit the caps, in speaking order: over the sentence count the optional sentence of the lowest prio
 * goes (the later one of equals); over the words the lightest of those and of the droppable tails. The core
 * (prio 100) is never dropped — at most its tail; more core sentences than the cap keep the first ones.
 */
export function fitTwin(sentences: readonly (TwinSentence | null | undefined)[], caps: TwinCaps): ClipSentence[] {
  let cur: TwinSentence[] = sentences.filter((s): s is TwinSentence => !!s && s.items.length > 0).map((s) => ({ ...s, items: [...s.items] }));
  for (let guard = 0; guard < 24; guard++) {
    const overCount = cur.length > caps.maxSentences;
    const overWords = cur.reduce((sum, s) => sum + sentenceWords(s), 0) > caps.maxWords;
    if (!overCount && !overWords) break;
    let best: { kind: 'sentence' | 'tail'; index: number; weight: number } | null = null;
    cur.forEach((s, i) => {
      if (s.prio < 100 && (!best || s.prio <= best.weight)) best = { kind: 'sentence', index: i, weight: s.prio };
      if (!overCount && s.tailWeight !== undefined && s.items.length > 1 && (!best || s.tailWeight <= best.weight)) best = { kind: 'tail', index: i, weight: s.tailWeight };
    });
    const chosen = best as { kind: 'sentence' | 'tail'; index: number; weight: number } | null;
    if (!chosen) break;
    if (chosen.kind === 'sentence') cur = cur.filter((_, i) => i !== chosen.index);
    else {
      const s = cur[chosen.index] as TwinSentence;
      const { tailWeight: _dropped, ...rest } = s;
      void _dropped;
      cur[chosen.index] = { ...rest, items: s.items.slice(0, -1), end: '.' };
    }
  }
  return cur.slice(0, Math.min(caps.maxSentences, CLIP_MAX_SENTENCES)).map(({ items, prio, end }) => ({ items, prio, end }));
}

/** The twin utterance of an event: the fitted sentences, the bark pose, the generic line of its moment (ladder L5). */
export function twinUtterance(o: { sentences: readonly (TwinSentence | null | undefined)[]; kind: CoachEventKind; pose: MascotPose; moment?: string; caps: TwinCaps }): ClipUtterance | null {
  const sentences = fitTwin(o.sentences, o.caps);
  if (sentences.length === 0) return null;
  return {
    sentences,
    bark: o.pose,
    generic: genericLineOf(o.kind, o.moment, o.pose),
    ...(o.moment ? { moment: o.moment } : {}),
  };
}

/**
 * Attaches a twin to its event — only a valid one (SPEC §3.1 shapes, legal slots, catalogue lines): a twin that would
 * not validate is left out, and the clip layer compiles `event.text` instead (the bridge). Returns the event.
 */
export function withClip(event: CoachEvent, clip: ClipUtterance | null | undefined): CoachEvent {
  if (!clip) return event;
  if (validateClipUtterance(clip).length > 0) return event;
  if (clip.sentences.some((s) => s.items.some((it) => 'line' in it && !hasClipLine(it.line)))) return event;
  event.clip = clip;
  return event;
}
