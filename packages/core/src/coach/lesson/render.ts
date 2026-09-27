/**
 * Sentences of «Учитель» (docs/TEACHING.md §2.2): an utterance is 1–3 sentences; a sentence is a whole wording or
 * a lead + a tail («Давай пойдём конём» + «— оттуда он будет бить центр.»). Every word comes from the phrase book;
 * this module only joins, capitalises, records what was said (`say`), which parts make each sentence (`saySentences`,
 * for the recorded voice) and ties each sentence's board cues to it.
 */
import type { CueKind, LessonCue, LessonSay, LessonSaySentence } from '@gambit/shared';
import { capitalize } from '../phrase.ts';
import type { Picked } from './book.ts';
import { resolveCues } from './cues.ts';
import type { CueFacts } from './cues.ts';

export interface SentenceSpec {
  /** 1 (whole) or 2 (lead + tail) picked wordings */
  parts: readonly Picked[];
  /** the facts its cues are resolved from */
  facts?: CueFacts | null;
  /** extra cue kinds on top of the parts' own (e.g. the move arrow of a whole «рокировка» line) */
  cues?: readonly CueKind[];
  /** drop the parts' own cues (e.g. a reply that must not re-show the answer) */
  noPartCues?: boolean;
}

export interface Rendered {
  text: string;
  sentences: string[];
  say: LessonSay[];
  /**
   * sentence i of `sentences` and the `say` indexes it is made of (a whole wording, a lead, a lead + its tail; the
   * composed quiz options sentence carries `quiz` instead) — what the recorded voice plays and records («Дозапись голоса»)
   */
  saySentences: LessonSaySentence[];
  cues: LessonCue[];
}

/** «Давай пойдём конём» + «— и съедим слона.» → «Давай пойдём конём — и съедим слона.» */
export function joinSentence(parts: readonly string[]): string {
  let out = '';
  for (const raw of parts) {
    const p = raw.trim();
    if (p === '') continue;
    if (out === '') out = p;
    else if (/^[,:;]/u.test(p)) out = `${out}${p}`;
    else out = `${out} ${p}`;
  }
  out = out.replace(/\s+/g, ' ').replace(/\s+([,.!?…:;])/g, '$1').trim();
  if (out !== '' && !/[.!?…]$/u.test(out)) out += '.';
  return capitalize(out);
}

function sayOf(p: Picked): LessonSay {
  return { pool: p.pool, n: p.n, ...(p.piece ? { piece: p.piece } : {}), ...(p.g ? { g: p.g } : {}) };
}

/** Joins sentences into one utterance; sentence i's cues carry `sentence: i`. Empty sentences are skipped. */
export function renderUtterance(specs: readonly (SentenceSpec | null | undefined)[]): Rendered {
  const sentences: string[] = [];
  const say: LessonSay[] = [];
  const saySentences: LessonSaySentence[] = [];
  const cues: LessonCue[] = [];
  for (const spec of specs) {
    if (!spec || spec.parts.length === 0) continue;
    const text = joinSentence(spec.parts.map((p) => p.text));
    if (text === '') continue;
    const index = sentences.length;
    sentences.push(text);
    saySentences.push({ text, parts: spec.parts.map((_, k) => say.length + k) });
    say.push(...spec.parts.map(sayOf));
    const kinds = [...(spec.noPartCues ? [] : spec.parts.flatMap((p) => p.line.cue)), ...(spec.cues ?? [])];
    if (spec.facts && kinds.length > 0) cues.push(...resolveCues(kinds, spec.facts, index));
  }
  return { text: sentences.join(' '), sentences, say, saySentences, cues };
}
