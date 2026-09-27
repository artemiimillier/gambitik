/**
 * Small DOM-free helpers shared by the voice layers: a typed emitter, sentence chunking,
 * a pseudo lip-sync envelope and RMS level maths.
 */

// ───────────────────────── emitter ─────────────────────────

export type Unsubscribe = () => void;

export interface Emitter<T> {
  on(cb: (value: T) => void): Unsubscribe;
  emit(value: T): void;
  clear(): void;
  readonly size: number;
}

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    on(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit(value) {
      for (const cb of [...listeners]) {
        try {
          cb(value);
        } catch (error) {
          console.error('[coach] listener failed', error);
        }
      }
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}

// ───────────────────────── numbers ─────────────────────────

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ───────────────────────── text chunking ─────────────────────────

const SENTENCE_RE = /[^.!?…]+(?:[.!?…]+["»”)]*|$)/g;

function splitLongSentence(sentence: string, maxLen: number): string[] {
  if (sentence.length <= maxLen) return [sentence];
  const parts: string[] = [];
  // prefer clause boundaries, then plain spaces
  const clauses = sentence.split(/(?<=[,;:—–])\s+/);
  let current = '';
  const push = (piece: string): void => {
    if (piece.trim() !== '') parts.push(piece.trim());
  };
  for (const clause of clauses) {
    if (clause.length > maxLen) {
      push(current);
      current = '';
      let line = '';
      for (const word of clause.split(/\s+/)) {
        if (line !== '' && line.length + 1 + word.length > maxLen) {
          push(line);
          line = word;
        } else {
          line = line === '' ? word : `${line} ${word}`;
        }
      }
      current = line;
    } else if (current !== '' && current.length + 1 + clause.length > maxLen) {
      push(current);
      current = clause;
    } else {
      current = current === '' ? clause : `${current} ${clause}`;
    }
  }
  push(current);
  return parts;
}

/**
 * Splits text into utterance-sized chunks (sentence by sentence). Browsers cut long
 * `speechSynthesis` utterances off after ~15 s, so nothing longer than `maxLen` is ever queued.
 */
export function splitIntoSentences(text: string, maxLen = 140): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];
  const sentences = normalized.match(SENTENCE_RE) ?? [normalized];
  const chunks: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence === '') continue;
    // a chunk without any letter or digit (e.g. a stray «…») would make TTS engines stall
    if (!/[\p{L}\p{N}]/u.test(sentence)) continue;
    chunks.push(...splitLongSentence(sentence, maxLen));
  }
  return chunks;
}

/** Rough speaking time of a Russian text at a lively pace; used for watchdogs and the silent layer. */
export function estimateSpeechMs(text: string, msPerChar = 75): number {
  const chars = text.replace(/\s+/g, ' ').trim().length;
  return Math.round(600 + chars * msPerChar);
}

// ───────────────────────── bubble pagination ─────────────────────────

/**
 * Splits a long bubble text into pages that fit ~3 lines. Sentences are kept together
 * when possible; an over-long sentence is wrapped on word boundaries.
 */
export function paginateBubble(text: string, maxChars = 120): string[] {
  const chunks = splitIntoSentences(text, maxChars);
  const pages: string[] = [];
  let current = '';
  for (const chunk of chunks) {
    if (current !== '' && current.length + 1 + chunk.length > maxChars) {
      pages.push(current);
      current = chunk;
    } else {
      current = current === '' ? chunk : `${current} ${chunk}`;
    }
  }
  if (current !== '') pages.push(current);
  return pages;
}

// ───────────────────────── lip-sync maths ─────────────────────────

/** Root-mean-square of a time-domain buffer (values −1..1). */
export function computeRms(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Maps an RMS value onto a 0..1 mouth target with a noise gate. */
export function rmsToMouthTarget(rms: number, gate = 0.012, gain = 6): number {
  return clamp01((rms - gate) * gain);
}

/** Fast attack, slow release — keeps the mouth from flickering. */
export function smoothLevel(previous: number, target: number, attack = 0.6, release = 0.22): number {
  const k = target > previous ? attack : release;
  return previous + (target - previous) * k;
}

export interface MouthEnvelope {
  /** Level 0..1 for a time in ms since speech started. */
  sample(tMs: number): number;
  /** A word/syllable boundary happened: opens the mouth a bit wider for a moment. */
  kick(tMs: number): void;
}

/**
 * «Muppet-style» pseudo lip-sync for voices that give us no audio to analyse
 * (browser TTS, silent layer, deaf AnalyserNode): two detuned sines for the syllable
 * rhythm + slow noise for phrase dynamics + short kicks on boundary events.
 */
export function createMouthEnvelope(random: () => number = Math.random): MouthEnvelope {
  const phaseA = random() * Math.PI * 2;
  const phaseB = random() * Math.PI * 2;
  const phaseC = random() * Math.PI * 2;
  let lastKick = -Infinity;
  return {
    sample(tMs) {
      const t = tMs / 1000;
      const syllables = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.1 * t + phaseA);
      const flutter = 0.5 + 0.5 * Math.sin(2 * Math.PI * 7.3 * t + phaseB);
      const phrase = 0.72 + 0.28 * Math.sin(2 * Math.PI * 0.43 * t + phaseC);
      const sinceKick = tMs - lastKick;
      const kick = sinceKick >= 0 && sinceKick < 220 ? 0.35 * (1 - sinceKick / 220) : 0;
      return clamp01((0.12 + 0.6 * syllables + 0.22 * flutter) * phrase + kick);
    },
    kick(tMs) {
      lastKick = tMs;
    },
  };
}

// ───────────────────────── frame loop ─────────────────────────

export interface FrameLoop {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

/** requestAnimationFrame loop with a setTimeout fallback (tests, hidden tabs without rAF). */
export function createFrameLoop(onFrame: (nowMs: number) => void): FrameLoop {
  let handle: number | ReturnType<typeof setTimeout> | null = null;
  let usingRaf = false;
  let running = false;
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const schedule = (): void => {
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
      usingRaf = true;
      handle = requestAnimationFrame(tick);
    } else {
      usingRaf = false;
      handle = setTimeout(tick, 50);
    }
  };
  const tick = (): void => {
    if (!running) return;
    onFrame(now());
    if (running) schedule();
  };
  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (handle !== null) {
        if (usingRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number);
        else clearTimeout(handle as ReturnType<typeof setTimeout>);
        handle = null;
      }
    },
    get running() {
      return running;
    },
  };
}
