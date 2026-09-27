/**
 * «Проверить звук» for a parent (Settings): a short, soft two-note chime played through the SAME output path as the
 * coach's voice — a hidden <audio> element (a generated WAV blob here, the WebRTC stream there). It answers the first
 * question of «я его не слышу»: can this page make sound at all (tab / system volume, Chrome's site sound setting, the
 * output device), independently of the paid voice. Free, offline, no microphone. The outcome goes to the black box.
 *
 * «Проверить микрофон» answers the other half, «и он меня не слышит»: the microphone is opened with the
 * SAME constraints as the voice session (echo cancellation, noise suppression, auto gain), its loudness is shown for
 * ~3 s and the parent learns whether anything arrived — «Я тебя слышу ✓». Local only: the sound is measured by an
 * AnalyserNode in the page (a tap, never played back, never sent anywhere), no paid call. Refused under automation.
 */
import { isAutomatedBrowser } from '../automation.ts';
import { MIC_CONSTRAINTS } from './rtcSession.ts';
import { diag, errorName } from './voiceDiag.ts';
import { computeRms, rmsToMouthTarget } from './voiceUtils.ts';

export const CHIME_SAMPLE_RATE = 22_050;
/** two notes (E5 → A5) with soft attack and decay, ≈ 0.8 s */
const CHIME_NOTES: readonly { hz: number; start: number; length: number }[] = [
  { hz: 659.25, start: 0, length: 0.45 },
  { hz: 880, start: 0.28, length: 0.52 },
];
const CHIME_SECONDS = 0.85;
const CHIME_GAIN = 0.35;

/** A 16-bit mono PCM WAV of the chime (RIFF header + samples). Pure: no DOM. */
export function createChimeWav(sampleRate = CHIME_SAMPLE_RATE): Uint8Array {
  const frames = Math.round(sampleRate * CHIME_SECONDS);
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const note of CHIME_NOTES) {
      const local = t - note.start;
      if (local < 0 || local > note.length) continue;
      const attack = Math.min(1, local / 0.012);
      const decay = Math.exp((-3.2 * local) / note.length);
      sample += Math.sin(2 * Math.PI * note.hz * local) * attack * decay;
    }
    const clamped = Math.max(-1, Math.min(1, sample * CHIME_GAIN));
    view.setInt16(44 + i * 2, Math.round(clamped * 32_767), true);
  }
  return bytes;
}

export interface SoundCheckResult {
  /** the element really played the chime (play() resolved and it ran to the end / far enough) */
  ok: boolean;
  /** 'ended' | 'played' | the play() error name ('NotAllowedError' …) | 'timeout' | 'unsupported' */
  code: string;
  ms: number;
}

/** the parts of an <audio> element the check uses (a fake in tests) */
export interface ChimeElement {
  src: string;
  preload: string;
  muted: boolean;
  volume: number;
  currentTime: number;
  paused: boolean;
  style: { display: string };
  play(): Promise<void>;
  pause(): void;
  remove(): void;
  addEventListener(type: 'ended' | 'error', listener: () => void, options?: { once?: boolean }): void;
}

export interface SoundCheckDeps {
  createElement?: () => ChimeElement | null;
  createUrl?: (bytes: Uint8Array) => string | null;
  revokeUrl?: (url: string) => void;
  now?: () => number;
  /** the chime is ≈ 0.85 s: give up after this long */
  timeoutMs?: number;
}

function defaultElement(): ChimeElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('audio');
  document.body.appendChild(el);
  return el as unknown as ChimeElement;
}

function defaultUrl(bytes: Uint8Array): string | null {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }));
}

function defaultRevoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* nothing to free */
  }
}

/** Plays the chime; call it from the parent's click (the autoplay policy allows sound inside a gesture). */
export async function playSoundCheck(deps: SoundCheckDeps = {}): Promise<SoundCheckResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const url = (deps.createUrl ?? defaultUrl)(createChimeWav());
  const el = url === null ? null : (deps.createElement ?? defaultElement)();
  if (url === null || el === null) {
    diag('sound.test', { ok: false, code: 'unsupported' });
    return { ok: false, code: 'unsupported', ms: 0 };
  }
  el.style.display = 'none';
  el.preload = 'auto';
  el.src = url;
  const finish = (ok: boolean, code: string): SoundCheckResult => {
    try {
      el.pause();
      el.remove();
    } catch {
      /* gone already */
    }
    (deps.revokeUrl ?? defaultRevoke)(url);
    const result = { ok, code, ms: now() - startedAt };
    diag('sound.test', { ok, code, ms: result.ms, muted: el.muted, vol: el.volume });
    return result;
  };
  const ended = new Promise<'ended' | 'error'>((resolve) => {
    el.addEventListener('ended', () => resolve('ended'), { once: true });
    el.addEventListener('error', () => resolve('error'), { once: true });
  });
  try {
    await el.play();
  } catch (error) {
    return finish(false, errorName(error));
  }
  const timeoutMs = deps.timeoutMs ?? 3000;
  const outcome = await Promise.race([
    ended,
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]);
  if (outcome === 'ended') return finish(!el.muted && el.volume > 0, 'ended');
  if (outcome === 'error') return finish(false, 'error');
  // no 'ended' in time: it counts if the playhead moved well into the chime
  return finish(el.currentTime > 0.3 && !el.muted, el.currentTime > 0.3 ? 'played' : 'timeout');
}

