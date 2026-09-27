/**
 * The shell's fixed phrases outside the wizard (the wizard's are in ./newGame.ts): the onboarding questions, the parent
 * gate and the break nudge. Each names the catalogue's `shell.*` lines that say exactly its text (one per sentence), so
 * «Записи» says it from its recording and records it on first use («Дозапись голоса», ../coach/clips/shellTwin.ts).
 * shellPhrases.test.ts keeps every text equal to its lines' wordings.
 */
import type { CoachEvent } from '@gambit/shared';
import type { ShellLine } from '../coach/clips/shellTwin.ts';
import { breakLine } from './sessionNudge.ts';

export interface ShellPhrase extends Pick<CoachEvent, 'kind' | 'priority' | 'pose' | 'text'> {
  lines: readonly (string | ShellLine)[];
}

/** Onboarding, step 1: said as the first hello of a new child. */
export const ONBOARDING_NAME_PHRASE: ShellPhrase = {
  kind: 'greeting',
  priority: 1,
  pose: 'wave',
  text: 'Привет! Я Гамбитик, твой шахматный тренер. А как тебя зовут?',
  lines: ['shell.onboard.name'],
};

/** Onboarding, step 2. */
export const ONBOARDING_ADDRESS_PHRASE: ShellPhrase = {
  kind: 'answer',
  priority: 1,
  pose: 'talk',
  text: 'Приятно познакомиться! Скажи, ты мальчик или девочка?',
  lines: ['shell.onboard.address'],
};

/** The parent gate, said to the child. */
export const PARENT_GATE_PHRASE: ShellPhrase = {
  kind: 'answer',
  priority: 1,
  pose: 'talk',
  text: 'Это страница для взрослых. Позови маму или папу!',
  lines: ['shell.parentGate'],
};

/** A long session: one of the mascot's break lines — each a wording of `shell.break` (the planner finds which by its words). */
export function breakPhrase(rng: () => number = Math.random): ShellPhrase {
  return { kind: 'encourage', priority: 1, pose: 'talk', text: breakLine(rng), lines: ['shell.break'] };
}
