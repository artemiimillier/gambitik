/**
 * The shell's view of the coach's voice settings (localStorage 'gambit.settings', owned by ../coach/settings.ts).
 *
 * Names agreed with the coach module:
 *   voice: 'auto' | 'live' | 'realtime' | 'browser' | 'off' | 'clips'
 *          ('auto' = health.voice.preferred → live → realtime → browser; 'clips' = «Записи», the pre-recorded voice)
 *   micMode: 'open' | 'push'                                  (default 'open' — full duplex needs an open microphone)
 *   headphonesConfirmed: boolean                              (default false → the one-time «надень наушники» note)
 *   talkativeness: 'quiet' | 'normal' | 'chatty'              (default 'normal' — how often the live coach speaks up by itself)
 *   autoConversation: boolean                                 (default true — a game opens the voice conversation by itself)
 *   voiceDailyLimitMin: 30 | 60 | 90 | 120 | 0                (default 60 — minutes of paid live voice per day; 0 = no limit)
 *
 * Without the server's runtime AI (docs/TEACHING.md §4.4, `health.ai.runtime`) 'auto' / 'live' / 'realtime' speak with
 * `AI_OFF_VOICE` (../coach/settings.ts) and Settings shows that tile pressed — the stored value is never rewritten, so
 * switching the flag on brings the parent's old choice back; the microphone / conversation / limit fields are unused.
 *
 * Reads and writes go through the coach settings API. The types here are deliberately the WIDE ones: with a coach
 * module on a narrower `VoicePreference` this file compiles and works either way — the value is stored as is and a
 * coach that does not know a voice simply treats it as 'auto'.
 */
import { SETTINGS_STORAGE_KEY, coach, loadCoachSettings, saveCoachSettings } from '../coach/index.ts';
import { readJsonObject } from './shellSettings.ts';
import type { KeyValueStorage } from './shellSettings.ts';

export type VoiceChoice = 'auto' | 'live' | 'realtime' | 'browser' | 'off' | 'clips';
export type MicChoice = 'open' | 'push';
export type TalkativenessChoice = 'quiet' | 'normal' | 'chatty';
/** minutes of paid live voice per local day; 0 = «без лимита» */
export type DailyLimitChoice = 30 | 60 | 90 | 120 | 0;
export const DAILY_LIMIT_CHOICES: readonly DailyLimitChoice[] = [30, 60, 90, 120, 0];

export interface VoiceSettings {
  voice: VoiceChoice;
  micMode: MicChoice;
  headphonesConfirmed: boolean;
  talkativeness: TalkativenessChoice;
  autoConversation: boolean;
  voiceDailyLimitMin: DailyLimitChoice;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voice: 'auto',
  micMode: 'open',
  headphonesConfirmed: false,
  talkativeness: 'normal',
  autoConversation: true,
  voiceDailyLimitMin: 60,
};

const VOICE_CHOICES: readonly VoiceChoice[] = ['auto', 'live', 'realtime', 'browser', 'off', 'clips'];

export function isVoiceChoice(value: unknown): value is VoiceChoice {
  return VOICE_CHOICES.some((choice) => choice === value);
}

export function isMicChoice(value: unknown): value is MicChoice {
  return value === 'open' || value === 'push';
}

export function isTalkativenessChoice(value: unknown): value is TalkativenessChoice {
  return value === 'quiet' || value === 'normal' || value === 'chatty';
}

export function isDailyLimitChoice(value: unknown): value is DailyLimitChoice {
  return DAILY_LIMIT_CHOICES.some((choice) => choice === value);
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/** Pure: the voice fields out of any settings-like object; everything unknown falls back to the defaults. */
export function parseVoiceSettings(...sources: readonly Record<string, unknown>[]): VoiceSettings {
  const pickFirst = <T>(key: string, isValid: (value: unknown) => value is T, fallback: T): T => {
    for (const source of sources) {
      const value = source[key];
      if (isValid(value)) return value;
    }
    return fallback;
  };
  return {
    voice: pickFirst('voice', isVoiceChoice, DEFAULT_VOICE_SETTINGS.voice),
    micMode: pickFirst('micMode', isMicChoice, DEFAULT_VOICE_SETTINGS.micMode),
    headphonesConfirmed: pickFirst('headphonesConfirmed', isBoolean, DEFAULT_VOICE_SETTINGS.headphonesConfirmed),
    talkativeness: pickFirst('talkativeness', isTalkativenessChoice, DEFAULT_VOICE_SETTINGS.talkativeness),
    autoConversation: pickFirst('autoConversation', isBoolean, DEFAULT_VOICE_SETTINGS.autoConversation),
    voiceDailyLimitMin: pickFirst('voiceDailyLimitMin', isDailyLimitChoice, DEFAULT_VOICE_SETTINGS.voiceDailyLimitMin),
  };
}

/**
 * Current voice settings: what the coach module's loader understands, completed from the raw stored object for
 * the fields (or values, e.g. voice 'live') the coach loader may not know.
 */
export function loadVoiceSettings(storage: KeyValueStorage | null): VoiceSettings {
  let fromCoach: Record<string, unknown> = {};
  try {
    fromCoach = { ...(loadCoachSettings(storage) as unknown as Record<string, unknown>) };
  } catch {
    fromCoach = {};
  }
  const raw = readJsonObject(storage, SETTINGS_STORAGE_KEY);
  // the raw object wins for `voice`: a coach loader that does not know 'live' maps it to its own default
  return parseVoiceSettings({ voice: raw.voice }, fromCoach, raw);
}

type WideSave = (storage: KeyValueStorage | null, patch: Partial<VoiceSettings>) => void;

interface RuntimeCoach {
  applySettings?: () => Promise<void>;
  setVoicePreference?: (preference: string) => Promise<void>;
}

/**
 * Persists a change through the coach settings API and asks the coach to re-pick its voice layer at once.
 * `coach.applySettings()` is the entry point; a coach without it gets `setVoicePreference` for the values it knows. Never rejects — a failed switch must not break the page.
 */
export async function saveVoiceSettings(storage: KeyValueStorage | null, patch: Partial<VoiceSettings>, runtime: RuntimeCoach = coach as unknown as RuntimeCoach): Promise<void> {
  (saveCoachSettings as unknown as WideSave)(storage, patch);
  try {
    if (typeof runtime.applySettings === 'function') {
      await runtime.applySettings();
    } else if (patch.voice !== undefined && typeof runtime.setVoicePreference === 'function') {
      // a coach without applySettings: 'live' is unknown to it — 'auto' is its closest behaviour (best available voice)
      await runtime.setVoicePreference(patch.voice === 'live' ? 'auto' : patch.voice);
      if (patch.voice === 'live') (saveCoachSettings as unknown as WideSave)(storage, { voice: 'live' }); // keep the parent's real choice stored
    }
  } catch {
    /* the coach reports its own fallback (browser voice); the stored choice stays */
  }
}
