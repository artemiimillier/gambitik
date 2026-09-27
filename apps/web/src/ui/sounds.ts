/**
 * Sound effects synthesised with WebAudio — no asset files, no licences (research 08 §1.7, §5.4).
 *
 *  - move / capture / check are short (< 300 ms), «wooden» and easy to tell apart by ear;
 *  - win is a ≤ 2 s jingle, lose is a neutral soft sound (no «sad trombone»), oops is a gentle «uh-oh», never a buzzer;
 *  - the AudioContext is created lazily and resumed on the first user gesture (browser autoplay policy);
 *  - a global mute flag, a volume and «ducking» (SFX drop to 30 % while the mascot speaks or listens);
 *  - a browser driven by automation (`navigator.webdriver`) is always silent — see ../automation.ts.
 *
 * Everything sounds through one master GainNode → limiter → destination.
 */

import { automationSilenced } from '../automation.ts';

export const SOUND_NAMES = ['move', 'capture', 'check', 'win', 'lose', 'click', 'oops', 'star'] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

export interface SoundPlayerOptions {
  /** Factory for the AudioContext; return null when WebAudio is unavailable. Injected in tests. */
  createContext?: () => AudioContext | null;
  /** 0..1 random source used for tiny pitch variations. */
  random?: () => number;
  /** Initial master volume 0..1. Default 0.7. */
  volume?: number;
  muted?: boolean;
}

export interface SoundPlayer {
  /** Schedules a sound. Returns false when nothing was scheduled (muted, no WebAudio, context still locked). */
  play(name: SoundName): boolean;
  /** Creates (if needed) and resumes the context. Call from a user-gesture handler. */
  unlock(): Promise<boolean>;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  /** Ducking: true while the coach voice is speaking or listening. */
  setDucked(ducked: boolean): void;
  dispose(): void;
}

const DUCK_FACTOR = 0.3;
const STALE_MS = 250;

interface ToneSpec {
  type: OscillatorType;
  freq: number;
  /** glide target, reached at the end of the note */
  freqEnd?: number;
  /** seconds from the start of the sound */
  at: number;
  attack?: number;
  decay: number;
  gain: number;
}

interface NoiseSpec {
  at: number;
  duration: number;
  gain: number;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
}

interface Recipe {
  tones: ToneSpec[];
  noises?: NoiseSpec[];
  /** ± relative pitch jitter so repeated moves do not sound machine-made */
  jitter?: number;
}

// Note frequencies (Hz)
const C4 = 261.63;
const E4 = 329.63;
const G4 = 392.0;
const A4 = 440.0;
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880.0;
const B5 = 987.77;
const C6 = 1046.5;
const E6 = 1318.51;
const G6 = 1567.98;
const B6 = 1975.53;

/** Marimba-like note: fundamental + quiet 4th harmonic that dies quickly. */
function mallet(freq: number, at: number, gain: number, decay: number): ToneSpec[] {
  return [
    { type: 'sine', freq, at, attack: 0.004, decay, gain },
    { type: 'sine', freq: freq * 4, at, attack: 0.002, decay: decay * 0.25, gain: gain * 0.18 },
  ];
}

