/**
 * <SoundToggle/> (docs/TEACHING.md §0.7, §4.4): a big, clearly labelled «Звук вкл» / «Звук выкл» — icon + text,
 * aria-pressed = the sound is on, locked under the parent's «Всегда без звука». Its accessible name never collides with
 * the e2e selectors of other buttons. Server render (no DOM); the switch's behaviour is in soundMute.test.ts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SoundMute, SoundState } from './soundMute.ts';
import { SOUND_LOCKED_TITLE, SOUND_OFF_TEXT, SOUND_ON_TEXT, SoundToggle } from './SoundToggle.tsx';

function frozen(state: Partial<SoundState>): SoundMute {
  const full: SoundState = { voiceMuted: false, sfxMuted: false, muted: false, always: false, until: null, ...state };
  return {
    state: () => full,
    subscribe: () => () => undefined,
    muteUntilMidnight: () => undefined,
    unmute: () => false,
    toggle: () => undefined,
    setAlwaysMuted: () => undefined,
    reconcile: () => undefined,
    dispose: () => undefined,
  };
}

/** the visible text of the button = its accessible name (no aria-label) */
function accessibleName(html: string): string {
  expect(html).not.toContain('aria-label=');
  return html
    .replace(/<svg[^]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

describe('<SoundToggle/>', () => {
  it('sound on: «Звук вкл», pressed, the speaker icon; 64 px by default', () => {
    const html = renderToStaticMarkup(<SoundToggle control={frozen({})} />);
    expect(html).toMatch(/^<button[^>]*type="button"/);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-sound="on"');
    expect(html).toContain('data-size="lg"');
    expect(html).toContain('<svg');
    expect(accessibleName(html)).toBe(SOUND_ON_TEXT);
    expect(SOUND_ON_TEXT).toBe('Звук вкл');
    expect(html).not.toContain('disabled');
  });

  it('everything silent: «Звук выкл», not pressed, the sunny accent; md size for the narrow panel head', () => {
    const html = renderToStaticMarkup(<SoundToggle size="md" control={frozen({ voiceMuted: true, sfxMuted: true, muted: true, until: Date.now() + 3_600_000 })} />);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-sound="off"');
    expect(html).toContain('data-variant="accent"');
    expect(html).toContain('data-size="md"');
    expect(accessibleName(html)).toBe(SOUND_OFF_TEXT);
    expect(SOUND_OFF_TEXT).toBe('Звук выкл');
    expect(html).not.toContain('disabled');
  });

  it('only the voice off (move sounds still audible) is not «Звук выкл»', () => {
    const html = renderToStaticMarkup(<SoundToggle control={frozen({ voiceMuted: true })} />);
    expect(accessibleName(html)).toBe(SOUND_ON_TEXT);
  });

  it('the parent\'s «Всегда без звука»: «Звук выкл», disabled, the title says why', () => {
    const html = renderToStaticMarkup(<SoundToggle control={frozen({ voiceMuted: true, sfxMuted: true, muted: true, always: true })} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain(`title="${SOUND_LOCKED_TITLE}"`);
    expect(accessibleName(html)).toBe(SOUND_OFF_TEXT);
  });

  it('its name never matches what e2e looks for on other buttons', () => {
    for (const state of [{}, { voiceMuted: true, sfxMuted: true, muted: true }, { voiceMuted: true, sfxMuted: true, muted: true, always: true }]) {
      const name = accessibleName(renderToStaticMarkup(<SoundToggle control={frozen(state)} />));
      expect(name).not.toMatch(/Подсказка/);
      expect(name).not.toMatch(/^Совет/);
      expect(name).not.toBe('Выключить голос Гамбитика');
      expect(name).not.toMatch(/Сдаться/);
    }
  });

  it('a null control is a harmless button (tests, the playground)', () => {
    expect(accessibleName(renderToStaticMarkup(<SoundToggle control={null} />))).toBe(SOUND_ON_TEXT);
  });
});
