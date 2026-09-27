/**
 * «Записи» in Settings (docs/voice-clips/SPEC.md §8.1, §11): the recorded voice is one more choice behind the parental
 * lock — the default stays as it was — the 'clips' preference round-trips through `gambit.settings`, and the status
 * says which library is loaded, how the last game sounded, or why it is silent.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { clipPreviewEvent, describeClipsVoice, CLIPS_VOICE_OPTION } from '../coach/clips/clipSettings.ts';
import { AI_OFF_VOICE, DEFAULT_COACH_SETTINGS, SETTINGS_STORAGE_KEY, effectiveVoicePreference, loadCoachSettings, saveCoachSettings } from '../coach/settings.ts';
import { createMemoryStorage } from '../coach/testUtils.ts';
import { Settings } from './Settings.tsx';
import { sampleHealth, sampleProfile } from './testUtils.ts';
import { loadVoiceSettings, parseVoiceSettings } from './voiceSettings.ts';

const noop = (): void => undefined;
const saved = () => Promise.resolve({ status: 'saved' as const, profile: sampleProfile() });

describe('Settings — «Записанный голос»', () => {
  const html = renderToStaticMarkup(<Settings profile={sampleProfile()} health={sampleHealth({ ai: { runtime: true } })} serverOnline saveStudent={saved} onExit={noop} onOpenPlayground={noop} />);

  it('with runtime AI: offered first, with what it costs and what it needs — not chosen by default («Авто» follows the server)', () => {
    expect(html).toContain(CLIPS_VOICE_OPTION.title);
    expect(CLIPS_VOICE_OPTION.title).toBe('Записанный голос — бесплатно, без микрофона');
    expect(html.indexOf(CLIPS_VOICE_OPTION.title)).toBeLessThan(html.indexOf('Авто (лучший доступный)'));
    expect(DEFAULT_COACH_SETTINGS.voice).toBe('auto');
    // not speaking now: no «Послушать» of the recorded voice
    expect(html).not.toContain('Послушать записанный голос');
  });

  it('without runtime AI (the default, docs/TEACHING.md §4.4): the stored default «auto» IS the recorded voice — its tile is pressed, the setting is not rewritten', () => {
    const off = renderToStaticMarkup(<Settings profile={sampleProfile()} health={sampleHealth()} serverOnline saveStudent={saved} onExit={noop} onOpenPlayground={noop} />);
    const group = off.slice(off.indexOf('aria-label="Голос в партии"'));
    const pressed = group.slice(0, group.indexOf('</div>')).match(/aria-pressed="true"[^]*?<\/button>/g) ?? [];
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain('Записанный голос');
    expect(AI_OFF_VOICE).toBe('clips');
    expect(effectiveVoicePreference(DEFAULT_COACH_SETTINGS.voice, false)).toBe('clips');
    expect(effectiveVoicePreference('live', true)).toBe('live');
    expect(off).not.toContain('Послушать записанный голос');
  });

  it("the 'clips' preference round-trips through gambit.settings (coach and shell readers)", () => {
    const storage = createMemoryStorage();
    saveCoachSettings(storage, { voice: 'clips' });
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ voice: 'clips' });
    expect(loadCoachSettings(storage).voice).toBe('clips');
    expect(loadVoiceSettings(storage).voice).toBe('clips');
    expect(parseVoiceSettings({ voice: 'clips' }).voice).toBe('clips');
  });

  it('the status: which library speaks and how the last game sounded; chosen but not loaded → why it is silent', () => {
    const library = { voiceKey: 'giselle-mm1', libraryVersion: 3, phrases: 1240, units: 2100 };
    const speaking = describeClipsVoice({ voiceKind: 'clips', preference: 'clips', library, lastGame: { utterances: 50, recorded: 48, generic: 2, silent: 0, late: 0, at: '', timeControlId: 'blitz5' } });
    expect(speaking?.tone).toBe('ok');
    expect(speaking?.summary).toContain('записанный голос');
    expect(speaking?.details.join(' ')).toContain('1 240 фраз, версия 3');
    expect(speaking?.details.join(' ')).toContain('Прошлая партия: 96 %');
    expect(speaking?.details.join(' ')).toContain('Спроси');
    const missing = describeClipsVoice({ voiceKind: 'silent', preference: 'clips', library: null, lastGame: null });
    expect(missing?.tone).toBe('warn');
    expect(missing?.summary).toContain('не загрузилась');
    expect(describeClipsVoice({ voiceKind: 'openai-live', preference: 'live', library: null, lastGame: null })).toBeNull();
  });

  it('«Послушать» is one local recorded greeting with its clip twin', () => {
    const event = clipPreviewEvent(1);
    expect(event.clip?.sentences[0]?.items).toEqual([{ line: 'preview' }]);
    expect(event.clip?.generic).toBe('generic.greeting');
    expect(event.text).toContain('Я Гамбитик');
  });
});
