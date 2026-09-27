import { describe, expect, it } from 'vitest';
import {
  AI_OFF_VOICE,
  DEFAULT_COACH_SETTINGS,
  SETTINGS_STORAGE_KEY,
  VOICE_DAILY_LIMIT_CHOICES,
  effectiveVoicePreference,
  isMicMode,
  isTalkativeness,
  isVoiceDailyLimit,
  isVoicePreference,
  loadCoachSettings,
  needsRuntimeAi,
  saveCoachSettings,
} from './settings.ts';
import { createMemoryStorage } from './testUtils.ts';

describe('coach settings', () => {
  it('uses defaults without storage, with an empty storage and with broken JSON', () => {
    expect(loadCoachSettings(null)).toEqual(DEFAULT_COACH_SETTINGS);
    expect(loadCoachSettings(createMemoryStorage())).toEqual({ voice: 'auto', muted: false, micMode: 'open', headphonesConfirmed: false, talkativeness: 'normal', autoConversation: true, voiceDailyLimitMin: 60 });
    expect(loadCoachSettings(createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '{oops' }))).toEqual(DEFAULT_COACH_SETTINGS);
    expect(loadCoachSettings(createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '[1,2]' }))).toEqual(DEFAULT_COACH_SETTINGS);
  });

  it('validates every field separately', () => {
    const storage = createMemoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'loud', muted: true, micMode: 'always', headphonesConfirmed: 'yes', talkativeness: 'loud', autoConversation: 'yes' }),
    });
    expect(loadCoachSettings(storage)).toEqual({ voice: 'auto', muted: true, micMode: 'open', headphonesConfirmed: false, talkativeness: 'normal', autoConversation: true, voiceDailyLimitMin: 60 });
    expect(isVoicePreference('realtime')).toBe(true);
    expect(isVoicePreference('live')).toBe(true);
    expect(isVoicePreference('Realtime')).toBe(false);
    expect(isMicMode('push')).toBe(true);
    expect(isMicMode('ptt')).toBe(false);
    expect(isTalkativeness('chatty')).toBe(true);
    expect(isTalkativeness('loud')).toBe(false);
  });

  it('migration: settings written by the older build keep their meaning, the new fields get defaults', () => {
    for (const voice of ['auto', 'browser', 'realtime', 'off'] as const) {
      const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice, muted: false, boardTheme: 'green' }) });
      expect(loadCoachSettings(storage)).toEqual({ voice, muted: false, micMode: 'open', headphonesConfirmed: false, talkativeness: 'normal', autoConversation: true, voiceDailyLimitMin: 60 });
    }
  });

  it('reads the new shared fields: live voice, push microphone, confirmed headphones', () => {
    const storage = createMemoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'live', micMode: 'push', headphonesConfirmed: true }),
    });
    expect(loadCoachSettings(storage)).toEqual({ voice: 'live', muted: false, micMode: 'push', headphonesConfirmed: true, talkativeness: 'normal', autoConversation: true, voiceDailyLimitMin: 60 });
    saveCoachSettings(storage, { micMode: 'open' });
    expect(loadCoachSettings(storage)).toMatchObject({ voice: 'live', micMode: 'open', headphonesConfirmed: true });
  });

  it('saves with read-modify-write so fields of other modules survive', () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ fontScale: 1.15, voice: 'browser' }) });
    saveCoachSettings(storage, { muted: true });
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual({ fontScale: 1.15, voice: 'browser', muted: true });
    expect(loadCoachSettings(storage)).toEqual({ voice: 'browser', muted: true, micMode: 'open', headphonesConfirmed: false, talkativeness: 'normal', autoConversation: true, voiceDailyLimitMin: 60 });
  });

  it('talkativeness and autoConversation: read, validated and saved without losing other fields', () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'live', talkativeness: 'quiet', autoConversation: false, theme: 'mint' }) });
    expect(loadCoachSettings(storage)).toMatchObject({ talkativeness: 'quiet', autoConversation: false });
    saveCoachSettings(storage, { talkativeness: 'chatty' });
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual({ voice: 'live', talkativeness: 'chatty', autoConversation: false, theme: 'mint' });
    saveCoachSettings(storage, { autoConversation: true });
    expect(loadCoachSettings(storage)).toMatchObject({ voice: 'live', talkativeness: 'chatty', autoConversation: true });
  });

  it('the daily limit of the paid voice: 30 / 60 (default) / 90 / 120 / 0 = no limit; anything else is the default', () => {
    expect(DEFAULT_COACH_SETTINGS.voiceDailyLimitMin).toBe(60);
    expect(VOICE_DAILY_LIMIT_CHOICES).toEqual([30, 60, 90, 120, 0]);
    for (const minutes of VOICE_DAILY_LIMIT_CHOICES) {
      const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voiceDailyLimitMin: minutes }) });
      expect(loadCoachSettings(storage).voiceDailyLimitMin).toBe(minutes);
      expect(isVoiceDailyLimit(minutes)).toBe(true);
    }
    for (const junk of [45, -1, '60', null, 1e9]) {
      const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voiceDailyLimitMin: junk }) });
      expect(loadCoachSettings(storage).voiceDailyLimitMin).toBe(60);
      expect(isVoiceDailyLimit(junk)).toBe(false);
    }
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'live', theme: 'mint' }) });
    saveCoachSettings(storage, { voiceDailyLimitMin: 0 });
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual({ voice: 'live', theme: 'mint', voiceDailyLimitMin: 0 });
  });

  it('never throws when the storage is broken', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadCoachSettings(broken)).toEqual(DEFAULT_COACH_SETTINGS);
    expect(() => saveCoachSettings(broken, { muted: true })).not.toThrow();
    expect(() => saveCoachSettings(null, { muted: true })).not.toThrow();
  });
});

describe('the voice without runtime AI (docs/TEACHING.md §4.4)', () => {
  it('AI_OFF_VOICE is the recorded voice (one constant; «browser» is the other allowed value)', () => {
    expect(AI_OFF_VOICE).toBe('clips');
    expect(['clips', 'browser']).toContain(AI_OFF_VOICE);
  });

  it('auto / live / realtime need runtime AI and mean AI_OFF_VOICE without it; the free choices keep their meaning; with it nothing changes', () => {
    for (const preference of ['auto', 'live', 'realtime'] as const) {
      expect(needsRuntimeAi(preference)).toBe(true);
      expect(effectiveVoicePreference(preference, false)).toBe(AI_OFF_VOICE);
      expect(effectiveVoicePreference(preference, true)).toBe(preference);
    }
    for (const preference of ['clips', 'browser', 'off'] as const) {
      expect(needsRuntimeAi(preference)).toBe(false);
      expect(effectiveVoicePreference(preference, false)).toBe(preference);
      expect(effectiveVoicePreference(preference, true)).toBe(preference);
    }
  });

  it('the stored default stays «auto» — it resolves to AI_OFF_VOICE on the server that forbids AI, the stored value is never rewritten', () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'live' }) });
    expect(DEFAULT_COACH_SETTINGS.voice).toBe('auto');
    expect(effectiveVoicePreference(loadCoachSettings(storage).voice, false)).toBe(AI_OFF_VOICE);
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({ voice: 'live' });
  });
});