export const SOUND_RECIPES: Record<SoundName, Recipe> = {
  // A piece put down on a wooden board: a dry tick + a low thump + a short woody resonance.
  move: {
    jitter: 0.05,
    tones: [
      { type: 'sine', freq: 220, freqEnd: 130, at: 0, attack: 0.002, decay: 0.09, gain: 0.9 },
      // the «wood» lives in the mids — small laptop speakers barely reproduce the low thump
      { type: 'sine', freq: 392, at: 0, attack: 0.002, decay: 0.07, gain: 0.4 },
      { type: 'triangle', freq: 784, at: 0, attack: 0.001, decay: 0.05, gain: 0.28 },
      { type: 'sine', freq: 1240, at: 0, attack: 0.001, decay: 0.03, gain: 0.1 },
    ],
    noises: [{ at: 0, duration: 0.03, gain: 0.5, filter: 'bandpass', freq: 1800, q: 1.2 }],
  },
  // Heavier knock followed by the clack of the captured piece leaving the board.
  capture: {
    jitter: 0.04,
    tones: [
      { type: 'sine', freq: 180, freqEnd: 95, at: 0, attack: 0.002, decay: 0.14, gain: 1.0 },
      { type: 'sine', freq: 330, at: 0, attack: 0.002, decay: 0.08, gain: 0.4 },
      { type: 'triangle', freq: 600, at: 0, attack: 0.001, decay: 0.05, gain: 0.28 },
      { type: 'triangle', freq: 940, at: 0.07, attack: 0.001, decay: 0.05, gain: 0.22 },
      { type: 'sine', freq: 250, freqEnd: 160, at: 0.07, attack: 0.002, decay: 0.07, gain: 0.45 },
    ],
    noises: [
      { at: 0, duration: 0.028, gain: 0.6, filter: 'highpass', freq: 2400 },
      { at: 0.07, duration: 0.03, gain: 0.35, filter: 'bandpass', freq: 1250, q: 1.4 },
    ],
  },
  // Two quick bright mallet notes going up: «look here!», not an alarm.
  check: {
    tones: [...mallet(A5, 0, 0.34, 0.16), ...mallet(E6, 0.085, 0.3, 0.19)],
    noises: [{ at: 0, duration: 0.012, gain: 0.12, filter: 'highpass', freq: 3000 }],
  },
  // Rising arpeggio into a held major chord with a little sparkle on top (~1.6 s).
  win: {
    tones: [
      ...mallet(C5, 0, 0.3, 0.3),
      ...mallet(E5, 0.12, 0.3, 0.3),
      ...mallet(G5, 0.24, 0.3, 0.32),
      ...mallet(C6, 0.38, 0.34, 1.1),
      { type: 'triangle', freq: C5, at: 0.38, attack: 0.01, decay: 1.0, gain: 0.16 },
      { type: 'triangle', freq: E5, at: 0.38, attack: 0.01, decay: 1.0, gain: 0.14 },
      { type: 'triangle', freq: G5, at: 0.38, attack: 0.01, decay: 1.0, gain: 0.14 },
      { type: 'sine', freq: G6, at: 0.56, attack: 0.003, decay: 0.35, gain: 0.1 },
      { type: 'sine', freq: C6 * 2, at: 0.68, attack: 0.003, decay: 0.5, gain: 0.09 },
    ],
  },
  // Two soft, round notes. Calm and short: losing is a normal thing.
  lose: {
    tones: [
      { type: 'sine', freq: A4, at: 0, attack: 0.03, decay: 0.34, gain: 0.26 },
      { type: 'sine', freq: A4 * 2, at: 0, attack: 0.03, decay: 0.2, gain: 0.04 },
      { type: 'sine', freq: E4, at: 0.2, attack: 0.03, decay: 0.5, gain: 0.26 },
      { type: 'sine', freq: E4 * 2, at: 0.2, attack: 0.03, decay: 0.3, gain: 0.04 },
    ],
  },
  // Tiny UI tick.
  click: {
    tones: [{ type: 'sine', freq: 920, freqEnd: 640, at: 0, attack: 0.001, decay: 0.055, gain: 0.45 }],
    noises: [{ at: 0, duration: 0.012, gain: 0.2, filter: 'highpass', freq: 3200 }],
  },
  // Gentle «uh-oh»: two round notes, the second one sliding down a little.
  oops: {
    tones: [
      { type: 'triangle', freq: G4, at: 0, attack: 0.012, decay: 0.15, gain: 0.22 },
      { type: 'sine', freq: G4, at: 0, attack: 0.012, decay: 0.15, gain: 0.15 },
      { type: 'triangle', freq: E4, freqEnd: C4 * 1.12, at: 0.17, attack: 0.012, decay: 0.26, gain: 0.22 },
      { type: 'sine', freq: E4, freqEnd: C4 * 1.12, at: 0.17, attack: 0.012, decay: 0.26, gain: 0.15 },
    ],
  },
  // Reward «ding» for an earned star.
  star: {
    tones: [...mallet(B5, 0, 0.2, 0.12), ...mallet(E6, 0.06, 0.3, 0.45), { type: 'sine', freq: B6, at: 0.06, attack: 0.003, decay: 0.4, gain: 0.12 }],
  },
};

