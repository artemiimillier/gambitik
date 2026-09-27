/**
 * The audio output of the «Записи» voice (docs/voice-clips/SPEC.md §5.3, architecture.md §4.1): ONE lazy
 * `AudioContext({ sampleRate: 32000 })` → master `GainNode` → a soft limiter → speakers.
 *
 *  - Created on first use, never at import: a page that never speaks never opens an audio device.
 *  - Browsers start it 'suspended' until a user gesture: `unlockInGesture()` (called synchronously from a click via
 *    the voice's gesture gate) resumes it and plays a 1-frame silent buffer INSIDE the gesture (Safari needs that).
 *    iOS 'interrupted' (a phone call) counts as suspended.
 *  - `muted` (the optional e2e flag `gambit.e2eClips`, see ./clipFlags.ts) routes everything into a GainNode(0): the
 *    whole pipeline runs, nothing is audible — on top of the headless browser's `--mute-audio`.
 *
 * The WebAudio surface is reduced to the small structural types below, so the unit tests run a fake context in Node.
 */

export interface ClipParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  setValueCurveAtTime?(curve: Float32Array, time: number, duration: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface ClipNodeLike {
  connect(destination: ClipNodeLike): unknown;
  disconnect(): void;
}

export interface ClipGainLike extends ClipNodeLike {
  readonly gain: ClipParamLike;
}

/** What the player needs of a decoded AudioBuffer. */
export interface ClipBufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface ClipSourceLike extends ClipNodeLike {
  buffer: ClipBufferLike | null;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

export interface ClipContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  /** 'running' | 'suspended' | 'closed' | 'interrupted' (iOS) */
  readonly state: string;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  readonly destination: ClipNodeLike;
  createGain(): ClipGainLike;
  createBufferSource(): ClipSourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): ClipBufferLike;
  createDynamicsCompressor?(): ClipNodeLike & { threshold?: { value: number }; knee?: { value: number }; ratio?: { value: number }; attack?: { value: number }; release?: { value: number } };
  decodeAudioData(bytes: ArrayBuffer): Promise<ClipBufferLike>;
  resume(): Promise<void>;
  close?(): Promise<void>;
}

export interface ClipAudioOptions {
  /** the context factory; null = no WebAudio (the voice then keeps silent timing). Default: a real AudioContext. */
  createContext?: () => ClipContextLike | null;
  /** e2e: everything goes into a GainNode(0) */
  muted?: boolean;
}

export type ClipAudioState = 'none' | 'running' | 'suspended' | 'closed';

export interface ClipAudio {
  /** the context (created on first call); null when WebAudio is unavailable */
  context(): ClipContextLike | null;
  /** where sources connect: the master gain (null without a context) */
  output(): ClipNodeLike | null;
  /** seconds between scheduling a sample and hearing it (`outputLatency`, else `baseLatency`, else 0) */
  latencySec(): number;
  state(): ClipAudioState;
  /** resume outside a gesture (may stay suspended); never rejects */
  resume(): Promise<ClipAudioState>;
  /** call synchronously inside a click / key press: resume + a 1-frame silent buffer (Safari) */
  unlockInGesture(): void;
  readonly muted: boolean;
  dispose(): void;
}

/** 32 kHz: the library's own rate (no resampling on decode where the browser honours it). */
export const CLIP_SAMPLE_RATE = 32_000;

function defaultCreateContext(): ClipContextLike | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ latencyHint: 'interactive', sampleRate: CLIP_SAMPLE_RATE }) as unknown as ClipContextLike;
  } catch {
    // an older Safari refuses a custom rate: the device rate works too (decodeAudioData resamples)
    try {
      return new Ctor({ latencyHint: 'interactive' }) as unknown as ClipContextLike;
    } catch {
      return null;
    }
  }
}

function stateOf(ctx: ClipContextLike | null): ClipAudioState {
  if (!ctx) return 'none';
  if (ctx.state === 'running') return 'running';
  if (ctx.state === 'closed') return 'closed';
  return 'suspended';
}

export function createClipAudio(options: ClipAudioOptions = {}): ClipAudio {
  const createContext = options.createContext ?? defaultCreateContext;
  const muted = options.muted === true;
  let ctx: ClipContextLike | null = null;
  let master: ClipGainLike | null = null;
  let unavailable = false;
  let disposed = false;

  const ensure = (): ClipContextLike | null => {
    if (ctx || unavailable || disposed) return ctx;
    let created: ClipContextLike | null = null;
    try {
      created = createContext();
    } catch {
      created = null;
    }
    if (!created) {
      unavailable = true;
      return null;
    }
    ctx = created;
    const gain = created.createGain();
    gain.gain.value = muted ? 0 : 1;
    master = gain;
    // a gentle limiter, as ui/sounds.ts does: clips are loudness-normalised (−18 LUFS), this only guards peaks
    const limiter = muted ? null : (created.createDynamicsCompressor?.() ?? null);
    if (limiter) {
      if (limiter.threshold) limiter.threshold.value = -6;
      if (limiter.knee) limiter.knee.value = 6;
      if (limiter.ratio) limiter.ratio.value = 12;
      if (limiter.attack) limiter.attack.value = 0.002;
      if (limiter.release) limiter.release.value = 0.12;
      gain.connect(limiter);
      limiter.connect(created.destination);
    } else {
      gain.connect(created.destination);
    }
    return ctx;
  };

  return {
    context: ensure,
    output() {
      ensure();
      return master;
    },
    latencySec() {
      if (!ctx) return 0;
      const out = ctx.outputLatency;
      if (typeof out === 'number' && Number.isFinite(out) && out > 0) return Math.min(out, 0.5);
      const base = ctx.baseLatency;
      return typeof base === 'number' && Number.isFinite(base) && base > 0 ? Math.min(base, 0.5) : 0;
    },
    state: () => stateOf(ctx),
    async resume() {
      const c = ensure();
      if (!c) return 'none';
      if (c.state === 'running' || c.state === 'closed') return stateOf(c);
      try {
        await c.resume();
      } catch {
        // autoplay policy: stays suspended until a gesture
      }
      return stateOf(c);
    },
    unlockInGesture() {
      const c = ensure();
      if (!c || c.state === 'closed') return;
      try {
        void c.resume().catch(() => undefined);
      } catch {
        // ignore: the next gesture tries again
      }
      try {
        // a 1-frame silent buffer played inside the gesture: Safari only unlocks output that way
        const buffer = c.createBuffer(1, 1, c.sampleRate);
        const src = c.createBufferSource();
        src.buffer = buffer;
        src.connect(master ?? c.destination);
        src.start(0);
      } catch {
        // not fatal
      }
    },
    muted,
    dispose() {
      disposed = true;
      const c = ctx;
      ctx = null;
      master = null;
      if (c?.close) void c.close().catch(() => undefined);
    },
  };
}
