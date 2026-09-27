/**
 * Synthetic signals for the voice-clips tests (tones stand in for voiced speech, seeded noise for breaths).
 * Test-only helpers; nothing here touches the disk or plays anything.
 */
import { SAMPLE_RATE } from './config.ts';

export const RATE = SAMPLE_RATE;

export function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((ms * RATE) / 1000));
}

/** A sine at `hz` with 10 ms raised-cosine edges, `amp` peak amplitude. */
export function tone(hz: number, ms: number, amp = 0.1): Float32Array {
  const n = Math.round((ms * RATE) / 1000);
  const out = new Float32Array(n);
  const edge = Math.round(0.01 * RATE);
  for (let i = 0; i < n; i++) {
    const env = i < edge ? 0.5 - 0.5 * Math.cos((Math.PI * i) / edge) : i > n - edge ? 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / edge) : 1;
    out[i] = amp * env * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return out;
}

/** Seeded white noise at an RMS level of `rmsDb` dBFS. */
export function noise(ms: number, rmsDb: number, seed = 1): Float32Array {
  const n = Math.round((ms * RATE) / 1000);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  const rms = 10 ** (rmsDb / 20);
  const scale = rms * Math.sqrt(3); // uniform in [−1, 1] has RMS 1/√3
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = scale * ((s / 4294967296) * 2 - 1);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function ms(samples: number): number {
  return (samples * 1000) / RATE;
}
