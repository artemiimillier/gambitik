/**
 * «Дозапись голоса»: what a lesson unit sends to the TTS, and the «pack» recipe that records a request's missing
 * parts in ONE paid job (measured on the starter set's masters: every `<#0.6#>` pause was ≥ 770 ms, every natural pause
 * ≤ 610 ms, so a 700 ms tag split never cuts inside a part; `<#0.3#>` pauses overlap natural colons and are not used).
 *
 * The prompt is the bubble's text for that part, exactly — ё, «—», «:», «…» and capitals included — with three
 * exceptions: «» / " quotes are dropped (never spoken, untested, they cost characters), a lead said alone gets the «.»
 * its bubble shows, and parts are joined by the pause tag. The unit's manifest `text` keeps the exact expansion (quotes
 * too): that is what the stale-take guard compares. Shared by the server (on demand) and the tools (the prefetch).
 */
import { capitalize } from '../phrase.ts';

/**
 * How a part is said: 'whole' a whole wording · 'lead' a lead right before its tail (no end mark: the tag makes the
 * fall) · 'leadAlone' a lead said on its own (gets «.») · 'tail' «— …» · 'frag' the quiz options sentence.
 */
export type TtsPartRole = 'whole' | 'lead' | 'leadAlone' | 'tail' | 'frag';

/** The pause tag between the parts of a pack (≈ 770–1170 ms of silence, median 920). */
export const PACK_TAG = '<#0.6#>';
/** How a pack master is cut: at tag silences of at least 700 ms; a wrong piece count re-queues the job (never a silent mis-cut). */
export const PACK_SPLIT = { mode: 'tags', minSilenceMs: 700 } as const;
/** At most this many parts in one pack … */
export const PACK_MAX_PARTS = 4;
/** … and this many characters (Unicode code points, tags included): ≤ 5 price blocks, i.e. ≤ 0.75 credits a job. */
export const PACK_MAX_CHARS = 240;

const QUOTES_RE = /[«»„“”"]/gu;

/** The TTS text of one part (see the module comment). */
export function ttsPartText(text: string, role: TtsPartRole): string {
  let t = text
    .replace(QUOTES_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?…:;])/g, '$1')
    .trim();
  if (t === '') return t;
  // a sentence starts capitalised in the bubble (joinSentence); a tail «— …» and the options sentence are said as written
  if (role === 'whole' || role === 'lead' || role === 'leadAlone') t = capitalize(t);
  if ((role === 'whole' || role === 'leadAlone') && !/[.!?…]$/u.test(t)) t += '.';
  return t;
}

/** Why parts cannot be one pack. */
export type PackProblem = 'empty' | 'blank-part' | 'tag-inside' | 'too-many' | 'too-long' | 'question-not-last';

const isQuestion = (part: string): boolean => /\?[!.…]*$/u.test(part.trim());

/**
 * The first rule the parts (TTS texts in spoken order, from `ttsPartText`) break, or null: 1..PACK_MAX_PARTS non-blank
 * parts without a tag of their own, at most one question and only as the last part (a question's rising end must not
 * run into the next part), the whole prompt ≤ PACK_MAX_CHARS.
 */
export function packProblem(parts: readonly string[]): PackProblem | null {
  if (parts.length === 0) return 'empty';
  if (parts.some((p) => p.trim() === '')) return 'blank-part';
  if (parts.some((p) => p.includes('<#'))) return 'tag-inside';
  if (parts.length > PACK_MAX_PARTS) return 'too-many';
  if (parts.slice(0, -1).some(isQuestion)) return 'question-not-last';
  if ([...parts.join(PACK_TAG)].length > PACK_MAX_CHARS) return 'too-long';
  return null;
}

/** The prompt of one pack job: the parts joined by `PACK_TAG`; null when `packProblem` finds a problem (split the request). */
export function packPrompt(parts: readonly string[]): string | null {
  return packProblem(parts) === null ? parts.join(PACK_TAG) : null;
}
