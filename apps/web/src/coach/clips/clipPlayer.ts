/**
 * Plays one planned utterance of the «Записи» voice (docs/voice-clips/SPEC.md §5.1, §5.3, §5.5): WebAudio,
 * sample-accurate, one `AudioBufferSourceNode` → its own `GainNode` (fades) → the master output per clip.
 *
 *  - Gaps come from the plan (the §5.3 table with its ±30 ms jitter and the ×0.75 of 5-minute games, all applied by
 *    the planner); durations are the REAL decoded audible windows (clipLibrary's sample scan), so a seam is exactly
 *    the planned silence whatever the MP3 priming. No crossfades, `playbackRate` always 1, 5 ms raised-cosine fades.
 *  - `onSpeaking(true)` fires when the first sample is AUDIBLE (scheduled time + `outputLatency`); `ended` resolves at
 *    the last `onended` + `outputLatency` — the child's clock is held exactly while Гамбитик is heard.
 *  - `stop()` fades 25 ms and resolves at once; `endAfterSentence()` cancels every later sentence and lets the one
 *    being heard finish (the controller's gentle stop, `msToSentenceEnd()` tells it how far that is).
 *  - Watchdog: `ms + 1.5 s` — a context suspended mid-phrase (an iOS call) never hangs the queue.
 * The player never plays into a context that is not running: `play()` returns null and the voice keeps silent timing.
 */
import { createFrameLoop, smoothLevel } from '../voiceUtils.ts';
import type { FrameLoop } from '../voiceUtils.ts';
import type { ClipAudio, ClipContextLike, ClipGainLike, ClipParamLike, ClipSourceLike } from './clipAudio.ts';
import { ENVELOPE_STEP_SEC } from './clipLibrary.ts';
import type { LoadedClip } from './clipLibrary.ts';

export type ClipEndHow = 'end' | 'stop' | 'grace' | 'watchdog';

export interface ClipPlayItem {
  clip: LoadedClip;
  /** silence before this clip (the plan's, jitter included); ignored for the first */
  gapBeforeMs: number;
  /** index of the plan's sentence it belongs to */
  sentence: number;
}

export interface ClipPlayback {
  /** resolves once: 'end' (all heard), 'grace' (ended after its sentence), 'stop', 'watchdog' */
  readonly ended: Promise<ClipEndHow>;
  /** audible length: the decoded windows + the plan's gaps */
  readonly ms: number;
  /** fade out (default 25 ms) and resolve now */
  stop(fadeMs?: number): void;
  /** cut every later sentence; the one being heard plays on. false = nothing audible yet (the caller cuts instead) */
  endAfterSentence(): boolean;
  /** ms until the sentence being heard ends (0 in a gap after it); null before the first sample is audible */
  msToSentenceEnd(): number | null;
  /** the clips that actually started to sound (they go into the recency memory) */
  heardIds(): string[];
}

export interface ClipPlayerOptions {
  audio: ClipAudio;
  onSpeaking?: (speaking: boolean) => void;
  onLevel?: (level: number) => void;
  /** first clip starts this far after `play()` (SPEC architecture §4.2: 30 ms) */
  leadSec?: number;
  /** raised-cosine fade at every clip edge */
  fadeSec?: number;
  stopFadeMs?: number;
  watchdogExtraMs?: number;
  /** the mouth loop (tests pass a manual one) */
  createLoop?: (onFrame: (nowMs: number) => void) => FrameLoop;
}

export interface ClipPlayer {
  /** null when the context is missing or not running (autoplay lock, suspended): nothing was scheduled */
  play(items: readonly ClipPlayItem[]): ClipPlayback | null;
  dispose(): void;
}

export const CLIP_LEAD_SEC = 0.03;
export const CLIP_FADE_SEC = 0.005;
export const CLIP_STOP_FADE_MS = 25;
export const CLIP_WATCHDOG_EXTRA_MS = 1500;

function raisedCosine(points: number, rising: boolean): Float32Array {
  const curve = new Float32Array(points);
  for (let k = 0; k < points; k++) {
    const v = 0.5 - 0.5 * Math.cos((Math.PI * k) / (points - 1));
    curve[rising ? k : points - 1 - k] = v;
  }
  return curve;
}

