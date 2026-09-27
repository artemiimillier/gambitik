/**
 * Zero-cost voice layer on top of the browser's `speechSynthesis` (research 03 §12.2).
 *
 *  - picks the best installed ru-RU voice (Premium > Enhanced > Google network > local compact)
 *    and re-picks on Chrome's late `voiceschanged`
 *  - young character: rate ≈ 1.02, pitch ≈ 1.25
 *  - long text is spoken sentence by sentence (Chrome silently cuts utterances after ~15 s),
 *    every utterance has a watchdog and a pause/resume keep-alive
 *  - mouth level is simulated: `boundary` events kick a sine/noise envelope
 *  - speech needs a prior user gesture → `needsUserGesture` + `unlock()`
 */
import type { VoiceLayer } from '@gambit/shared';
import { createGestureGate } from './gestureGate.ts';
import type { GestureGate } from './gestureGate.ts';
import type { GestureGated } from './voiceTypes.ts';
import { createEmitter, createFrameLoop, createMouthEnvelope, estimateSpeechMs, smoothLevel, splitIntoSentences } from './voiceUtils.ts';

export interface BrowserTtsOptions {
  /** defaults to `window.speechSynthesis` */
  synth?: SpeechSynthesis;
  /** defaults to `new SpeechSynthesisUtterance(text)` */
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  rate?: number;
  pitch?: number;
  volume?: number;
  /** probe for sticky user activation; defaults to `navigator.userActivation.hasBeenActive` */
  hasUserActivation?: () => boolean;
}

export type BrowserTtsVoice = VoiceLayer & GestureGated & { readonly kind: 'browser-tts'; readonly voiceName: string | null };

/** Minimal shape of a voice we rank — lets tests pass plain objects. */
export interface RankableVoice {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

/** Higher = better. Non-Russian voices get −1. */
export function scoreRussianVoice(voice: RankableVoice): number {
  const lang = voice.lang.replace('_', '-').toLowerCase();
  if (!lang.startsWith('ru')) return -1;
  const name = voice.name.toLowerCase();
  let score = 10;
  if (/premium|премиум/.test(name)) score += 100;
  else if (/enhanced|улучш/.test(name)) score += 80;
  else if (/siri/.test(name)) score += 70;
  else if (/natural|neural|online/.test(name)) score += 65; // Edge "Microsoft Svetlana Online (Natural)"
  else if (/google/.test(name)) score += 50; // network voice, clearly better than a compact system voice
  else if (voice.localService) score += 30;
  if (lang === 'ru-ru') score += 5;
  // a bright female timbre fits the young character best (research 08 §3.2)
  if (/milena|katya|катя|милена|svetlana|dariya|irina/.test(name)) score += 3;
  return score;
}

export function pickRussianVoice<V extends RankableVoice>(voices: readonly V[]): V | null {
  let best: V | null = null;
  let bestScore = 0;
  for (const voice of voices) {
    const score = scoreRussianVoice(voice);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

interface SpeechSession {
  cancelled: boolean;
  finish: () => void;
  done: Promise<void>;
}

const VOICES_WAIT_MS = 1500;
const AFTER_CANCEL_DELAY_MS = 80;
const KEEP_ALIVE_AFTER_MS = 11_000;

export function createBrowserTtsVoice(options: BrowserTtsOptions = {}): BrowserTtsVoice {
  const rate = options.rate ?? 1.02;
  const pitch = options.pitch ?? 1.25;
  const volume = options.volume ?? 1;

  const level = createEmitter<number>();
  const speakingChange = createEmitter<boolean>();
  const gestureChange = createEmitter<boolean>();

  let synth: SpeechSynthesis | null = null;
  let voice: SpeechSynthesisVoice | null = null;
  let session: SpeechSession | null = null;
  let gate: GestureGate | null = null;
  let speaking = false;
  let disposed = false;
  let lastCancelAt = -Infinity;
  let urgentWaiting = 0;
  /** Chrome drops `end` events of garbage-collected utterances — keep them referenced. */
  const liveUtterances = new Set<SpeechSynthesisUtterance>();
  const cleanups: (() => void)[] = [];

  // mouth simulation
  let envelope = createMouthEnvelope();
  let utteranceActive = false;
  let speechStartedAt = 0;
  let currentLevel = 0;
  const loop = createFrameLoop((now) => {
    const target = utteranceActive ? envelope.sample(now - speechStartedAt) : 0;
    currentLevel = smoothLevel(currentLevel, target, 0.55, 0.3);
    level.emit(currentLevel < 0.01 ? 0 : currentLevel);
  });

  const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function setSpeaking(next: boolean): void {
    if (speaking === next) return;
    speaking = next;
    if (next) {
      envelope = createMouthEnvelope();
      speechStartedAt = nowMs();
      loop.start();
    } else {
      loop.stop();
      currentLevel = 0;
      level.emit(0);
    }
    speakingChange.emit(next);
  }

  function refreshVoice(): void {
    if (!synth) return;
    voice = pickRussianVoice(synth.getVoices());
  }

  function makeUtterance(text: string): SpeechSynthesisUtterance {
    const utterance = options.createUtterance ? options.createUtterance(text) : new SpeechSynthesisUtterance(text);
    utterance.lang = 'ru-RU';
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;
    return utterance;
  }

  /** Safari only unlocks speech when speak() itself runs inside the gesture handler. */
  function warmUp(): void {
    if (!synth || synth.speaking || synth.pending) return;
    const utterance = makeUtterance(' ');
    utterance.volume = 0;
    synth.speak(utterance);
  }

  async function init(): Promise<void> {
    if (disposed) throw new Error('browser TTS voice was disposed');
    const found = options.synth ?? (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null);
    if (!found) throw new Error('speechSynthesis is not available in this browser');
    const candidate: SpeechSynthesis = found;
    if (!options.createUtterance && typeof SpeechSynthesisUtterance === 'undefined') {
      throw new Error('SpeechSynthesisUtterance is not available in this browser');
    }
    synth = candidate;
    // a previous page may have left the queue stuck
    synth.cancel();

    const onVoicesChanged = (): void => refreshVoice();
    synth.addEventListener('voiceschanged', onVoicesChanged);
    cleanups.push(() => candidate.removeEventListener('voiceschanged', onVoicesChanged));

    refreshVoice();
    if (synth.getVoices().length === 0) {
      // Chrome fills the list asynchronously
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, VOICES_WAIT_MS);
        function done(): void {
          clearTimeout(timer);
          candidate.removeEventListener('voiceschanged', done);
          resolve();
        }
        candidate.addEventListener('voiceschanged', done);
      });
      refreshVoice();
    }

    gate = createGestureGate({ onUnlock: warmUp, hasUserActivation: options.hasUserActivation });
    gate.onChange((needs) => gestureChange.emit(needs));
    cleanups.push(() => gate?.dispose());
  }

