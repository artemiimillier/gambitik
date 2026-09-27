/**
 * Building a CoachEvent of «Учитель» from rendered sentences (docs/TEACHING.md §4.1): the text is said as is
 * (no squares, no Latin — it comes from the checked content), the bubble shows the same words, the board shows the cues
 * of the utterance on today's primitives (./board.ts) merged with the given arrows; no `brief` (the live voice, when
 * enabled, reads `text`), no `clip`: the recorded voice plays the lesson by its units — `say` and `saySentences` (which parts
 * make each sentence, «Дозапись голоса»; core clips/lessonPlan.ts) — or stays silent (§4.5).
 */
import type { BoardAnnotations, CoachEvent, CoachEventKind, MascotPose, StudentProfile, TeachSummary } from '@gambit/shared';
import { cuesToBoard } from './board.ts';
import type { Rendered } from './render.ts';

let counter = 0;

/** The child's stage for the content (1..5; stages 6+ read stage-5 words). */
export function lessonStage(profile: Pick<StudentProfile, 'stage'>): 1 | 2 | 3 | 4 | 5 {
  const s = Math.round(Number(profile.stage) || 1);
  return Math.min(5, Math.max(1, s)) as 1 | 2 | 3 | 4 | 5;
}

/** The child's gender for {g:…}. */
export function lessonGender(profile: Pick<StudentProfile, 'address'>): 'm' | 'f' {
  return profile.address === 'f' ? 'f' : 'm';
}

export interface LessonEventSpec {
  kind: CoachEventKind;
  rendered: Rendered;
  pose: MascotPose;
  priority?: 0 | 1 | 2;
  pauseClock?: boolean;
  teach?: TeachSummary;
  /** arrows / highlights the event must show besides its cues (the advice arrows) */
  board?: BoardAnnotations | null;
  /** do not project the cues onto the board (e.g. a quiz must not show its answer) */
  noCueBoard?: boolean;
}

/** A lesson CoachEvent: `text` = `bubbleText` = the rendered words, `say` = the wordings, `saySentences`, `cues`, `board`. */
export function lessonEvent(spec: LessonEventSpec): CoachEvent {
  counter = (counter + 1) % 1_000_000;
  const board = spec.noCueBoard ? (spec.board ?? { arrows: [], highlights: [] }) : cuesToBoard(spec.rendered.cues, { base: spec.board ?? null });
  const hasBoard = board.arrows.length > 0 || board.highlights.length > 0;
  return {
    id: `${spec.kind}-v3-${Date.now().toString(36)}-${counter.toString(36)}`,
    kind: spec.kind,
    priority: spec.priority ?? 1,
    text: spec.rendered.text,
    bubbleText: spec.rendered.text,
    pose: spec.pose,
    pauseClock: spec.pauseClock ?? true,
    ...(hasBoard ? { board } : {}),
    ...(spec.teach ? { teach: spec.teach } : {}),
    ...(spec.rendered.cues.length > 0 ? { cues: spec.rendered.cues } : {}),
    say: spec.rendered.say,
    saySentences: spec.rendered.saySentences,
  };
}