/** Total audible length of a recipe in seconds (used by tests and to size cleanup timers). */
export function recipeDuration(recipe: Recipe): number {
  let end = 0;
  for (const t of recipe.tones) end = Math.max(end, t.at + (t.attack ?? 0.003) + t.decay);
  for (const n of recipe.noises ?? []) end = Math.max(end, n.at + n.duration);
  return end;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function defaultCreateContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
}

export function createSoundPlayer(options: SoundPlayerOptions = {}): SoundPlayer {
  const createContext = options.createContext ?? defaultCreateContext;
  const random = options.random ?? Math.random;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let unavailable = false;
  let muted = options.muted ?? false;
  let volume = clamp01(options.volume ?? 0.7);
  let ducked = false;

  const targetGain = () => (muted ? 0 : volume * (ducked ? DUCK_FACTOR : 1));

  const applyGain = () => {
    if (!ctx || !master) return;
    // short ramp: no zipper noise when ducking kicks in mid-sound
    master.gain.setTargetAtTime(targetGain(), ctx.currentTime, 0.03);
  };

  const ensureContext = (): AudioContext | null => {
    if (ctx || unavailable) return ctx;
    const created = createContext();
    if (!created) {
      unavailable = true;
      return null;
    }
    ctx = created;
    master = created.createGain();
    master.gain.value = targetGain();
    const limiter = created.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    master.connect(limiter);
    limiter.connect(created.destination);
    return ctx;
  };

  const getNoise = (context: AudioContext): AudioBuffer => {
    if (noiseBuffer) return noiseBuffer;
    const length = Math.floor(context.sampleRate * 0.25);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = random() * 2 - 1;
    noiseBuffer = buffer;
    return buffer;
  };

  const schedule = (context: AudioContext, out: GainNode, name: SoundName) => {
    const recipe = SOUND_RECIPES[name];
    const t0 = context.currentTime + 0.012;
    const pitch = recipe.jitter ? 1 + (random() * 2 - 1) * recipe.jitter : 1;

    for (const tone of recipe.tones) {
      const start = t0 + tone.at;
      const attack = tone.attack ?? 0.003;
      const end = start + attack + tone.decay;
      const osc = context.createOscillator();
      const env = context.createGain();
      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.freq * pitch, start);
      if (tone.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(tone.freqEnd * pitch, end);
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(tone.gain, start + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(env);
      env.connect(out);
      osc.start(start);
      osc.stop(end + 0.03);
      osc.onended = () => {
        osc.disconnect();
        env.disconnect();
      };
    }

    for (const noise of recipe.noises ?? []) {
      const start = t0 + noise.at;
      const end = start + noise.duration;
      const src = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const env = context.createGain();
      src.buffer = getNoise(context);
      filter.type = noise.filter;
      filter.frequency.value = noise.freq * pitch;
      if (noise.q !== undefined) filter.Q.value = noise.q;
      env.gain.setValueAtTime(noise.gain, start);
      env.gain.exponentialRampToValueAtTime(0.0001, end);
      src.connect(filter);
      filter.connect(env);
      env.connect(out);
      src.start(start);
      src.stop(end + 0.02);
      src.onended = () => {
        src.disconnect();
        filter.disconnect();
        env.disconnect();
      };
    }
  };

  return {
    play(name) {
      if (muted) return false;
      const context = ensureContext();
      if (!context || !master) return false;
      const out = master;
      if (context.state === 'running') {
        schedule(context, out, name);
        return true;
      }
      // Still locked by the autoplay policy: try to resume, but never play a stale sound later
      // (a suspended context would otherwise burst everything at once after the first click).
      const asked = Date.now();
      void context
        .resume()
        .then(() => {
          if (!muted && context.state === 'running' && Date.now() - asked <= STALE_MS) schedule(context, out, name);
        })
        .catch(() => undefined);
      return false;
    },
    async unlock() {
      const context = ensureContext();
      if (!context) return false;
      if (context.state !== 'running') {
        try {
          await context.resume();
        } catch {
          return false;
        }
      }
      return context.state === 'running';
    },
    setMuted(value) {
      muted = value;
      applyGain();
    },
    isMuted: () => muted,
    setVolume(value) {
      volume = clamp01(value);
      applyGain();
    },
    getVolume: () => volume,
    setDucked(value) {
      ducked = value;
      applyGain();
    },
    dispose() {
      const context = ctx;
      ctx = null;
      master = null;
      noiseBuffer = null;
      if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    },
  };
}

// ───────────────────────── app-wide singleton ─────────────────────────

const MUTE_STORAGE_KEY = 'gambit.sfx.muted';

// `window` is checked first: Node 26 has an experimental global localStorage that warns when touched.
function readStoredMute(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function storeMute(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    // private mode / storage disabled: the flag simply lives for this session
  }
}

/**
 * Under automation (Playwright & co, see ../automation.ts) the app makes no sound at all: the default player gets
 * no AudioContext, so nothing can be scheduled — whatever the stored mute flag or a later setSoundMuted(false) says.
 */
const player = createSoundPlayer(automationSilenced() ? { muted: true, createContext: () => null } : { muted: readStoredMute() });
const muteListeners = new Set<(muted: boolean) => void>();
let unlockInstalled = false;

/**
 * Resumes the shared AudioContext on the first pointer / key gesture. Idempotent; installed automatically
 * when this module is loaded in a browser, exported for explicit calls (e.g. from «Разбудить Гамбитика»).
 */
export function installAudioUnlock(target?: Pick<Window, 'addEventListener' | 'removeEventListener'>): void {
  const host = target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!host || unlockInstalled) return;
  unlockInstalled = true;
  const events = ['pointerdown', 'keydown', 'touchend'] as const;
  const onGesture = () => {
    void player.unlock().then((running) => {
      if (!running) return;
      for (const type of events) host.removeEventListener(type, onGesture, true);
    });
  };
  for (const type of events) host.addEventListener(type, onGesture, { capture: true, passive: true });
}

