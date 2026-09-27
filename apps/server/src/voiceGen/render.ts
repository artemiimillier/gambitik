/**
 * «Дозапись голоса»: a request sentence (ids only) → the units to record, their words rendered HERE from
 * @gambit/content by the same core functions the lesson book and the bubble use. The server never accepts text (R1),
 * so a recording is always exactly the child's bubble; ids that could never have been said (a piece on a wording
 * without a piece placeholder, the king as a victim, a tail on its own, n out of range, a quiz option that is not a
 * button wording, a silent pool …) are refused, and so is any sentence that contains the child's nickname.
 *
 * A whole catalogue sentence of an older event (`{ line }`: a greeting, an answer, a take-back reply…) is rendered by
 * core `resolveClipGenLine` from the clip catalogue — never the lesson pools: role 'whole' only (a head, a tail or a
 * bark exists only around a move or before a line), never a generic stand-in or the settings' preview, `n` in range,
 * the variant its wording uses. Its unit is exactly the catalogue's (`catalogUnits`): the starter set's key
 * `line:<poolKey>#<n>` and every pool the take joins, so a recording on demand and a starter-set take are one library.
 *
 * `packJobs` then records a request's missing units in as few paid jobs as the «pack» recipe allows (docs/voice-clips/ONDEMAND.md):
 * spoken order, `<#0.6#>` between parts, ≤ 4 parts and ≤ 240 characters, a question only last; a unit alone may use
 * the whole 480-character prompt.
 */
import type { ClipGenLine, ClipGenSentence, LessonSay, PieceType } from '@gambit/shared';
import { lessonLine } from '@gambit/content';
import {
  PACK_SPLIT,
  VOICE_NEUTRAL_POOL,
  expectedPartText,
  expectedQuizText,
  expectedSentenceText,
  isLessonPoolId,
  lessonQuizKey,
  lessonUnitKey,
  lintLessonText,
  lintText,
  packProblem,
  packPrompt,
  poolKeyOf,
  resolveClipGenLine,
  subjectPieces,
  ttsPartText,
  usesGender,
  usesPiece,
} from '@gambit/core';
import type { ClipLintRule, LessonLintRule, LineRequestProblem, TtsPartRole } from '@gambit/core';
import { jobMilli, promptProblem } from './bridge.ts';
import type { GenJob, UnitPiece } from './bridge.ts';

export type UnitRole = 'whole' | 'lead' | 'tail' | 'frag';

/** One recordable unit: a said part of a lesson sentence, the stage 1–2 quiz options sentence, or a whole catalogue sentence. */
export interface RenderedUnit {
  /** `lessonUnitKey(say)` / `lessonQuizKey(text)` / the catalogue's `line:<poolKey>#<n>` */
  key: string;
  /** the exact expansion — the published `unit.text`, which the stale-take guard compares */
  text: string;
  role: UnitRole;
  kind: 'line' | 'frag';
  /** the manifest pool key of a line (`v3.lead.advice@n`) */
  pool?: string;
  /**
   * every pool the take joins, when more than its own (a catalogue sentence: `CatalogUnit.pools` — a plain wording of a
   * piece / gendered line serves every variant pool, so the web's pool route finds it as it finds a starter-set take)
   */
  pools?: string[];
  mood?: 'calm' | 'excited';
  /** a lead said without a tail: it needs a take that falls (a `ctx: 'cont'` take cannot serve it) */
  alone: boolean;
  /** the words name a piece (a piece variant is less reusable: lower priority) */
  piece: boolean;
}

export type RenderRefusal =
  | 'unknown-pool'
  | 'silent-pool'
  | 'bad-n'
  | 'variant'
  | 'piece-subject'
  | 'tail-alone'
  | 'order'
  | 'text'
  | 'lint'
  | 'quiz'
  | 'nickname'
  /** a generic stand-in (ladder L5) or the settings' voice preview: never recorded on demand */
  | 'excluded';

export type RenderedSentence = { ok: true; text: string; units: RenderedUnit[] } | { ok: false; code: RenderRefusal };

/** Lint rules that make a text unsayable by the TTS (a Latin letter, a digit, a placeholder left, a square, a file). */
const HARD_LINT: ReadonlySet<LessonLintRule> = new Set<LessonLintRule>(['empty', 'latin', 'digit', 'placeholder', 'square', 'file']);

/** The same for a whole catalogue sentence (clip lint rules), and a digit: the TTS would read it its own way. */
const HARD_CLIP_LINT: ReadonlySet<ClipLintRule> = new Set<ClipLintRule>(['empty', 'latin', 'placeholder', 'square', 'selfFeminine']);

type PartResult = { ok: true; unit: RenderedUnit; role: 'whole' | 'lead' | 'tail' } | { ok: false; code: RenderRefusal };

