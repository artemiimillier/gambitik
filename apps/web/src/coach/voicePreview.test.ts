/**
 * «Послушать» (Settings): one short PAID line in the voice the parent is about to pick. Fakes only: no session, no sound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeVoice } from './testUtils.ts';
import type { FakeVoice } from './testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';
import { previewKindFor, previewVoice, VOICE_NOTES_RU, VOICE_PREVIEW_COST_RU, VOICE_PREVIEW_LINE_RU, voiceButtonLabel, voicePreviewMessage } from './voicePreview.ts';
import type { PreviewLayer } from './voicePreview.ts';
import type { OpenAiVoiceKind } from './voiceTypes.ts';

function fakeLayer(): FakeVoice & PreviewLayer {
  return createFakeVoice({ kind: 'openai-live', conversational: true }) as FakeVoice & PreviewLayer;
}

describe('«Послушать» — hear a voice before picking it', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('builds a layer for exactly that voice, never asks for the microphone, says one line, closes the paid session', async () => {
    const layer = fakeLayer();
    const built: [OpenAiVoiceKind, string][] = [];
    const pending = previewVoice('cedar', 'openai-live', {
      isAutomated: () => false,
      createLayer: (kind, voice) => {
        built.push([kind, voice]);
        return layer;
      },
      tailMs: 500,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(built).toEqual([['openai-live', 'cedar']]);
    expect(layer.micCalls.modes).toEqual(['push']);
    expect(layer.micCalls.echoGuard).toEqual([false]);
    expect(layer.spoken).toEqual([{ text: VOICE_PREVIEW_LINE_RU, interrupt: false }]);
    expect(layer.listenCalls.start).toBe(0);
    layer.finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe('spoken');
    expect(layer.disposed).toBe(true);
    expect(voiceDiagRecent().find((entry) => entry.e === 'voice.preview')).toMatchObject({ voice: 'cedar', kind: 'openai-live', outcome: 'spoken' });
  });

  it('IMPOSSIBLE under automation: nothing is built, nothing requested', async () => {
    const createLayer = vi.fn(() => fakeLayer());
    expect(await previewVoice('cedar', 'openai-live', { isAutomated: () => true, createLayer })).toBe('automation');
    expect(createLayer).not.toHaveBeenCalled();
    // the default guard is the real `navigator.webdriver` check (the test runner is no browser: not automated, but no layer either)
    expect(voicePreviewMessage('cedar', 'automation')).toMatch(/автоматическом режиме/);
  });

  it('no sound: a session that opened without speech is «silent», no session is «failed»; a stuck one is cut off and closed', async () => {
    let disposed = 0;
    const quiet = (connects: boolean): PreviewLayer => ({
      kind: 'openai-live',
      init: () => Promise.resolve(),
      speak: () => Promise.resolve(),
      stop: () => undefined,
      onLevel: () => () => undefined,
      // the page never heard his audio start
      onSpeakingChange: () => () => undefined,
      onConnectedChange(cb) {
        if (connects) cb(true);
        return () => undefined;
      },
      dispose() {
        disposed += 1;
      },
    });
    const opened = previewVoice('ash', 'openai-live', { isAutomated: () => false, createLayer: () => quiet(true), tailMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await opened).toBe('silent');
    expect(voicePreviewMessage('ash', 'silent')).toMatch(/Проверить звук/);

    const refused = previewVoice('ash', 'openai-realtime', { isAutomated: () => false, createLayer: () => quiet(false), tailMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await refused).toBe('failed');
    expect(disposed).toBe(2);

    const broken = createFakeVoice({ kind: 'openai-live', conversational: true, hangInit: true }) as FakeVoice & PreviewLayer;
    const pendingBroken = previewVoice('ash', 'openai-live', { isAutomated: () => false, createLayer: () => broken, maxMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pendingBroken).toBe('failed');
    expect(broken.disposed).toBe(true);
  });

  it('picks Live when the server has it, else Realtime if that model knows the voice', () => {
    expect(previewKindFor({ live: true, realtime: true }, { live: true, realtime: true })).toBe('openai-live');
    expect(previewKindFor({ live: true, realtime: true }, { live: false, realtime: true })).toBe('openai-realtime');
    expect(previewKindFor({ live: true, realtime: false }, { live: false, realtime: true })).toBeNull();
    expect(previewKindFor({ live: true, realtime: true }, { live: false, realtime: false })).toBeNull();
  });

  it('parent-facing texts: the cost is said up front; notes only where OpenAI describes the voice', () => {
    expect(VOICE_PREVIEW_COST_RU).toMatch(/Платно/);
    expect(VOICE_PREVIEW_COST_RU).toMatch(/цент/);
    expect(voiceButtonLabel({ id: 'cedar', realtime: true })).toBe('cedar · мужской, спокойный');
    expect(voiceButtonLabel({ id: 'gleam', realtime: false })).toBe('gleam · женский · только Live');
    expect(voiceButtonLabel({ id: 'alloy', realtime: true })).toBe('alloy');
    expect(Object.keys(VOICE_NOTES_RU)).toEqual(expect.arrayContaining(['marin', 'coral', 'shimmer', 'cedar']));
    expect(VOICE_PREVIEW_LINE_RU).not.toMatch(/[A-Za-z]/);
    for (const outcome of ['playing', 'spoken', 'silent', 'failed'] as const) expect(voicePreviewMessage('cedar', outcome)).toMatch(/[а-яё]/i);
  });
});