const FADE_IN = raisedCosine(16, true);
const FADE_OUT = raisedCosine(16, false);

/** 0 → 1 over `fade` at `start`, 1 → 0 over `fade` before `start + dur` (no automation event overlaps another). */
function scheduleFades(param: ClipParamLike, start: number, dur: number, fade: number): void {
  const f = Math.min(fade, dur / 2);
  param.value = f > 0 ? 0 : 1;
  if (f <= 0) return;
  try {
    if (typeof param.setValueCurveAtTime === 'function') {
      param.setValueCurveAtTime(FADE_IN, start, f);
      param.setValueCurveAtTime(FADE_OUT, start + dur - f, f);
      return;
    }
  } catch {
    param.cancelScheduledValues(0);
  }
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(1, start + f);
  param.setValueAtTime(1, start + dur - f);
  param.linearRampToValueAtTime(0, start + dur);
}

/** A quick fade-out from now, however the param is automated right now; falls back to a hard stop. */
function fadeOutNow(gain: ClipGainLike, src: ClipSourceLike, now: number, fade: number): void {
  try {
    const param = gain.gain as ClipParamLike & { cancelAndHoldAtTime?(t: number): unknown };
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
    else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
    }
    param.linearRampToValueAtTime(0, now + fade);
    src.stop(now + fade);
  } catch {
    try {
      src.stop();
    } catch {
      // already stopped
    }
  }
}

interface Scheduled {
  id: string;
  src: ClipSourceLike;
  gain: ClipGainLike;
  start: number;
  end: number;
  sentence: number;
  env: Float32Array;
  cancelled: boolean;
  /** it had begun to sound when it was cancelled */
  heardAtCancel: boolean;
  ended: boolean;
}

