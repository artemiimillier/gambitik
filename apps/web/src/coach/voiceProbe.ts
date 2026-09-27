/**
 * Voice probe — a timestamped log of what the voice layers do, for the manual live-voice smoke test
 * (tools/voice-smoke). It exists ONLY when BOTH are true:
 *   - the browser is automation-driven (`navigator.webdriver === true`), and
 *   - the run explicitly opted into real voice (`localStorage['gambit.e2eVoice'] = 'on'` / `?e2eVoice=on`).
 * A real child in a real browser never gets it, and an ordinary (silent, free) e2e run never gets it either.
 *
 * What is logged: state changes of the coach store (voice kind, connected, speaking, child speaking), final
 * transcripts, the TYPE of every data-channel event in both directions, the code + message of API `error` events,
 * and what the app answered to a delegated question. No audio, no keys (the browser has none), no SDP.
 */
import { automationVoiceOptIn, isAutomatedBrowser } from '../automation.ts';

export interface VoiceProbeEntry {
  /** `Date.now()` */
  t: number;
  type: string;
  [key: string]: unknown;
}

export interface VoiceProbe {
  log: VoiceProbeEntry[];
}

declare global {
  interface Window {
    __gambitVoiceProbe?: VoiceProbe;
  }
}

const MAX_ENTRIES = 5000;
const MAX_TEXT = 1400;

let enabled: boolean | null = null;

export function voiceProbeEnabled(): boolean {
  if (enabled !== null) return enabled;
  try {
    enabled = typeof window !== 'undefined' && isAutomatedBrowser() && automationVoiceOptIn();
  } catch {
    enabled = false;
  }
  return enabled;
}

/** Test seam: forget the cached decision. */
export function resetVoiceProbeForTests(): void {
  enabled = null;
  if (typeof window !== 'undefined') delete window.__gambitVoiceProbe;
}

function clipValue(value: unknown): unknown {
  return typeof value === 'string' && value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

/** Appends one entry; a no-op (and allocation-free) unless the probe is enabled. */
export function probeVoice(type: string, data: Record<string, unknown> = {}): void {
  if (!voiceProbeEnabled()) return;
  const probe = (window.__gambitVoiceProbe ??= { log: [] });
  if (probe.log.length >= MAX_ENTRIES) return;
  const entry: VoiceProbeEntry = { t: Date.now(), type };
  for (const [key, value] of Object.entries(data)) entry[key] = clipValue(value);
  probe.log.push(entry);
}

/** One data-channel event: its type, plus code / message when the API reports an error. */
export function probeWireEvent(direction: 'in' | 'out', event: unknown): void {
  if (!voiceProbeEnabled() || typeof event !== 'object' || event === null) return;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '?';
  if (type === 'error' || type.endsWith('.failed')) {
    const error = typeof record.error === 'object' && record.error !== null ? (record.error as Record<string, unknown>) : {};
    probeVoice(`wire.${direction}`, { event: type, code: error.code ?? error.type ?? null, message: error.message ?? null, param: error.param ?? null });
    return;
  }
  probeVoice(`wire.${direction}`, { event: type });
}

interface ProbedStore {
  getState(): object;
  subscribe(listener: (state: object) => void): () => void;
}

interface ProbedCoach {
  onTranscript(cb: (who: 'child' | 'coach', text: string) => void): () => void;
}

const WATCHED_FIELDS = [
  'voiceKind',
  'voiceConnected',
  'speaking',
  'childSpeaking',
  'micAvailable',
  'micMuted',
  'asleep',
  'needsUserGesture',
  'bubbleText',
  'conversationState',
  'conversationOn',
] as const;

/** Follows the coach store and the transcripts. A no-op unless the probe is enabled. */
export function installVoiceProbe(coach: ProbedCoach, store: ProbedStore): void {
  if (!voiceProbeEnabled()) return;
  let last: Record<string, unknown> = {};
  const snapshot = (state: object): void => {
    const source = state as Record<string, unknown>;
    for (const field of WATCHED_FIELDS) {
      if (source[field] === last[field]) continue;
      probeVoice('store', { field, value: source[field] });
    }
    last = Object.fromEntries(WATCHED_FIELDS.map((field) => [field, source[field]]));
  };
  snapshot(store.getState());
  store.subscribe(snapshot);
  coach.onTranscript((who, text) => probeVoice('transcript', { who, text }));
}
