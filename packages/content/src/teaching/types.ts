/**
 * The pre-written words of «Учитель» (docs/TEACHING.md §4.2): no generative AI in the child's game — every
 * sentence Гамбитик says is one of these wordings, picked by the lesson engine of @gambit/core
 * (`packages/core/src/coach/lesson/`). The voice never names a square: a wording names the piece and the idea, the
 * board shows where (`cue`).
 *
 * Placeholders are those of the recorded-voice catalogue (`packages/core/src/coach/clips/catalog.ts`), so the lines can
 * be recorded later by `tools/voice-clips`:
 *  - the piece of the line's `subject` — `{конь}` nom, `{коня}` acc, `{коня:gen}` gen, `{конём}` ins, `{Конь}` capitalised;
 *  - agreement with that piece — `{твой}` `{твоего}` `{своего}` `{он}` `{его}` `{ему}`, any pair `{p:ушёл|ушла}`;
 *  - the child's gender (`profile.address`) — `{g:сам|сама}`.
 * One piece per line: «пойдём конём — и съедим слона» is a `lead` (subject 'mover') + a `tail` (subject 'target').
 */
import type { CueKind } from '@gambit/shared';

export type LessonStage = 1 | 2 | 3 | 4 | 5;

/** Whose piece fills the piece placeholders of a line. */
export type LessonSubject =
  | 'mover' // the piece that makes the advised (or the child's) move
  | 'target' // the opponent's piece we attack / capture / trade
  | 'victim' // the child's piece that is under attack or was lost
  | 'defended' // the child's piece a move defends
  | 'attacker' // the opponent's piece that attacks / threatens
  | 'oppPiece'; // the piece the opponent just moved

export interface LessonWording {
  t: string;
  /** stage range (inclusive) this wording is for; absent = the whole range of its pool */
  stages?: readonly [LessonStage, LessonStage];
  /**
   * the sub-cases (`LessonPoolSpec.variants`) this wording is TRUE for; absent = true for every sub-case.
   * E.g. an `answerCheck` tail «— уходим королём в сторону.» is `when: ['king']`.
   */
  when?: readonly string[];
  mood?: 'calm' | 'excited';
}

/** A pool of interchangeable wordings for one situation — the contract between the content and the lesson engine. */
export interface LessonPoolSpec {
  /** 'v3.idea.develop' — dotted, Latin, stable (it is a recording key later) */
  id: string;
  /**
   * 'whole' = a full sentence; 'lead' = a sentence start that ends with the piece or a word, no final punctuation
   * («Давай пойдём {конём}»); 'tail' = the rest of the sentence after a lead, starts with «—», «,» or «:» and ends
   * with «.», «!» or «?» («— оттуда он будет бить центр.»).
   */
  role: 'whole' | 'lead' | 'tail';
  subject?: LessonSubject;
  /** what the board highlights while it is said ([] = nothing; then no «вот эти/этот/сюда» in the words) */
  cue: readonly CueKind[];
  /** stage range the pool is used at; default [1, 5] */
  stages?: readonly [LessonStage, LessonStage];
  /** wordings required for EVERY stage of the range (test gate): 8+ for frequent situations */
  min: number;
  /** when the engine says it (Russian — for the writers and the review) */
  purpose: string;
  /** a mini-lesson or takeaway may hold up to 3 short sentences; everything else 1 (a lead + tail make one) */
  maxSentences?: 1 | 2 | 3;
  /**
   * 'banded' = the words must differ for the younger (stages 1–2) and the older (3–5) child: besides `min` per stage,
   * each band of the pool's range needs its own wordings (tagged `stages` inside the band) — docs/TEACHING.md §2.9.
   * 'shared' (default) = the same words suit every stage.
   */
  stageMode?: 'banded' | 'shared';
  /**
   * sub-cases of the situation the engine tells apart (docs/TEACHING.md §6): every variant needs its own true
   * wordings (`LessonWording.when`), at least `max(2, ceil(min / 2))` per stage.
   */
  variants?: readonly string[];
}

export interface LessonLine extends LessonPoolSpec {
  wordings: readonly LessonWording[];
}

/** Wordings of one family file: pool id → wordings. */
export type LessonWordings = Readonly<Record<string, readonly LessonWording[]>>;