export function createClipPlayer(options: ClipPlayerOptions): ClipPlayer {
  const { audio } = options;
  const lead = options.leadSec ?? CLIP_LEAD_SEC;
  const fade = options.fadeSec ?? CLIP_FADE_SEC;
  const stopFadeMs = options.stopFadeMs ?? CLIP_STOP_FADE_MS;
  const watchdogExtraMs = options.watchdogExtraMs ?? CLIP_WATCHDOG_EXTRA_MS;
  const createLoop = options.createLoop ?? createFrameLoop;
  let active: ClipPlayback | null = null;

  function play(items: readonly ClipPlayItem[]): ClipPlayback | null {
    const maybeCtx = audio.context();
    const out = audio.output();
    if (!maybeCtx || !out || maybeCtx.state !== 'running' || items.length === 0) return null;
    const ctx: ClipContextLike = maybeCtx;
    // one utterance at a time (the controller serialises; this is the safety net)
    active?.stop(0);

    const latency = audio.latencySec();
    const t0 = ctx.currentTime + lead;
    const scheduled: Scheduled[] = [];
    let t = t0;
    items.forEach((item, i) => {
      if (i > 0) t += Math.max(0, item.gapBeforeMs) / 1000;
      const dur = Math.max(0, item.clip.durSec);
      const src = ctx.createBufferSource();
      src.buffer = item.clip.buffer;
      const gain = ctx.createGain();
      scheduleFades(gain.gain, t, dur, fade);
      src.connect(gain);
      gain.connect(out);
      const entry: Scheduled = { id: item.clip.id, src, gain, start: t, end: t + dur, sentence: item.sentence, env: item.clip.env, cancelled: false, heardAtCancel: false, ended: false };
      scheduled.push(entry);
      src.onended = () => onSourceEnded(entry);
      src.start(t, item.clip.offsetSec, dur);
      t += dur;
    });
    const endAt = t;
    const totalMs = Math.round((endAt - t0) * 1000);

    let done = false;
    let speaking = false;
    let graceful = false;
    let heardUntil = Infinity;
    let resolveEnded: (how: ClipEndHow) => void = () => undefined;
    const ended = new Promise<ClipEndHow>((resolve) => {
      resolveEnded = resolve;
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void): void => {
      timers.push(setTimeout(fn, Math.max(0, ms)));
    };

    let level = 0;
    const loop = createLoop(() => {
      const heard = ctx.currentTime - latency;
      const cur = scheduled.find((s) => !s.cancelled && s.start <= heard && heard < s.end);
      const target = cur ? (cur.env[Math.floor((heard - cur.start) / ENVELOPE_STEP_SEC)] ?? 0) : 0;
      level = smoothLevel(level, target, 0.6, 0.3);
      options.onLevel?.(level < 0.01 ? 0 : level);
    });

    const setSpeaking = (value: boolean): void => {
      if (speaking === value) return;
      speaking = value;
      if (value) loop.start();
      else {
        loop.stop();
        level = 0;
        options.onLevel?.(0);
      }
      options.onSpeaking?.(value);
    };

    function finish(how: ClipEndHow): void {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      if (how === 'stop' || how === 'watchdog') heardUntil = ctx.currentTime - latency;
      setSpeaking(false);
      for (const s of scheduled) {
        s.src.onended = null;
        if (how === 'watchdog' && !s.ended && !s.cancelled) {
          try {
            s.src.stop();
          } catch {
            // already stopped
          }
        }
      }
      if (active === playback) active = null;
      resolveEnded(how);
    }

    function lastActive(): Scheduled | undefined {
      for (let i = scheduled.length - 1; i >= 0; i--) if (!(scheduled[i] as Scheduled).cancelled) return scheduled[i];
      return undefined;
    }

    function onSourceEnded(entry: Scheduled): void {
      entry.ended = true;
      if (done || entry.cancelled || entry !== lastActive()) return;
      // the last sample left the context; the child hears it `latency` later
      later(latency * 1000, () => finish(graceful ? 'grace' : 'end'));
    }

    /** the sentence being heard: the last clip that began before `heard` */
    function sentenceAt(heard: number): number | null {
      let k: number | null = null;
      for (const s of scheduled) if (!s.cancelled && s.start <= heard) k = s.sentence;
      return k;
    }

    const playback: ClipPlayback = {
      ended,
      ms: totalMs,
      stop(fadeMs = stopFadeMs) {
        if (done) return;
        const now = ctx.currentTime;
        for (const s of scheduled) {
          if (s.cancelled || s.ended) continue;
          s.cancelled = true;
          s.heardAtCancel = s.start <= now - latency;
          if (s.start >= now) {
            try {
              s.src.stop();
            } catch {
              // never started
            }
          } else fadeOutNow(s.gain, s.src, now, fadeMs / 1000);
        }
        finish('stop');
      },
      endAfterSentence() {
        if (done) return false;
        const heard = ctx.currentTime - latency;
        if (heard < t0) return false;
        const k = sentenceAt(heard);
        if (k === null) return false;
        const now = ctx.currentTime;
        for (const s of scheduled) {
          if (s.cancelled || s.sentence <= k) continue;
          s.cancelled = true;
          s.heardAtCancel = s.start <= heard;
          // (a clip already leaving the context but not heard yet: a 5 ms fade instead of a click)
          if (s.start >= now) {
            try {
              s.src.stop();
            } catch {
              // never started
            }
          } else fadeOutNow(s.gain, s.src, now, fade);
        }
        graceful = true;
        const last = lastActive();
        // the kept sentence already finished sounding (a gap after it): done now
        if (!last || last.ended || last.end <= heard) finish('grace');
        return true;
      },
      msToSentenceEnd() {
        if (done) return null;
        const heard = ctx.currentTime - latency;
        if (heard < t0) return null;
        const k = sentenceAt(heard);
        if (k === null) return null;
        let end = -Infinity;
        for (const s of scheduled) if (!s.cancelled && s.sentence === k) end = Math.max(end, s.end);
        return Math.max(0, Math.round((end - heard) * 1000));
      },
      heardIds() {
        return scheduled.filter((s) => (s.cancelled ? s.heardAtCancel : s.start <= heardUntil)).map((s) => s.id);
      },
    };

    // audible start: when the first sample reaches the ear
    later((t0 + latency - ctx.currentTime) * 1000, () => {
      if (!done) setSpeaking(true);
    });
    // the net under everything: a suspended context never fires `onended`
    later((endAt + latency - ctx.currentTime) * 1000 + watchdogExtraMs, () => finish('watchdog'));
    active = playback;
    return playback;
  }

  return {
    play,
    dispose() {
      active?.stop(0);
      active = null;
    },
  };
}
