/**
 * «Дозапись голоса» — how recordable parts become paid jobs under the «pack» recipe (docs/voice-clips/ONDEMAND.md; the rules are core
 * `packProblem`: ≤ 4 parts, ≤ 240 characters with the tags, at most one question and only last). Pure; shared by the
 * operator's prefetch plan and the free simulation (tools/teaching/voice.ts), priced at the SPEC rate (`jobMilli`).
 *
 *  - `packInOrder`: a request's uncovered parts in spoken order, consecutive parts per job — what the server does with
 *    one utterance's missing sentences;
 *  - `FirstFitPacker`: the prefetch, any order — each part goes into the first job it still fits (a question last),
 *    and the caller sees what a part would add to the price before taking it.
 * The options sentence of stages 1–2 (a `frag`) is always a job of its own (it is recorded alone, docs/voice-clips/ONDEMAND.md).
 */
import { PACK_TAG, packProblem } from '../../packages/core/src/coach/clips/tts.ts';
import { jobMilli } from './cost.ts';

export interface PackPart {
  /** the TTS text of the part (core `ttsPartText`) */
  tts: string;
  /** the options sentence: recorded alone */
  frag?: boolean;
}

export interface PackedJob<P extends PackPart> {
  parts: P[];
  prompt: string;
  milli: number;
}

const isQuestion = (tts: string): boolean => /\?[!.…]*$/u.test(tts.trim());

function jobOf<P extends PackPart>(parts: P[]): PackedJob<P> {
  const prompt = parts.map((p) => p.tts).join(PACK_TAG);
  return { parts, prompt, milli: jobMilli(prompt) };
}

/** Consecutive parts per job, in spoken order (a part that would break the pack starts the next job). */
export function packInOrder<P extends PackPart>(parts: readonly P[]): PackedJob<P>[] {
  const jobs: PackedJob<P>[] = [];
  let cur: P[] = [];
  const flush = (): void => {
    if (cur.length > 0) jobs.push(jobOf(cur));
    cur = [];
  };
  for (const part of parts) {
    if (part.frag) {
      flush();
      jobs.push(jobOf([part]));
      continue;
    }
    if (cur.length > 0 && packProblem([...cur, part].map((p) => p.tts)) !== null) flush();
    cur.push(part);
  }
  flush();
  return jobs;
}

/** The parts of one job in an order the pack allows: statements first, the (single) question last. */
function arranged<P extends PackPart>(parts: readonly P[]): P[] {
  return [...parts.filter((p) => !isQuestion(p.tts)), ...parts.filter((p) => isQuestion(p.tts))];
}

/** First-fit packing with a running SPEC price (the prefetch plan: take a part only while the budget allows it). */
export class FirstFitPacker<P extends PackPart> {
  private readonly bins: P[][] = [];
  private readonly lone: P[][] = [];
  milli = 0;

  /** Where `part` would go and what it would add to the price. */
  private place(part: P): { bin: number; delta: number } {
    if (part.frag) return { bin: -1, delta: jobMilli(part.tts) };
    for (let i = 0; i < this.bins.length; i++) {
      const next = arranged([...this.bins[i]!, part]);
      if (packProblem(next.map((p) => p.tts)) !== null) continue;
      return { bin: i, delta: jobOf(next).milli - jobOf(arranged(this.bins[i]!)).milli };
    }
    return { bin: -1, delta: jobMilli(part.tts) };
  }

  /** The extra price of `part` (SPEC milli-credits), without taking it. */
  cost(part: P): number {
    return this.place(part).delta;
  }

  /** Takes `part` when the total stays ≤ `maxMilli`; false (nothing changed) otherwise. */
  add(part: P, maxMilli = Number.POSITIVE_INFINITY): boolean {
    const { bin, delta } = this.place(part);
    if (this.milli + delta > maxMilli) return false;
    this.milli += delta;
    if (part.frag) this.lone.push([part]);
    else if (bin >= 0) this.bins[bin]!.push(part);
    else this.bins.push([part]);
    return true;
  }

  jobs(): PackedJob<P>[] {
    return [...this.bins.map((b) => jobOf(arranged(b))), ...this.lone.map((b) => jobOf(b))];
  }
}
