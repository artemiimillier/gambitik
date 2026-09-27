import { describe, expect, it, vi } from 'vitest';
import { SETTINGS_STORAGE_KEY, loadCoachSettings } from '../coach/settings.ts';
import { createMemoryStorage } from './testUtils.ts';
import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings, parseVoiceSettings, saveVoiceSettings } from './voiceSettings.ts';

describe('voice settings of the shell', () => {
  it('defaults: best available voice, open microphone, headphones not confirmed yet', () => {
    expect(loadVoiceSettings(null)).toEqual({ voice: 'auto', micMode: 'open', headphonesConfirmed: false, talkativeness: 'normal', autoConversation: true, voiceDailyLimitMin: 60 });
    expect(loadVoiceSettings(createMemoryStorage())).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(loadVoiceSettings(createMemoryStorage({ [SETTINGS_STORAGE_KEY]: 'not json' }))).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it('reads the agreed names, including the full-duplex voice an older coach loader does not know', () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'live', micMode: 'push', headphonesConfirmed: true, muted: true }) });
    expect(loadVoiceSettings(storage)).toEqual({ voice: 'live', micMode: 'push', headphonesConfirmed: true, talkativeness: 'normal', autoConversation: true, voiceDailyLimitMin: 60 });
  });

  it('reads and writes the conversation settings (talkativeness, autoConversation) under the coach\'s names', async () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ talkativeness: 'quiet', autoConversation: false }) });
    expect(loadVoiceSettings(storage)).toMatchObject({ talkativeness: 'quiet', autoConversation: false });
    const applySettings = vi.fn(() => Promise.resolve());
    await saveVoiceSettings(storage, { talkativeness: 'chatty', autoConversation: true }, { applySettings });
    expect(applySettings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({ talkativeness: 'chatty', autoConversation: true });
    expect(loadCoachSettings(storage)).toMatchObject({ talkativeness: 'chatty', autoConversation: true });
  });

  it('the daily limit of the paid voice: 30 / 60 (default) / 90 / 120 / 0 = no limit, stored under the coach\'s name', async () => {
    expect(DEFAULT_VOICE_SETTINGS.voiceDailyLimitMin).toBe(60);
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voiceDailyLimitMin: 120 }) });
    expect(loadVoiceSettings(storage).voiceDailyLimitMin).toBe(120);
    const applySettings = vi.fn(() => Promise.resolve());
    await saveVoiceSettings(storage, { voiceDailyLimitMin: 0 }, { applySettings });
    expect(applySettings).toHaveBeenCalledTimes(1);
    expect(loadCoachSettings(storage).voiceDailyLimitMin).toBe(0);
    expect(loadVoiceSettings(storage).voiceDailyLimitMin).toBe(0);
    expect(parseVoiceSettings({ voiceDailyLimitMin: 45 }).voiceDailyLimitMin).toBe(60);
  });

  it('ignores junk values', () => {
    expect(parseVoiceSettings({ voice: 'openrouter', micMode: 'always', headphonesConfirmed: 'yes', talkativeness: 'loud', autoConversation: 'yes', voiceDailyLimitMin: '60' })).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parseVoiceSettings({ voice: 'nope' }, { voice: 'browser' })).toMatchObject({ voice: 'browser' });
  });

  it('saves read-modify-write (foreign fields survive) and asks the coach to re-pick its voice', async () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ fontScale: 1.15, muted: true, onboarded: true }) });
    const applySettings = vi.fn(() => Promise.resolve());
    await saveVoiceSettings(storage, { voice: 'live', micMode: 'push' }, { applySettings });
    expect(applySettings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({ fontScale: 1.15, muted: true, onboarded: true, voice: 'live', micMode: 'push' });
    expect(loadVoiceSettings(storage)).toEqual({ voice: 'live', micMode: 'push', headphonesConfirmed: false, talkativeness: 'normal', autoConversation: true, voiceDailyLimitMin: 60 });
  });

  it('works with a coach that has no applySettings() yet, and keeps the real choice stored', async () => {
    const storage = createMemoryStorage();
    const setVoicePreference = vi.fn((preference: string) => {
      // the legacy controller persists what it was given
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}'), voice: preference }));
      return Promise.resolve();
    });
    await saveVoiceSettings(storage, { voice: 'live' }, { setVoicePreference });
    expect(setVoicePreference).toHaveBeenCalledWith('auto');
    expect(loadVoiceSettings(storage).voice).toBe('live');

    await saveVoiceSettings(storage, { micMode: 'push' }, { setVoicePreference });
    expect(setVoicePreference).toHaveBeenCalledTimes(1); // a mic change is not a voice change
    expect(loadVoiceSettings(storage)).toMatchObject({ voice: 'live', micMode: 'push' });
  });

  it('never rejects when the switch fails', async () => {
    const storage = createMemoryStorage();
    await expect(saveVoiceSettings(storage, { voice: 'realtime' }, { applySettings: () => Promise.reject(new Error('no network')) })).resolves.toBeUndefined();
    expect(loadVoiceSettings(storage).voice).toBe('realtime');
  });
});
