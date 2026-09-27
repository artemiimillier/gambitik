/**
 * «Послушать» — the parent hears a voice before Гамбитик speaks with it (Settings, behind the parental lock).
 *
 * Гамбитик needs a young, childlike voice; the .env default `marin` is an adult woman and Гамбитик is a boy foal.
 * OpenAI has no child's voice and no Russian one (research 03 §3.6), so only listening can tell. The preview says ONE
 * short line through the SAME machinery as the coach — a Live session (`POST /api/voice/live { sdp, voice }`) when the
 * server has Live, else Realtime — with the microphone never asked for (push-to-talk mode, nothing held), no robot
 * fallback voice, and closes the session right after. It is PAID: a Live session bills its first 15 s at once
 * (≈ 1–2 US cents in all) and the seconds go to the usage log like any session — the button says so.
 *
 * Impossible under automation: `navigator.webdriver` refuses here before anything is built or requested (also with the
 * e2e voice opt-in), the Settings screen does not render the button, and the server refuses `X-Gambit-Automation`.
 */
import type { VoiceLayer } from '@gambit/shared';
import { isAutomatedBrowser } from '../automation.ts';
import { createLiveVoiceSession, createRealtimeVoiceSession } from './liveApi.ts';
import { createOpenAiLiveVoice } from './liveVoice.ts';
import { createOpenAiRealtimeVoice } from './realtimeVoice.ts';
import { createSilentVoice } from './silentVoice.ts';
import { diag } from './voiceDiag.ts';
import type { OpenAiVoiceKind } from './voiceTypes.ts';
import type { Unsubscribe } from './voiceUtils.ts';

/** what he says in the preview — a boy foal introducing himself (the model may say it in its own words) */
export const VOICE_PREVIEW_LINE_RU = 'Привет! Я Гамбитик, весёлый шахматный конь. Давай сыграем партию?';

/** the button's own warning: the parent must know it costs money */
export const VOICE_PREVIEW_COST_RU = 'Платно: открывается сессия OpenAI, одна фраза стоит примерно 1–2 цента.';

/**
 * What OpenAI's own descriptions say about the voices (research 03 §3.6, §4.3) — for a parent, short. Not checked by
 * ear, and none of them is a child's voice: listening decides.
 */
export const VOICE_NOTES_RU: Readonly<Record<string, string>> = {
  marin: 'женский, самый естественный',
  coral: 'женский, тёплый',
  shimmer: 'женский, тёплый',
  gleam: 'женский',
  cedar: 'мужской, спокойный',
  meridian: 'мужской',
  ballad: 'выразительный',
  verse: 'выразительный',
};

/** the text of one voice button: the name, OpenAI's note, «только Live» when the fallback model does not have it */
export function voiceButtonLabel(option: { id: string; realtime: boolean }): string {
  const note = VOICE_NOTES_RU[option.id];
  const parts = [option.id];
  if (note) parts.push(note);
  if (!option.realtime) parts.push('только Live');
  return parts.join(' · ');
}

/** which paid model the preview uses: Live when the server has it, else Realtime (if that model knows the voice) */
export function previewKindFor(voice: { live: boolean; realtime: boolean }, server: { live: boolean; realtime: boolean }): OpenAiVoiceKind | null {
  if (server.live && voice.live) return 'openai-live';
  if (server.realtime && voice.realtime) return 'openai-realtime';
  return null;
}

/**
 * 'spoken'     — the model spoke (the page heard its audio start);
 * 'silent'     — the session opened but no sound came (the parent is told to use «Проверить звук»);
 * 'failed'     — no session (network, key, limit — the server log / black box say why);
 * 'automation' — refused: an automated browser.
 */
export type VoicePreviewOutcome = 'spoken' | 'silent' | 'failed' | 'automation';

