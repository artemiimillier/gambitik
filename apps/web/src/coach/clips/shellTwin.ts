/**
 * «Дозапись голоса» for the web's own fixed phrases (the onboarding questions, the new-game wizard, the parent gate,
 * the break nudge, the game's «Поторопись!» and «без подсказок»): each is said as a clip twin of the catalogue's
 * `shell.*` lines (core catalog.game.ru.ts), one line per sentence, whose wordings are exactly the bubble. «Записи»
 * then plays the bubble's own take and, while it has none, asks for exactly those words — like the builders' phrases
 * (G1: no phrase stays unheard). Compiled text (a phrase without a twin) is planned by
 * fragments and can never be recorded on demand.
 *
 * Every sentence is the core (prio 100): the caps never drop one, so the voice says the whole bubble or stays silent.
 * A twin that does not validate (an unknown line) is left out by core `withClip`: the text is compiled.
 */
import { genericLineOf, lineItem, wholeSentence, withClip } from '@gambit/core';
import type { ClipUtterance, CoachEvent } from '@gambit/shared';

/** One sentence of a shell phrase: a `shell.*` line, with the child's gender for a `byGender` one. */
export interface ShellLine {
  line: string;
  g?: 'm' | 'f';
}

/** The twin of whole lines, in order (null: no lines). */
export function shellTwin(event: Pick<CoachEvent, 'kind' | 'pose'>, lines: readonly (string | ShellLine)[]): ClipUtterance | null {
  if (lines.length === 0) return null;
  const sentences = lines.map((l) => (typeof l === 'string' ? wholeSentence(l, 100) : wholeSentence(lineItem(l.line, { g: l.g ?? null }), 100)));
  return { sentences, generic: genericLineOf(event.kind, undefined, event.pose), bark: event.pose };
}

/** Attaches the twin of these lines to the event (only a valid one — see the module comment); returns the event. */
export function withShellTwin<E extends CoachEvent>(event: E, lines: readonly (string | ShellLine)[]): E {
  withClip(event, shellTwin(event, lines));
  return event;
}