function renderPart(say: LessonSay): PartResult {
  const line = lessonLine(say.pool);
  if (!line) return { ok: false, code: 'unknown-pool' };
  // quiz buttons are recorded only inside the options sentence; `v3.bark.quiet` is a pose, never said
  if (VOICE_NEUTRAL_POOL(line.id)) return { ok: false, code: 'silent-pool' };
  if (!Number.isInteger(say.n) || say.n < 1 || say.n > line.wordings.length) return { ok: false, code: 'bad-n' };
  const w = line.wordings[say.n - 1];
  if (!w) return { ok: false, code: 'bad-n' };
  if (usesPiece(w.t) !== (say.piece !== undefined) || usesGender(w.t) !== (say.g !== undefined)) return { ok: false, code: 'variant' };
  // the king only where it can move or be moved (a victim / target is never the king)
  if (say.piece !== undefined && !subjectPieces(line).includes(say.piece)) return { ok: false, code: 'piece-subject' };
  const text = expectedPartText(say);
  if (text === null) return { ok: false, code: 'text' };
  if (lintLessonText(line, text, say.piece).some((issue) => HARD_LINT.has(issue.rule))) return { ok: false, code: 'lint' };
  return {
    ok: true,
    role: line.role,
    unit: {
      key: lessonUnitKey(say),
      text,
      role: line.role,
      kind: 'line',
      pool: poolKeyOf(line.id, say.piece, say.g),
      ...(w.mood !== undefined ? { mood: w.mood } : {}),
      alone: false,
      piece: say.piece !== undefined,
    },
  };
}

/** Core's reasons a catalogue sentence cannot be recorded → the refusal codes of a request. */
const LINE_REFUSAL: Readonly<Record<LineRequestProblem, RenderRefusal>> = {
  unknown: 'unknown-pool',
  // a lesson id goes through `parts` / `quiz` (its lead / tail / button rules), never as a catalogue sentence
  lesson: 'unknown-pool',
  role: 'order',
  bark: 'silent-pool',
  excluded: 'excluded',
  'bad-n': 'bad-n',
  variant: 'variant',
  piece: 'piece-subject',
  text: 'text',
};

/** One whole catalogue sentence (see the module comment): its catalogue unit, or why it is refused. */
function renderLineUnit(l: ClipGenLine): { ok: true; unit: RenderedUnit } | { ok: false; code: RenderRefusal } {
  const r = resolveClipGenLine(l);
  if (!r.ok) return { ok: false, code: LINE_REFUSAL[r.problem] };
  const { unit } = r;
  // (the catalogue's own lint test keeps every wording clean; this is the gate that makes a wrong one cost nothing)
  if (lintText(unit.text, 'whole').some((issue) => HARD_CLIP_LINT.has(issue.rule)) || /\d/u.test(unit.text)) return { ok: false, code: 'lint' };
  return {
    ok: true,
    unit: {
      key: unit.unitKey,
      text: unit.text,
      role: 'whole',
      kind: 'line',
      pool: unit.pool,
      ...(unit.pools.length > 1 ? { pools: [...unit.pools] } : {}),
      ...(unit.mood !== undefined ? { mood: unit.mood } : {}),
      alone: false,
      piece: unit.piece !== undefined,
    },
  };
}

/** Does `text` contain the nickname as a word (case-insensitive; names of one letter are not checked)? */
export function containsNickname(text: string, nickname: string | null | undefined): boolean {
  const nick = (nickname ?? '').trim().toLowerCase();
  if ([...nick.replace(/[^\p{L}]/gu, '')].length < 2) return false;
  const hay = text.toLowerCase().replaceAll('ё', 'е');
  const needle = nick.replaceAll('ё', 'е');
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : hay.charAt(at - 1);
    const after = hay.charAt(at + needle.length);
    if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) return true;
    from = at + 1;
  }
}

/** Renders one request sentence; see the module comment for what is refused. */
export function renderSentence(sentence: ClipGenSentence, o: { nickname?: string | null } = {}): RenderedSentence {
  let text: string | null;
  let units: RenderedUnit[];
  if ('line' in sentence) {
    const r = renderLineUnit(sentence.line);
    if (!r.ok) return r;
    text = r.unit.text;
    units = [r.unit];
  } else if ('quiz' in sentence) {
    text = expectedQuizText(sentence.quiz);
    if (text === null) return { ok: false, code: 'quiz' };
    units = [{ key: lessonQuizKey(text), text, role: 'frag', kind: 'frag', alone: false, piece: false }];
  } else {
    const parts = sentence.parts.map(renderPart);
    const refused = parts.find((p) => !p.ok);
    if (refused && !refused.ok) return refused;
    const ok = parts.filter((p): p is Extract<PartResult, { ok: true }> => p.ok);
    if (ok.length === 1) {
      const only = ok[0] as Extract<PartResult, { ok: true }>;
      if (only.role === 'tail') return { ok: false, code: 'tail-alone' };
      units = [{ ...only.unit, alone: only.role === 'lead' }];
    } else if (ok.length === 2 && ok[0]?.role === 'lead' && ok[1]?.role === 'tail') {
      units = ok.map((p) => p.unit);
    } else {
      return { ok: false, code: 'order' };
    }
    text = expectedSentenceText(sentence.parts);
    if (text === null) return { ok: false, code: 'text' };
  }
  if (containsNickname(text, o.nickname) || units.some((u) => containsNickname(u.text, o.nickname))) return { ok: false, code: 'nickname' };
  return { ok: true, text, units };
}

