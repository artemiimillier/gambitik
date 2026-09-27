import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MIC_CONSTRAINTS } from './rtcSession.ts';
import { CHIME_SAMPLE_RATE, checkMicrophone, createChimeWav, MIC_CHECK_MS, MIC_HEARD_RMS, playSoundCheck } from './soundCheck.ts';
import type { ChimeElement, MicMeterContext, MicStream } from './soundCheck.ts';
import { MIC_CHECK_HINT, MIC_CHECK_TITLE, MIC_HEARD_TEXT, micCheckMessage, SOUND_CHECK_TITLE, SoundCheckButton, soundCheckMessage } from './SoundCheckButton.tsx';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';

function fakeElement(play: () => Promise<void>): ChimeElement & { emit(type: 'ended' | 'error'): void; removed: boolean } {
  const listeners = new Map<string, () => void>();
  const el = {
    src: '',
    preload: '',
    muted: false,
    volume: 1,
    currentTime: 0,
    paused: true,
    removed: false,
    style: { display: '' },
    play,
    pause() {
      el.paused = true;
    },
    remove() {
      el.removed = true;
    },
    addEventListener(type: 'ended' | 'error', listener: () => void) {
      listeners.set(type, listener);
    },
    emit(type: 'ended' | 'error') {
      listeners.get(type)?.();
    },
  };
  return el;
}

