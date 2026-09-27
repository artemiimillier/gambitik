/**
 * «Дозапись голоса» for the shell's own phrases (so that every line on screen is heard): the wizard, the
 * onboarding questions, the parent gate and the break nudge are clip twins of the catalogue's `shell.*` lines whose
 * wordings are exactly the bubble — so «Записи» plays the bubble's own take and, with none recorded yet, asks for
 * exactly those words (ids only), instead of compiled text planned by fragments, silent and never recordable.
 */
import { describe, expect, it } from 'vitest';
import { MASCOT } from '@gambit/content';
import { clipInputOf, lineRequestOf, lineWordingText, mergeClipIndexes, planClips, twinWordingsOf } from '@gambit/core';
import type { ClipGenLine, CoachEvent } from '@gambit/shared';
import { shellCoachEvent } from './greeting.ts';
import { BULLET_COACH_PHRASE, coachStylePhrase, helpOnlyPhrase, stretchOpponentPhrase, timeStepPhrase } from './newGame.ts';
import { ONBOARDING_ADDRESS_PHRASE, ONBOARDING_NAME_PHRASE, PARENT_GATE_PHRASE, breakPhrase } from './shellPhrases.ts';
import type { ShellPhrase } from './shellPhrases.ts';

/** The twin says exactly the bubble, wording by wording; returns the sentences a first showing asks to record. */
function exactRequests(event: CoachEvent): ClipGenLine[] {
  expect(event.clip, event.text).toBeDefined();
  const sentences = event.clip?.sentences ?? [];
  const wordings = twinWordingsOf(event);
  expect(wordings, event.text).toHaveLength(sentences.length);
  const requests = sentences.map((s, i) => {
    const it = s.items[0];
    const n = wordings[i];
    const l = s.items.length === 1 && it !== undefined && 'line' in it && typeof n === 'number' ? lineRequestOf(it, n) : null;
    expect(l, `${event.text} #${i}`).not.toBeNull();
    return l as ClipGenLine;
  });
  expect(requests.map((l) => lineWordingText(l)).join(' ')).toBe(event.text);
  return requests;
}

/** Nothing recorded yet: silent, and the plan names exactly the bubble's wordings for recording. */
function asksForItself(event: CoachEvent): void {
  const requests = exactRequests(event);
  const plan = planClips(clipInputOf(event), mergeClipIndexes(null, null), { rng: () => 0.5, jitter: false, wordings: twinWordingsOf(event) });
  expect(plan.clips).toEqual([]);
  expect(plan.lineMissing).toEqual(requests);
}

const WIZARD_TIMES = ['training', 'rapid10', 'blitz5', 'bullet1'] as const;

describe('the shell phrases are clip twins that say exactly their bubble', () => {
  it('the wizard: the time step, each step-3 phrase for a boy and a girl', () => {
    asksForItself(shellCoachEvent(timeStepPhrase()));
    expect(exactRequests(shellCoachEvent(timeStepPhrase()))).toEqual([
      { id: 'shell.wizard.time', n: 1 },
      { id: 'shell.wizard.teachTimes', n: 1 },
    ]);
    for (const tc of WIZARD_TIMES) {
      for (const address of ['m', 'f'] as const) asksForItself(shellCoachEvent(coachStylePhrase(tc, address)));
    }
    expect(exactRequests(shellCoachEvent(coachStylePhrase('training', 'f')))).toEqual([
      { id: 'shell.wizard.teacher', n: 1 },
      { id: 'shell.wizard.self', n: 1, g: 'f' },
    ]);
    for (const address of ['m', 'f'] as const) asksForItself(shellCoachEvent(helpOnlyPhrase(address)));
    expect(exactRequests(shellCoachEvent(helpOnlyPhrase('f')))).toEqual([{ id: 'shell.wizard.help', n: 1, g: 'f' }]);
    expect(coachStylePhrase('training', 'f').text).toMatch(/подумаешь сама/);
    expect(coachStylePhrase('training').text).toMatch(/подумаешь сам,/);
    expect(coachStylePhrase('bullet1', 'f').text).toBe(BULLET_COACH_PHRASE);
    // the bullet step and the time step share the teaching-times sentence: one recording serves both
    expect(exactRequests(shellCoachEvent(coachStylePhrase('bullet1'))).at(-1)).toEqual({ id: 'shell.wizard.teachTimes', n: 1 });
  });

  it('the onboarding questions, the parent gate, every break line', () => {
    const phrases: ShellPhrase[] = [ONBOARDING_NAME_PHRASE, ONBOARDING_ADDRESS_PHRASE, PARENT_GATE_PHRASE];
    for (const phrase of phrases) asksForItself(shellCoachEvent(phrase));
    const breaks = MASCOT.phrases.break.map((_, i, all) => breakPhrase(() => (i + 0.5) / all.length));
    expect(breaks.map((p) => p.text)).toEqual([...MASCOT.phrases.break]);
    breaks.forEach((phrase, i) => {
      asksForItself(shellCoachEvent(phrase));
      expect(exactRequests(shellCoachEvent(phrase))).toEqual([{ id: 'shell.break', n: i + 1 }]);
    });
  });

  it('a phrase with a name in it (the strong opponent) has no twin: it is never recorded', () => {
    expect(shellCoachEvent(stretchOpponentPhrase('Дима')).clip).toBeUndefined();
  });
});
