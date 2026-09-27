/**
 * Coach part of the app settings, stored in localStorage under `gambit.settings`.
 * The same JSON object may carry fields of other modules (the shell's Settings screen),
 * so writes are read-modify-write and unknown fields are preserved.
 *
 * Field names are a contract with the Settings screen (another module writes the same keys):
 *   voice: 'auto' | 'live' | 'realtime' | 'browser' | 'off' | 'clips'
 *   micMode: 'open' | 'push'                      (default 'open')
 *   headphonesConfirmed: boolean                  (default false)
 *   muted: boolean
 *   talkativeness: 'quiet' | 'normal' | 'chatty'  (default 'normal') — how often the conversational coach speaks up on its own
 *   autoConversation: boolean                     (default true)     — a game (not 1-minute bullet) opens the conversation by itself
 *   voiceDailyLimitMin: 30 | 60 | 90 | 120 | 0     (default 60)       — minutes of paid live voice per local day; 0 = no limit
 *
 * Without the server's runtime AI (docs/TEACHING.md §4.4) 'auto' / 'live' / 'realtime' speak with `AI_OFF_VOICE`
 * (the stored value stays as it is), and micMode / headphonesConfirmed / talkativeness / autoConversation /
 * voiceDailyLimitMin are not used. The sound switches of ./soundMute.ts keep their own keys (gambit.sound.*).
 */
import type { MicMode, Talkativeness } from '@gambit/shared';

export const SETTINGS_STORAGE_KEY = 'gambit.settings';

/**
 * 'auto'     = what the server prefers (`health.voice.preferred`, 'live' by default) → the other OpenAI voice → browser
 * 'live'     = full-duplex gpt-live first
 * 'realtime' = gpt-realtime first
 * 'browser'  = free speechSynthesis, 'off' = bubble only
 * 'clips'    = «Записи»: the pre-recorded voice (free, no microphone; docs/voice-clips/SPEC.md §8.1) → silent without a library
 */
export type VoicePreference = 'auto' | 'live' | 'realtime' | 'browser' | 'off' | 'clips';

/**
 * The lesson model (docs/TEACHING.md §4.4): generative AI is off in the child's game unless the server says
 * `health.ai.runtime === true` (flag GAMBIT_RUNTIME_AI; absent or offline = off). Then 'auto' / 'live' / 'realtime'
 * speak with THIS voice — the one place to switch: 'clips' = «Записанный голос» (new lesson phrases stay in the bubble
 * until they are recorded), 'browser' = the robot voice reads every phrase. The stored preference is never rewritten.
 */
export const AI_OFF_VOICE: 'clips' | 'browser' = 'clips';

/** The generative-AI voices: they need the server's runtime AI (a live OpenAI session and a microphone). */
export function needsRuntimeAi(preference: VoicePreference): boolean {
  return preference === 'auto' || preference === 'live' || preference === 'realtime';
}

/** What a stored preference means right now: without runtime AI the AI voices become `AI_OFF_VOICE`. */
export function effectiveVoicePreference(preference: VoicePreference, runtimeAi: boolean): VoicePreference {
  return !runtimeAi && needsRuntimeAi(preference) ? AI_OFF_VOICE : preference;
}

export interface CoachSettings {
  voice: VoicePreference;
  muted: boolean;
  /** 'open' = the microphone listens all the time (needs headphones), 'push' = hold the button to talk */
  micMode: MicMode;
  /** the child (or a parent) said «Я в наушниках»: the echo guard is not needed */
  headphonesConfirmed: boolean;
  /** 'quiet' = only urgent phrases + answers, 'normal' = priority ≥ 1, 'chatty' = everything (conversational voices) */
  talkativeness: Talkativeness;
  /** a game start opens the voice conversation by itself (a conversational voice is available, not in bullet) */
  autoConversation: boolean;
  /**
   * The parent's daily budget of paid live voice, in minutes per local calendar day (0 = no limit). Once today's
   * minutes are used up the session closes and does not reopen until midnight; the coach goes on in the bubble.
   */
  voiceDailyLimitMin: VoiceDailyLimitMin;
}

/** the choices of the Settings screen; 0 = «без лимита» */
export const VOICE_DAILY_LIMIT_CHOICES = [30, 60, 90, 120, 0] as const;
export type VoiceDailyLimitMin = (typeof VOICE_DAILY_LIMIT_CHOICES)[number];

export const DEFAULT_COACH_SETTINGS: CoachSettings = {
  voice: 'auto',
  muted: false,
  micMode: 'open',
  headphonesConfirmed: false,
  talkativeness: 'normal',
  autoConversation: true,
  voiceDailyLimitMin: 60,
};

export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

const VOICE_PREFERENCES: readonly VoicePreference[] = ['auto', 'live', 'realtime', 'browser', 'off', 'clips'];
const TALKATIVENESS: readonly Talkativeness[] = ['quiet', 'normal', 'chatty'];

export function isVoicePreference(value: unknown): value is VoicePreference {
  return VOICE_PREFERENCES.some((v) => v === value);
}

export function isMicMode(value: unknown): value is MicMode {
  return value === 'open' || value === 'push';
}

export function isTalkativeness(value: unknown): value is Talkativeness {
  return TALKATIVENESS.some((v) => v === value);
}

export function isVoiceDailyLimit(value: unknown): value is VoiceDailyLimitMin {
  return VOICE_DAILY_LIMIT_CHOICES.some((v) => v === value);
}

/** localStorage can throw (private mode, disabled cookies) — treat that as "no storage". */
export function getBrowserStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readRaw(storage: SettingsStorage | null): Record<string, unknown> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Settings written by an older build have no `micMode` / `headphonesConfirmed` / `talkativeness` / `autoConversation` / `voiceDailyLimitMin`
 * and only know 'auto' | 'browser' | 'realtime' | 'off' — all of those keep their meaning, the new fields get defaults.
 */
export function loadCoachSettings(storage: SettingsStorage | null): CoachSettings {
  const raw = readRaw(storage);
  return {
    voice: isVoicePreference(raw.voice) ? raw.voice : DEFAULT_COACH_SETTINGS.voice,
    muted: typeof raw.muted === 'boolean' ? raw.muted : DEFAULT_COACH_SETTINGS.muted,
    micMode: isMicMode(raw.micMode) ? raw.micMode : DEFAULT_COACH_SETTINGS.micMode,
    headphonesConfirmed: typeof raw.headphonesConfirmed === 'boolean' ? raw.headphonesConfirmed : DEFAULT_COACH_SETTINGS.headphonesConfirmed,
    talkativeness: isTalkativeness(raw.talkativeness) ? raw.talkativeness : DEFAULT_COACH_SETTINGS.talkativeness,
    autoConversation: typeof raw.autoConversation === 'boolean' ? raw.autoConversation : DEFAULT_COACH_SETTINGS.autoConversation,
    voiceDailyLimitMin: isVoiceDailyLimit(raw.voiceDailyLimitMin) ? raw.voiceDailyLimitMin : DEFAULT_COACH_SETTINGS.voiceDailyLimitMin,
  };
}

export function saveCoachSettings(storage: SettingsStorage | null, patch: Partial<CoachSettings>): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...readRaw(storage), ...patch }));
  } catch {
    /* quota / private mode: settings simply do not persist */
  }
}