describe('«Проверить звук» — the parent\'s sound check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('builds a valid 16-bit mono WAV that is not silent', () => {
    const wav = createChimeWav();
    const text = (from: number, to: number) => String.fromCharCode(...wav.slice(from, to));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 12)).toBe('WAVE');
    expect(text(36, 40)).toBe('data');
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(CHIME_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(wav.length - 44);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
    expect(peak).toBeGreaterThan(3000);
    expect(peak).toBeLessThan(32_767);
  });

  it('plays it through a hidden <audio> element and reports «played» when it ran to the end', async () => {
    const el = fakeElement(() => {
      el.paused = false;
      return Promise.resolve();
    });
    const revoked: string[] = [];
    const pending = playSoundCheck({ createElement: () => el, createUrl: () => 'blob:chime', revokeUrl: (url) => revoked.push(url) });
    await vi.advanceTimersByTimeAsync(0);
    expect(el.src).toBe('blob:chime');
    expect(el.style.display).toBe('none');
    el.emit('ended');
    const result = await pending;
    expect(result).toMatchObject({ ok: true, code: 'ended' });
    expect(el.removed).toBe(true);
    expect(revoked).toEqual(['blob:chime']);
    expect(voiceDiagRecent().find((entry) => entry.e === 'sound.test')).toMatchObject({ ok: true, code: 'ended' });
    expect(soundCheckMessage(result)).toMatch(/Мелодия проиграна/);
  });

  it('a refusal by the browser says so (and what to do)', async () => {
    const el = fakeElement(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
    const result = await playSoundCheck({ createElement: () => el, createUrl: () => 'blob:chime', revokeUrl: () => undefined });
    expect(result).toMatchObject({ ok: false, code: 'NotAllowedError' });
    expect(soundCheckMessage(result)).toMatch(/Браузер не дал включить звук/);
  });

  it('no «ended» in time: counts only if the playhead really moved; a muted element never counts', async () => {
    const stuck = fakeElement(() => Promise.resolve());
    const pending = playSoundCheck({ createElement: () => stuck, createUrl: () => 'blob:x', revokeUrl: () => undefined, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await pending).toMatchObject({ ok: false, code: 'timeout' });

    const muted = fakeElement(() => Promise.resolve());
    muted.muted = true;
    const again = playSoundCheck({ createElement: () => muted, createUrl: () => 'blob:y', revokeUrl: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    muted.emit('ended');
    expect(await again).toMatchObject({ ok: false, code: 'ended' });
  });
});

// ───────────────────────── «Проверить микрофон» ─────────────────────────

interface FakeMic {
  stream: MicStream;
  stopped: number;
  ctx: MicMeterContext & { closed: boolean; connectedTo: unknown[]; disconnected: boolean; resumed: boolean };
  /** the RMS the analyser reports on its next reads */
  level: number;
}

/** a microphone + AudioContext pair: `level` is what the analyser "hears" (a square wave of that RMS) */
function fakeMic(options: { suspended?: boolean } = {}): FakeMic {
  const mic: FakeMic = {
    stream: { getTracks: () => [{ stop: () => void (mic.stopped += 1) }, { stop: () => void (mic.stopped += 1) }] },
    stopped: 0,
    level: 0,
    ctx: {
      state: options.suspended === true ? 'suspended' : 'running',
      closed: false,
      connectedTo: [],
      disconnected: false,
      resumed: false,
      resume() {
        mic.ctx.resumed = true;
        mic.ctx.state = 'running';
        return Promise.resolve();
      },
      createMediaStreamSource: () => ({
        connect: (node: unknown) => void mic.ctx.connectedTo.push(node),
        disconnect: () => void (mic.ctx.disconnected = true),
      }),
      createAnalyser: () => ({
        fftSize: 0,
        getFloatTimeDomainData(buffer: Float32Array<ArrayBuffer>) {
          for (let i = 0; i < buffer.length; i += 1) buffer[i] = i % 2 === 0 ? mic.level : -mic.level;
        },
      }),
      close() {
        mic.ctx.closed = true;
        return Promise.resolve();
      },
    },
  };
  return mic;
}

describe('«Проверить микрофон» — the other half of «он меня не слышит» (free, local)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
  });

  it('a voice arrives: «Я тебя слышу ✓» — the meter moves, the microphone and the context are released, nothing is played back', async () => {
    const mic = fakeMic({ suspended: true });
    const asked: MediaStreamConstraints[] = [];
    const levels: [number, boolean][] = [];
    const pending = checkMicrophone({
      isAutomated: () => false,
      getUserMedia: (constraints) => {
        asked.push(constraints);
        return Promise.resolve(mic.stream);
      },
      createContext: () => mic.ctx,
      onLevel: (level, heard) => levels.push([level, heard]),
    });
    await vi.advanceTimersByTimeAsync(500);
    // the child says something after half a second
    mic.level = 0.1;
    await vi.advanceTimersByTimeAsync(MIC_CHECK_MS);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, code: 'heard' });
    expect(result.peak).toBeGreaterThanOrEqual(MIC_HEARD_RMS);
    // the same microphone settings as the voice session (echo cancellation, noise suppression, auto gain)
    expect(asked).toEqual([MIC_CONSTRAINTS]);
    expect(mic.ctx.resumed).toBe(true);
    // the meter: quiet first, then loud — and «heard» flips once and stays
    expect(levels[0]).toEqual([0, false]);
    expect(levels.some(([level, heard]) => level > 0.3 && heard)).toBe(true);
    expect(levels.at(-1)).toEqual([0, true]);
    // a tap only: the source feeds the analyser, never the speakers
    expect(mic.ctx.connectedTo).toHaveLength(1);
    expect(mic.stopped).toBe(2);
    expect(mic.ctx.disconnected).toBe(true);
    expect(mic.ctx.closed).toBe(true);
    expect(voiceDiagRecent().find((entry) => entry.e === 'mic.test')).toMatchObject({ ok: true, code: 'heard' });
    expect(micCheckMessage(result)).toBe(MIC_HEARD_TEXT);
    expect(MIC_HEARD_TEXT).toContain('Я тебя слышу ✓');
  });

  it('only room noise: «quiet» — and the parent is told which microphone to check', async () => {
    const mic = fakeMic();
    mic.level = 0.004;
    const pending = checkMicrophone({ isAutomated: () => false, getUserMedia: () => Promise.resolve(mic.stream), createContext: () => mic.ctx, durationMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: 'quiet' });
    expect(mic.stopped).toBe(2);
    expect(mic.ctx.closed).toBe(true);
    expect(micCheckMessage(result)).toMatch(/голоса почти не слышно/);
  });

  it('refused / missing / busy microphone: says what to do, opens nothing else', async () => {
    const createContext = vi.fn(() => fakeMic().ctx);
    for (const [name, text] of [
      ['NotAllowedError', /Браузер не дал микрофон/],
      ['NotFoundError', /Микрофон не найден/],
      ['NotReadableError', /занят другой программой/],
    ] as const) {
      const result = await checkMicrophone({ isAutomated: () => false, getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name })), createContext });
      expect(result).toMatchObject({ ok: false, code: name });
      expect(micCheckMessage(result)).toMatch(text);
    }
    expect(createContext).not.toHaveBeenCalled();
    // no microphone API at all (the test runner is no browser)
    const none = await checkMicrophone({ isAutomated: () => false });
    expect(none).toMatchObject({ ok: false, code: 'unsupported' });
    expect(micCheckMessage(none)).toMatch(/Chrome или Safari/);
  });

  it('NEVER under automation: the microphone is not even asked for', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(fakeMic().stream));
    expect(await checkMicrophone({ isAutomated: () => true, getUserMedia })).toMatchObject({ ok: false, code: 'automation' });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('the Settings block offers both checks, each with a plain hint (free, local)', () => {
    const html = renderToStaticMarkup(createElement(SoundCheckButton));
    expect(html).toContain(SOUND_CHECK_TITLE);
    expect(html).toContain(MIC_CHECK_TITLE);
    expect(html).toContain(MIC_CHECK_HINT);
    expect(MIC_CHECK_HINT).toMatch(/бесплатно/);
    expect(micCheckMessage('listening')).toMatch(/слушаю/);
    expect(micCheckMessage('listening', true)).toBe(MIC_HEARD_TEXT);
  });
});