const LINE_KEY_RE = /^line:([A-Za-z][A-Za-z0-9_.-]*?)(?:@([pnbrqk]))?(?:\/([mf]))?#(\d{1,3})$/;

/**
 * A unit of a ledgered job rendered again from its key (a paid take 2 after a failed check): valid only while the
 * content still expands the key to the same text. A lead is then said alone («.»): a falling take serves both uses.
 * The namespace picks the renderer: `v3.*` is a lesson part, any other line a whole catalogue sentence.
 */
export function unitFromPiece(piece: Pick<UnitPiece, 'key' | 'text'>): RenderedUnit | null {
  if (piece.key.startsWith('frag:')) {
    return lessonQuizKey(piece.text) === piece.key ? { key: piece.key, text: piece.text, role: 'frag', kind: 'frag', alone: false, piece: false } : null;
  }
  const m = LINE_KEY_RE.exec(piece.key);
  if (!m) return null;
  const variant = { ...(m[2] ? { piece: m[2] as PieceType } : {}), ...(m[3] ? { g: m[3] as 'm' | 'f' } : {}) };
  if (!isLessonPoolId(m[1] as string)) {
    const line = renderLineUnit({ id: m[1] as string, n: Number(m[4]), ...variant });
    return line.ok && line.unit.key === piece.key && line.unit.text === piece.text ? line.unit : null;
  }
  const say: LessonSay = { pool: m[1] as string, n: Number(m[4]), ...variant };
  const part = renderPart(say);
  if (!part.ok || part.unit.key !== piece.key || part.unit.text !== piece.text) return null;
  return { ...part.unit, alone: part.role === 'lead' };
}

/** How a unit is said in its sentence (core `TtsPartRole`, the tools' `PartRole`): a lead alone or before its tail. */
export function partRoleOfUnit(unit: Pick<RenderedUnit, 'role' | 'alone'>): TtsPartRole {
  return unit.role === 'lead' ? (unit.alone ? 'leadAlone' : 'lead') : unit.role;
}

/** What the TTS says for a unit (quotes dropped; a lead alone gets «.», a lead before its tail no end mark). */
export function ttsOfUnit(unit: RenderedUnit): string {
  return ttsPartText(unit.text, partRoleOfUnit(unit));
}

/**
 * Splits groups of units (spoken order; a lead + its tail form one group and stay together) into packs, each one paid
 * job: a group joins the current pack while `packProblem` allows it (≤ 4 parts, ≤ 240 characters, a question only
 * last), otherwise it starts the next one.
 */
export function packUnits(groups: readonly (readonly RenderedUnit[])[]): RenderedUnit[][] {
  const packs: RenderedUnit[][] = [];
  let current: RenderedUnit[] = [];
  const flush = (): void => {
    if (current.length > 0) packs.push(current);
    current = [];
  };
  for (const group of groups) {
    if (group.length === 0) continue;
    const joined = [...current, ...group];
    if (packProblem(joined.map(ttsOfUnit)) === null) {
      current = joined;
      continue;
    }
    flush();
    if (group.length > 1 && packProblem(group.map(ttsOfUnit)) !== null) {
      // a pair too long for one pack: each part becomes its own job (a single unit may use the whole prompt)
      for (const unit of group) packs.push([unit]);
      continue;
    }
    current = [...group];
  }
  flush();
  return packs;
}

/** The on-demand job of one pack (null when its prompt is invalid): pieces in spoken order, a tag split for 2+ parts. */
export function buildJob(units: readonly RenderedUnit[], take: number): { job: GenJob; milli: number } | null {
  if (units.length === 0) return null;
  const parts = units.map(ttsOfUnit);
  const prompt = units.length === 1 ? (parts[0] as string) : packPrompt(parts);
  if (prompt === null || promptProblem(prompt) !== null) return null;
  const pieces: UnitPiece[] = units.map((u) => ({
    key: u.key,
    text: u.text,
    kind: u.kind,
    tier: 'ondemand',
    // how the part was said: the tools' overlay rule checks a lead's end (a rising one is published `ctx: 'cont'`)
    role: partRoleOfUnit(u),
    ...(u.pool !== undefined ? { pool: u.pool } : {}),
    ...(u.pools !== undefined && u.pools.length > 1 ? { pools: [...u.pools] } : {}),
    ...(u.mood !== undefined ? { mood: u.mood } : {}),
  }));
  const job: GenJob = {
    prompt,
    take,
    recipe: units.length === 1 ? 'single' : 'pack',
    pieces,
    ...(units.length > 1 ? { split: { mode: PACK_SPLIT.mode, minSilenceMs: PACK_SPLIT.minSilenceMs } } : {}),
    tier: 'ondemand',
    batch: 'ondemand',
  };
  return { job, milli: jobMilli(prompt) };
}
