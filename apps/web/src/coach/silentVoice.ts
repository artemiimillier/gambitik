/**
 * Silent voice layer: no sound at all. `speak()` still takes a natural reading time so the
 * speech bubble stays in sync with the queue, and the mouth can keep flapping quietly —
 * text-only dialogue the way games do it.
 */
import type { VoiceLayer } from '@gambit/shared';
import { createEmitter, createFrameLoop, createMouthEnvelope, estimateSpeechMs } from './voiceUtils.ts';

export interface SilentVoiceOptions {
  /** reading speed used to time `speak()`; default 55 ms per character */
  msPerChar?: number;
  minMs?: number;
  maxMs?: number;
  /** animate the mouth while "reading"; default true */
  animateMouth?: boolean;
}

export function createSilentVoice(options: SilentVoiceOptions = {}): VoiceLayer {
  const { msPerChar = 55, minMs = 1200, maxMs = 9000, animateMouth = true } = options;
  const level = createEmitter<number>();
  const speakingChange = createEmitter<boolean>();

  let current: { finish: () => void } | null = null;
  let disposed = false;

  function speak(text: string): Promise<void> {
    if (disposed) return Promise.resolve();
    current?.finish();
    if (text.trim() === '') return Promise.resolve();

    return new Promise<void>((resolve) => {
      const duration = Math.min(maxMs, Math.max(minMs, estimateSpeechMs(text, msPerChar)));
      const envelope = createMouthEnvelope();
      let startedAt: number | null = null;
      const loop = createFrameLoop((now) => {
        startedAt ??= now;
        // quieter than a real voice: he is "whispering" the subtitles
        level.emit(envelope.sample(now - startedAt) * 0.55);
      });
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        loop.stop();
        if (current === entry) current = null;
        level.emit(0);
        speakingChange.emit(false);
        resolve();
      };
      const entry = { finish };
      current = entry;
      const timer = setTimeout(finish, duration);
      speakingChange.emit(true);
      if (animateMouth) loop.start();
    });
  }

  return {
    kind: 'silent',
    init: () => Promise.resolve(),
    speak,
    stop() {
      current?.finish();
    },
    onLevel: (cb) => level.on(cb),
    onSpeakingChange: (cb) => speakingChange.on(cb),
    dispose() {
      disposed = true;
      current?.finish();
      level.clear();
      speakingChange.clear();
    },
  };
}