/** Plays a UI / board sound. Safe to call anywhere: it is a no-op when muted, locked or outside the browser. */
export function playSound(name: SoundName): boolean {
  return player.play(name);
}

/** Global mute flag for sound effects (persisted in localStorage). */
export function setSoundMuted(muted: boolean): void {
  if (player.isMuted() === muted) return;
  player.setMuted(muted);
  storeMute(muted);
  for (const listener of muteListeners) listener(muted);
}

export function isSoundMuted(): boolean {
  return player.isMuted();
}

export function toggleSoundMuted(): boolean {
  setSoundMuted(!player.isMuted());
  return player.isMuted();
}

/** Subscribe to mute changes (for a mute button). Returns unsubscribe. */
export function onSoundMutedChange(listener: (muted: boolean) => void): () => void {
  muteListeners.add(listener);
  return () => {
    muteListeners.delete(listener);
  };
}

/** Master SFX volume 0..1 (parent settings «Звуки»). */
export function setSoundVolume(volume: number): void {
  player.setVolume(volume);
}

export function getSoundVolume(): number {
  return player.getVolume();
}

/** The coach calls this while the mascot speaks or listens: effects drop to 30 %. */
export function setSoundDucked(ducked: boolean): void {
  player.setDucked(ducked);
}

/** Explicit unlock from a click handler; resolves true when audio is running. */
export function unlockAudio(): Promise<boolean> {
  return player.unlock();
}

installAudioUnlock();
