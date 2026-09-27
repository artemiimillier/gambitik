/**
 * The dock in «Записи» (docs/voice-clips/SPEC.md §8.2, §11): no microphone UI at all; in a game a round «Спроси» button
 * with big chips (the lesson model: with every voice and with the sound off too); none in an exam or while a quiz card is
 * open; «Не слышно? Нажми сюда» kept; the parent's status line names the library.
 * Server render (no DOM): the store's initial state is the patch.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { askChipsFor } from './clips/clipAsk.ts';
import { createCoachController } from './coachController.ts';
import { INITIAL_COACH_STATE } from './coachStore.ts';
import type { CoachState, CoachStore } from './coachStore.ts';
import { MascotDock } from './MascotDock.tsx';
import { createSilentVoice } from './silentVoice.ts';
import { createMemoryStorage, makeHealth } from './testUtils.ts';

function render(patch: Partial<CoachState>, opts: { askOpen?: boolean } = {}): string {
  const store: CoachStore = create<CoachState>()(() => ({ ...INITIAL_COACH_STATE, ...patch }));
  const coach = createCoachController({ store, getHealth: () => Promise.resolve(makeHealth(false)), createVoice: () => createSilentVoice(), getStorage: () => createMemoryStorage() });
  return renderToStaticMarkup(<MascotDock coach={coach} store={store} initialAskOpen={opts.askOpen === true} />);
}

const CLIPS: Partial<CoachState> = {
  voiceKind: 'clips',
  ready: true,
  hasToolHost: true,
  hintAvailable: true,
  coachStyle: 'teacher',
  voiceModel: 'giselle-mm1',
  clipLibrary: { voiceKey: 'giselle-mm1', libraryVersion: 3, phrases: 1240, units: 2100 },
};

describe('<MascotDock/> — «Записи»', () => {
  it('no microphone UI: no «Поговорить», no mic notes; a round «Спроси» button in a game', () => {
    const html = render(CLIPS);
    expect(html).not.toContain('gmb-talk');
    expect(html).not.toContain('Я в наушниках');
    expect(html).not.toContain('Микрофон');
    expect(html).toMatch(/<button[^>]*class="gmb-round gmb-round-ask"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/<span class="gmb-round-caption">Спроси<\/span>/);
    // the hint button stays («Совет» for the teacher)
    expect(html).toMatch(/<span class="gmb-round-caption">Совет<\/span>/);
    // closed: no chips yet
    expect(html).not.toContain('gmb-ask-chip');
  });

  it('the chips: «Почему так?», «Что задумал соперник?», «Совет» / «Подсказка», «Повтори»', () => {
    const teacher = render(CLIPS, { askOpen: true });
    expect(teacher).toContain('aria-label="Спроси Гамбитика"');
    const labels = [...teacher.matchAll(/<span class="gmb-ask-label">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Почему так?', 'Что задумал соперник?', 'Совет', 'Повтори']);
    const helper = render({ ...CLIPS, coachStyle: 'helper' }, { askOpen: true });
    expect([...helper.matchAll(/<span class="gmb-ask-label">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['Почему так?', 'Что задумал соперник?', 'Подсказка', 'Повтори']);
    // a game without hints: no hint chip
    expect(render({ ...CLIPS, hintAvailable: false }, { askOpen: true })).not.toContain('data-ask="hint"');
  });

  it('none in an exam, outside a game, before the first tap, or while the game\'s quiz card is open', () => {
    for (const patch of [{ coachStyle: 'exam' as const }, { hasToolHost: false }, { needsUserGesture: true }, { askSuppressed: true }]) {
      const html = render({ ...CLIPS, ...patch }, { askOpen: true });
      expect(html).not.toContain('gmb-round-ask');
      expect(html).not.toContain('gmb-ask-chip');
    }
  });

  it('the lesson model (docs/TEACHING.md §4.4): the chips stay with the sound off and with every other voice — the answers are in the bubble', () => {
    for (const patch of [{ muted: true }, { voiceKind: 'browser-tts' as const }, { voiceKind: 'silent' as const }, { voiceKind: 'silent' as const, muted: true }]) {
      const html = render({ ...CLIPS, ...patch }, { askOpen: true });
      expect(html).toMatch(/<button[^>]*class="gmb-round gmb-round-ask"/);
      expect([...html.matchAll(/<span class="gmb-ask-label">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['Почему так?', 'Что задумал соперник?', 'Совет', 'Повтори']);
    }
  });

  it('«Не слышно? Нажми сюда» is kept for the recorded voice', () => {
    expect(render({ ...CLIPS, hearingCheck: true })).toContain('Не слышно? Нажми сюда');
    expect(render({ ...CLIPS, hearingCheck: true, voiceKind: 'browser-tts' })).not.toContain('Не слышно? Нажми сюда');
  });

  it('the parent\'s status line names the recorded voice, its library and «без микрофона»', () => {
    const html = render(CLIPS);
    expect(html).toContain('Голос: записанный голос (бесплатно) · 1 240 фраз, версия 3 · без микрофона.');
  });

  it('askChipsFor: an exam has no chips at all', () => {
    expect(askChipsFor({ coachStyle: 'exam', hintAvailable: true })).toEqual([]);
    expect(askChipsFor({ coachStyle: null, hintAvailable: true }).map((c) => c.kind)).toEqual(['why', 'opponent', 'hint', 'repeat']);
  });
});