// ───────────────────────── «Проверить микрофон» ─────────────────────────

/** how long the microphone is listened to */
export const MIC_CHECK_MS = 3000;
/** RMS above this (after the browser's noise suppression) = a voice arrived, not just room noise */
export const MIC_HEARD_RMS = 0.02;

export interface MicCheckResult {
  /** a voice-like level arrived */
  ok: boolean;
  /** 'heard' | 'quiet' | 'NotAllowedError' | 'NotFoundError' | 'NotReadableError' | … | 'unsupported' | 'automation' */
  code: string;
  /** the loudest RMS measured (0..1) */
  peak: number;
  ms: number;
}

/** the parts of a MediaStream the check uses (a fake in tests) */
export interface MicStream {
  getTracks(): { stop(): void }[];
}

/** the parts of an AudioContext the check uses (a fake in tests) */
export interface MicMeterContext {
  state: string;
  resume?(): Promise<void>;
  createMediaStreamSource(stream: MicStream): { connect(node: unknown): void; disconnect(): void };
  createAnalyser(): { fftSize: number; getFloatTimeDomainData(buffer: Float32Array<ArrayBuffer>): void };
  close(): Promise<void>;
}

export interface MicCheckDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MicStream>;
  createContext?: () => MicMeterContext | null;
  /** 0..1 loudness for the meter, every frame; `heard` flips to true once a voice arrived */
  onLevel?: (level: number, heard: boolean) => void;
  durationMs?: number;
  frameMs?: number;
  now?: () => number;
  isAutomated?: () => boolean;
}

function defaultGetUserMedia(): ((constraints: MediaStreamConstraints) => Promise<MicStream>) | null {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') return null;
  return (constraints) => navigator.mediaDevices.getUserMedia(constraints);
}

function defaultContext(): MicMeterContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor() as unknown as MicMeterContext;
  } catch {
    return null;
  }
}

/**
 * Opens the microphone, meters it for `durationMs` and closes everything again. Call it from the parent's click (the
 * permission prompt and the AudioContext both want a gesture). Never throws.
 */
export async function checkMicrophone(deps: MicCheckDeps = {}): Promise<MicCheckResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const done = (ok: boolean, code: string, peak: number): MicCheckResult => {
    const result = { ok, code, peak: Math.round(peak * 10_000) / 10_000, ms: now() - startedAt };
    diag('mic.test', { ok, code, peak: result.peak, ms: result.ms });
    return result;
  };
  // automation: no microphone, ever (silent, free, isolated)
  if ((deps.isAutomated ?? (() => isAutomatedBrowser()))()) return { ok: false, code: 'automation', peak: 0, ms: 0 };
  const getUserMedia = deps.getUserMedia ?? defaultGetUserMedia();
  if (!getUserMedia) return done(false, 'unsupported', 0);

  let stream: MicStream;
  try {
    stream = await getUserMedia(MIC_CONSTRAINTS);
  } catch (error) {
    return done(false, errorName(error), 0);
  }
  const ctx = (deps.createContext ?? defaultContext)();
  let source: { disconnect(): void } | null = null;
  const release = (): void => {
    try {
      source?.disconnect();
    } catch {
      /* gone already */
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* stopped already */
      }
    }
    if (ctx) void ctx.close().catch(() => undefined);
  };
  if (!ctx) {
    release();
    return done(false, 'unsupported', 0);
  }
  let peak = 0;
  try {
    if (ctx.state === 'suspended' && ctx.resume) await ctx.resume().catch(() => undefined);
    const node = ctx.createMediaStreamSource(stream);
    source = node;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    // a tap only: never connected to the speakers (no feedback, nothing played back)
    node.connect(analyser);
    const buffer = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
    const durationMs = deps.durationMs ?? MIC_CHECK_MS;
    const frameMs = deps.frameMs ?? 50;
    let heard = false;
    for (let elapsed = 0; elapsed < durationMs; elapsed += frameMs) {
      await new Promise((resolve) => setTimeout(resolve, frameMs));
      analyser.getFloatTimeDomainData(buffer);
      const rms = computeRms(buffer);
      if (rms > peak) peak = rms;
      if (rms >= MIC_HEARD_RMS) heard = true;
      deps.onLevel?.(rmsToMouthTarget(rms, 0.008, 5), heard);
    }
    deps.onLevel?.(0, heard);
  } catch (error) {
    release();
    return done(false, errorName(error), peak);
  }
  release();
  return peak >= MIC_HEARD_RMS ? done(true, 'heard', peak) : done(false, 'quiet', peak);
}