  function speakChunk(text: string, owner: SpeechSession): Promise<void> {
    return new Promise<void>((resolve) => {
      const activeSynth = synth;
      if (!activeSynth || owner.cancelled) {
        resolve();
        return;
      }
      const utterance = makeUtterance(text);
      liveUtterances.add(utterance);
      let settled = false;
      let keepAlive: ReturnType<typeof setInterval> | null = null;

      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        if (keepAlive !== null) clearInterval(keepAlive);
        liveUtterances.delete(utterance);
        utteranceActive = false;
        resolve();
      };

      // Chrome sometimes never fires `end` (the 15-second bug, lost network voice…)
      const watchdog = setTimeout(
        () => {
          if (settled) return;
          console.warn('[coach] speech watchdog fired — cancelling a stuck utterance');
          lastCancelAt = nowMs();
          activeSynth.cancel();
          settle();
        },
        estimateSpeechMs(text, 110) * 1.6 + 4000,
      );

      utterance.onstart = () => {
        utteranceActive = true;
        // sound is obviously allowed (browsers without the userActivation API land here)
        gate?.unlock();
        setSpeaking(true);
        keepAlive = setInterval(() => {
          // long utterances die silently in Chrome unless the queue is poked
          if (activeSynth.speaking && !activeSynth.paused) {
            activeSynth.pause();
            activeSynth.resume();
          }
        }, KEEP_ALIVE_AFTER_MS);
      };
      utterance.onboundary = () => {
        envelope.kick(nowMs() - speechStartedAt);
      };
      utterance.onend = settle;
      utterance.onerror = (event) => {
        const reason = (event as SpeechSynthesisErrorEvent).error;
        if (reason === 'not-allowed') {
          // no user gesture yet: stop this whole speech, the dock will ask for a tap
          gate?.lock();
          owner.cancelled = true;
        } else if (reason !== 'interrupted' && reason !== 'canceled') {
          console.warn('[coach] speech synthesis error:', reason);
        }
        settle();
      };

      const start = (): void => {
        if (owner.cancelled || disposed) {
          settle();
          return;
        }
        try {
          // a paused queue would swallow the utterance
          if (activeSynth.paused) activeSynth.resume();
          activeSynth.speak(utterance);
        } catch (error) {
          console.warn('[coach] speechSynthesis.speak failed', error);
          settle();
        }
      };
      // Chrome drops an utterance queued right after cancel()
      const sinceCancel = nowMs() - lastCancelAt;
      if (sinceCancel < AFTER_CANCEL_DELAY_MS) setTimeout(start, AFTER_CANCEL_DELAY_MS - sinceCancel);
      else start();
    });
  }

  function cancelSession(): void {
    const active = session;
    if (!active) return;
    active.cancelled = true;
    if (synth && (synth.speaking || synth.pending)) {
      lastCancelAt = nowMs();
      synth.cancel();
    }
    active.finish();
  }

  async function speak(text: string, opts?: { interrupt?: boolean }): Promise<void> {
    if (disposed || !synth) return;
    if (opts?.interrupt) {
      // an urgent phrase goes ahead of everybody who is politely waiting
      urgentWaiting++;
      cancelSession();
      try {
        while (session) await session.done;
      } finally {
        urgentWaiting--;
      }
    } else {
      // without `interrupt` wait for whatever is being said
      while (session || urgentWaiting > 0) await (session?.done ?? Promise.resolve());
    }
    if (disposed) return;

    const chunks = splitIntoSentences(text);
    if (chunks.length === 0) return;

    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const own: SpeechSession = { cancelled: false, finish, done };
    session = own;

    void (async () => {
      for (const chunk of chunks) {
        if (own.cancelled) break;
        await speakChunk(chunk, own);
      }
      own.finish();
    })();

    await done;
    if (session === own) {
      session = null;
      setSpeaking(false);
    }
  }

  return {
    kind: 'browser-tts',
    get voiceName() {
      return voice?.name ?? null;
    },
    get needsUserGesture() {
      return gate?.needsUserGesture ?? true;
    },
    onNeedsUserGestureChange: (cb) => gestureChange.on(cb),
    unlock() {
      gate?.unlock();
    },
    init,
    speak,
    stop() {
      cancelSession();
    },
    onLevel: (cb) => level.on(cb),
    onSpeakingChange: (cb) => speakingChange.on(cb),
    dispose() {
      if (disposed) return;
      cancelSession();
      disposed = true;
      loop.stop();
      for (const cleanup of cleanups.splice(0)) cleanup();
      liveUtterances.clear();
      level.clear();
      speakingChange.clear();
      gestureChange.clear();
    },
  };
}
