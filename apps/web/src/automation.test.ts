import { describe, expect, it } from 'vitest';
import { E2E_VOICE_STORAGE_KEY, automationSilenced, automationVoiceOptIn, isAutomatedBrowser } from './automation.ts';

const storage = (values: Record<string, string>) => (key: string) => values[key] ?? null;

describe('automation guard', () => {
  it('a real browser is never silenced', () => {
    expect(automationSilenced({ webdriver: false })).toBe(false);
    expect(automationSilenced({})).toBe(false);
    expect(automationSilenced({ webdriver: false, readStorage: storage({ [E2E_VOICE_STORAGE_KEY]: 'on' }) })).toBe(false);
  });

  it('an automation browser is silent by default', () => {
    expect(isAutomatedBrowser({ webdriver: true })).toBe(true);
    expect(automationSilenced({ webdriver: true })).toBe(true);
    expect(automationSilenced({ webdriver: true, readStorage: storage({}), search: '' })).toBe(true);
  });

  it('only the exact opt-in value switches sound back on', () => {
    expect(automationSilenced({ webdriver: true, readStorage: storage({ [E2E_VOICE_STORAGE_KEY]: 'on' }) })).toBe(false);
    for (const value of ['1', 'true', 'ON', 'off', '']) {
      expect(automationSilenced({ webdriver: true, readStorage: storage({ [E2E_VOICE_STORAGE_KEY]: value }) })).toBe(true);
    }
  });

  it('the opt-in may come from the URL, before or inside the hash route', () => {
    expect(automationVoiceOptIn({ search: '?e2eVoice=on' })).toBe(true);
    expect(automationVoiceOptIn({ search: '&persona=petya&tc=training&e2eVoice=on' })).toBe(true);
    expect(automationVoiceOptIn({ search: '?e2eVoice=off' })).toBe(false);
    expect(automationSilenced({ webdriver: true, search: '?e2eVoice=on' })).toBe(false);
  });

  it('blocked storage never switches sound on and never throws', () => {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    expect(automationSilenced({ webdriver: true, readStorage: blocked })).toBe(true);
    expect(automationSilenced({ webdriver: true, readStorage: blocked, search: 'e2eVoice=on' })).toBe(false);
  });

  it('without a DOM (vitest, node) the default probe reports a normal, unsilenced environment', () => {
    expect(automationSilenced()).toBe(false);
  });
});
