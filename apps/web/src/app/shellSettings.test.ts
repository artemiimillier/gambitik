import { describe, expect, it } from 'vitest';
import { SETTINGS_STORAGE_KEY, loadCoachSettings } from '../coach/settings.ts';
import { DEFAULT_SHELL_SETTINGS, applyFontScale, loadShellSettings, readJsonObject, saveShellSettings, writeJson } from './shellSettings.ts';
import { createMemoryStorage } from './testUtils.ts';

describe('shell settings', () => {
  it('uses defaults without storage, with an empty storage and with junk', () => {
    expect(loadShellSettings(null)).toEqual(DEFAULT_SHELL_SETTINGS);
    expect(loadShellSettings(createMemoryStorage())).toEqual({ onboarded: false, fontScale: 1, reducedMotion: null, boardTheme: 'mint' });
    expect(loadShellSettings(createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '{oops' }))).toEqual(DEFAULT_SHELL_SETTINGS);
    expect(loadShellSettings(createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ fontScale: 2, onboarded: 'yes', reducedMotion: 1, boardTheme: 'neon' }) }))).toEqual(DEFAULT_SHELL_SETTINGS);
  });

  it('shares the storage object with the coach settings without clobbering them', () => {
    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ voice: 'browser', muted: true }) });
    saveShellSettings(storage, { fontScale: 1.3, onboarded: true });
    saveShellSettings(storage, { reducedMotion: true });
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({ voice: 'browser', muted: true, fontScale: 1.3, onboarded: true, reducedMotion: true });
    expect(loadShellSettings(storage)).toEqual({ onboarded: true, fontScale: 1.3, reducedMotion: true, boardTheme: 'mint' });

    // the board colours GameScreen reads from the same object
    saveShellSettings(storage, { boardTheme: 'sky' });
    expect(loadShellSettings(storage).boardTheme).toBe('sky');
    expect(JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ voice: 'browser', boardTheme: 'sky' });
    // toMatchObject: the coach module may carry more fields of its own (micMode, headphonesConfirmed, …)
    expect(loadCoachSettings(storage)).toMatchObject({ voice: 'browser', muted: true });

    saveShellSettings(storage, { reducedMotion: null });
    expect(loadShellSettings(storage).reducedMotion).toBeNull();
  });

  it('never throws when the storage is broken', () => {
    const broken = {
      getItem: (): string => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('quota');
      },
    };
    expect(readJsonObject(broken, 'x')).toEqual({});
    expect(writeJson(broken, 'x', { a: 1 })).toBe(false);
    expect(writeJson(null, 'x', 1)).toBe(false);
    expect(loadShellSettings(broken)).toEqual(DEFAULT_SHELL_SETTINGS);
    expect(() => saveShellSettings(broken, { onboarded: true })).not.toThrow();
  });

  it('applies the font scale to the --font-scale token', () => {
    const calls: string[] = [];
    const root = {
      style: {
        setProperty: (name: string, value: string) => calls.push(`set ${name}=${value}`),
        removeProperty: (name: string) => calls.push(`remove ${name}`),
      },
    } as unknown as HTMLElement;
    applyFontScale(1.15, root);
    applyFontScale(1, root);
    expect(calls).toEqual(['set --font-scale=1.15', 'remove --font-scale']);
    expect(() => applyFontScale(1.3, null)).not.toThrow();
  });
});
