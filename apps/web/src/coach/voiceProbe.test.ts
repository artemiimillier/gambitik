import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubBrowser(options: { webdriver: boolean; optIn: boolean }): { window: Record<string, unknown> } {
  const fakeWindow: Record<string, unknown> = {
    localStorage: { getItem: (key: string) => (options.optIn && key === 'gambit.e2eVoice' ? 'on' : null) },
    location: { hash: '', search: '' },
  };
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('navigator', { webdriver: options.webdriver });
  return { window: fakeWindow };
}

describe('voice probe', () => {
  it('does not exist for a real child, nor for an ordinary (silent) automation run', async () => {
    for (const setup of [
      { webdriver: false, optIn: false },
      { webdriver: false, optIn: true },
      { webdriver: true, optIn: false },
    ]) {
      vi.resetModules();
      const { window: fakeWindow } = stubBrowser(setup);
      const probe = await import('./voiceProbe.ts');
      expect(probe.voiceProbeEnabled()).toBe(false);
      probe.probeVoice('say', { text: 'Привет' });
      probe.probeWireEvent('in', { type: 'session.started' });
      expect(fakeWindow.__gambitVoiceProbe).toBeUndefined();
    }
  });

  it('logs types, clipped texts and API errors for an automation run that opted into real voice', async () => {
    const { window: fakeWindow } = stubBrowser({ webdriver: true, optIn: true });
    const probe = await import('./voiceProbe.ts');
    expect(probe.voiceProbeEnabled()).toBe(true);

    probe.probeVoice('say', { text: 'я'.repeat(2000) });
    probe.probeWireEvent('in', { type: 'session.output_transcript.delta', delta: 'секрет' });
    probe.probeWireEvent('in', { type: 'error', error: { code: 'invalid_event', message: 'unknown event', param: 'type' } });

    const log = (fakeWindow.__gambitVoiceProbe as { log: Record<string, unknown>[] }).log;
    expect(log.map((entry) => entry.type)).toEqual(['say', 'wire.in', 'wire.in']);
    expect(String(log[0]?.text).length).toBe(1400);
    // payloads of ordinary events are not copied — only their type
    expect(log[1]).toMatchObject({ event: 'session.output_transcript.delta' });
    expect(JSON.stringify(log[1])).not.toContain('секрет');
    expect(log[2]).toMatchObject({ event: 'error', code: 'invalid_event', message: 'unknown event', param: 'type' });

    // the store watcher reports changes only
    let listener: (state: object) => void = () => undefined;
    const state = { voiceKind: 'openai-live', voiceConnected: false, speaking: false };
    probe.installVoiceProbe({ onTranscript: (cb) => (cb('child', 'Подскажи ход'), () => undefined) }, { getState: () => state, subscribe: (l) => ((listener = l), () => undefined) });
    listener({ ...state, voiceConnected: true });
    const tail = log.slice(3).map((entry) => `${String(entry.type)}:${String(entry.field ?? entry.who)}=${String(entry.value ?? entry.text)}`);
    expect(tail).toContain('store:voiceKind=openai-live');
    expect(tail).toContain('transcript:child=Подскажи ход');
    expect(tail.at(-1)).toBe('store:voiceConnected=true');
  });
});