/** the parts of a paid layer the preview uses (a SessionVoice, or a fake in tests) */
export type PreviewLayer = VoiceLayer & {
  setMicMode?(mode: 'open' | 'push'): Promise<void>;
  setEchoGuard?(enabled: boolean): void;
  onConnectedChange?(cb: (connected: boolean) => void): Unsubscribe;
  onUnavailable?(cb: (reason: string) => void): Unsubscribe;
};

export interface VoicePreviewDeps {
  isAutomated?: () => boolean;
  createLayer?: (kind: OpenAiVoiceKind, voice: string) => PreviewLayer;
  /** the last words may still be playing when speak() settles */
  tailMs?: number;
  /** the whole preview is over after this long, whatever happens */
  maxMs?: number;
}

function defaultLayer(kind: OpenAiVoiceKind, voice: string): PreviewLayer {
  // no robot voice instead of the one the parent wants to hear; one failed connect is enough
  const common = { createFallback: () => createSilentVoice(), maxConnectFailures: 1, reconnectWaitMs: 12_000 };
  return kind === 'openai-live'
    ? createOpenAiLiveVoice({ ...common, createSession: (sdp) => createLiveVoiceSession(sdp, { voice }) })
    : createOpenAiRealtimeVoice({ ...common, createSession: () => createRealtimeVoiceSession({ voice }) });
}

/** Says one line in `voice`, then closes the (paid) session. Call it from the parent's click. Never throws. */
export async function previewVoice(voice: string, kind: OpenAiVoiceKind, deps: VoicePreviewDeps = {}): Promise<VoicePreviewOutcome> {
  if ((deps.isAutomated ?? (() => isAutomatedBrowser()))()) return 'automation';
  const layer = (deps.createLayer ?? defaultLayer)(kind, voice);
  let spoke = false;
  let connected = false;
  const unsubs: Unsubscribe[] = [
    layer.onSpeakingChange((speaking) => {
      if (speaking) spoke = true;
    }),
  ];
  if (layer.onConnectedChange) {
    unsubs.push(
      layer.onConnectedChange((value) => {
        if (value) connected = true;
      }),
    );
  }
  const maxMs = deps.maxMs ?? 25_000;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  const cap = new Promise<void>((resolve) => {
    capTimer = setTimeout(resolve, maxMs);
  });
  try {
    await Promise.race([
      (async () => {
        await layer.init();
        // the preview never asks for the microphone: push-to-talk with nothing held, no echo guard needed
        await layer.setMicMode?.('push');
        layer.setEchoGuard?.(false);
        await layer.speak(VOICE_PREVIEW_LINE_RU);
        await new Promise((resolve) => setTimeout(resolve, deps.tailMs ?? 1200));
      })(),
      cap,
    ]);
  } catch {
    /* judged below */
  } finally {
    if (capTimer !== null) clearTimeout(capTimer);
    for (const unsub of unsubs) unsub();
    // closes the session at once; its seconds go to the usage log
    layer.dispose();
  }
  const outcome: VoicePreviewOutcome = spoke ? 'spoken' : connected ? 'silent' : 'failed';
  diag('voice.preview', { voice, kind, outcome });
  return outcome;
}

/** the parent-facing sentence after a preview */
export function voicePreviewMessage(voice: string, outcome: VoicePreviewOutcome | 'playing'): string {
  switch (outcome) {
    case 'playing':
      return `Подключаюсь — сейчас Гамбитик скажет фразу голосом ${voice}…`;
    case 'spoken':
      return `Это был голос ${voice}. Нравится — оставьте его; нет — выберите другой и послушайте ещё раз.`;
    case 'silent':
      return 'Гамбитик подключился, но звука не было слышно. Нажмите «Проверить звук» ниже — и попробуйте ещё раз.';
    case 'failed':
      return 'Не получилось подключиться к голосу OpenAI. Проверьте интернет и попробуйте чуть позже.';
    case 'automation':
      return 'В автоматическом режиме голос не включается.';
  }
}
