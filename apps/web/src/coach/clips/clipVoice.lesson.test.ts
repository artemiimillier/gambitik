/**
 * «Записи» and a lesson phrase WITH its recorded twin (docs/TEACHING.md §4.5).
 * Core plans nothing for a `say` event (`clipInputOf` → null); here it is mocked to hand the twin over,
 * so the web layer's own guard is exercised: a twin that plays as recorded is voiced, a twin that
 * could only be said with the moment's generic line («Смотри на зелёную стрелку!») is silence instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipUtterance, CoachEvent } from '@gambit/shared';
import { fixtureIndex } from '../../../../../packages/core/src/coach/clips/fixtures.ts';
import { makeEvent } from '../testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from '../voiceDiag.ts';
import type { ClipPlanInfo } from '../voiceTypes.ts';
import { createClipAudio } from './clipAudio.ts';
import { createClipLibrary } from './clipLibrary.ts';
import { createClipVoice } from './clipVoice.ts';
import { FAKE_BASE, FakeAudioContext, createFakeServer } from './testAudio.ts';

vi.mock('@gambit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gambit/core')>();
  return {
    ...actual,
    // mocked: a lesson phrase is planned from its own twin (and still from nothing without one)
    clipInputOf: (event: CoachEvent, opts?: { name?: string }) => (event.say !== undefined && event.clip !== undefined ? event.clip : actual.clipInputOf(event, opts)),
  };
});

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const TWIN: ClipUtterance = {
  generic: 'generic.teachTurn.turn',
  sentences: [{ items: [{ line: 'teach.head.advice' }, { slot: 'nom', san: 'Nf3', fen: START }, { line: 'reason.attack', piece: 'n' }], prio: 100, end: '!' }],
};

function lessonTwin(san: string): CoachEvent {
  return makeEvent({
    kind: 'teachTurn',
    text: 'Конь просится в бой — оттуда он смотрит в центр.',
    bubbleText: 'Конь просится в бой — оттуда он смотрит в центр.',
    pose: 'think',
    pauseClock: true,
    teach: { moment: 'turn', style: 'full', ply: 1, advice: [{ uci: 'g1f3', san, source: 'engine', arrow: 'green' }] },
    clip: TWIN,
    say: [{ pool: 'v3.lead.subject', n: 1, piece: 'n' }],
  });
}

describe('clipVoice — a lesson phrase with its twin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('played as recorded; the SAN guard sending it to the generic line makes it silence', async () => {
    const index = fixtureIndex();
    const server = createFakeServer(index);
    const ctx = new FakeAudioContext({ state: 'running' });
    const audio = createClipAudio({ createContext: () => ctx });
    const voice = createClipVoice({
      audio,
      library: createClipLibrary({ baseUrl: FAKE_BASE, fetch: server.fetch, audio, idle: (cb) => cb() }),
      storage: null,
      rng: () => 0,
      hasUserActivation: () => true,
      gestureTarget: null,
    });
    const plans: ClipPlanInfo[] = [];
    voice.onPlan((p) => plans.push(p));
    await voice.init();

    const recorded = voice.speakEvent(lessonTwin('Nf3'));
    await vi.advanceTimersByTimeAsync(20_000);
    await recorded;
    expect(plans[0]).toMatchObject({ src: 'clip', level: 1 });
    const played = ctx.played.length;
    expect(played).toBeGreaterThan(0);

    // the advice was another move: the twin's «конь на эф три» is refused → the generic line → for a lesson phrase: nothing
    const guarded = voice.speakEvent(lessonTwin('e4'));
    await vi.advanceTimersByTimeAsync(20_000);
    await guarded;
    expect(plans[1]).toMatchObject({ src: 'none', level: 6, clips: 0, heard: '' });
    expect(ctx.played.length).toBe(played);
    expect(voiceDiagRecent().some((e) => e.e === 'clip.lesson' && e.dropped === 'generic')).toBe(true);
  });
});
