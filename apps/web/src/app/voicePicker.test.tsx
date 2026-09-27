/**
 * «Каким голосом говорит Гамбитик» (Settings, behind the parental lock): the parent's pick of the voice and the PAID
 * «Послушать». Server render only — nothing is loaded, saved or played here.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VoiceChoiceInfo } from '../coach/liveApi.ts';
import { VOICE_PREVIEW_COST_RU } from '../coach/voicePreview.ts';
import { VOICE_PREVIEW_LIMIT_RU, VoicePicker, voicePickerView } from './VoicePicker.tsx';
import type { VoicePickerProps } from './VoicePicker.tsx';

const REALTIME = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const LIVE_ONLY = ['beacon', 'bossa', 'cinder', 'delta', 'gleam', 'meridian', 'quartz', 'ripple', 'stone', 'tempo', 'vesper', 'willow'];

function choice(selected: string | null): VoiceChoiceInfo {
  return {
    selected,
    live: selected ?? 'marin',
    realtime: selected !== null && REALTIME.includes(selected) ? selected : 'marin',
    defaults: { live: 'marin', realtime: 'marin' },
    voices: [...REALTIME.map((id) => ({ id, live: true, realtime: true })), ...LIVE_ONLY.map((id) => ({ id, live: true, realtime: false }))],
  };
}

const noop = (): void => undefined;

function render(patch: Partial<VoicePickerProps>): string {
  const props: VoicePickerProps = {
    choice: choice(null),
    serverOnline: true,
    server: { live: true, realtime: true },
    automated: false,
    previewing: false,
    note: null,
    onChoose: noop,
    onPreview: noop,
    ...patch,
  };
  return renderToStaticMarkup(<VoicePicker {...props} />);
}

const radios = (html: string): string[] => html.match(/role="radio"[^>]*>/g) ?? [];
const checkedRadio = (html: string): string | null => /role="radio" aria-checked="true"[^>]*>(?:<[^>]+>)*([^<]+)/.exec(html)?.[1] ?? null;

describe('<VoicePicker/> — the parent picks Гамбитик\'s voice', () => {
  it('nothing picked yet: every voice is offered, the default (marin) is the checked one and says so', () => {
    const html = render({});
    expect(radios(html)).toHaveLength(22);
    expect(html).toContain('aria-label="Голос Гамбитика"');
    expect(checkedRadio(html)).toContain('marin');
    expect(html).toContain('Сейчас: marin (по умолчанию).');
    // nothing to go back to
    expect(html).not.toContain('Вернуть голос по умолчанию');
    // the notes are OpenAI's own descriptions; a Live-only voice says so
    expect(html).toContain('cedar · мужской, спокойный');
    expect(html).toContain('gleam · женский · только Live');
  });

  it('a pick is checked and can be undone', () => {
    const html = render({ choice: choice('cedar') });
    expect(checkedRadio(html)).toContain('cedar');
    expect(html).toContain('Сейчас: cedar.');
    expect(html).toContain('Вернуть голос по умолчанию (marin)');
  });

  it('«Послушать» says up front that it costs money', () => {
    const html = render({ choice: choice('coral') });
    expect(html).toContain('Послушать голос coral');
    expect(html).toContain(VOICE_PREVIEW_COST_RU);
    expect(VOICE_PREVIEW_COST_RU).toMatch(/Платно/);
  });

  it('IMPOSSIBLE under automation: no «Послушать» button at all (the picker itself stays)', () => {
    const html = render({ automated: true });
    expect(html).not.toContain('Послушать');
    expect(html).not.toContain('data-voice-preview');
    expect(radios(html)).toHaveLength(22);
  });

  it('no paid model on the server (no key, offline) — or a Live-only voice without Live: no preview', () => {
    expect(render({ server: { live: false, realtime: false } })).not.toContain('Послушать');
    expect(render({ serverOnline: false })).not.toContain('Послушать');
    expect(render({ choice: choice('gleam'), server: { live: false, realtime: true } })).not.toContain('Послушать');
    // a voice both models have is heard through Realtime when there is no Live
    expect(render({ choice: choice('cedar'), server: { live: false, realtime: true } })).toContain('Послушать голос cedar');
  });

  it('the daily limit of the paid voice is reached: no «Послушать» (it is paid too) — the limit line instead, the pick stays', () => {
    const html = render({ choice: choice('coral'), limitReached: true });
    expect(html).not.toContain('Послушать голос');
    expect(html).not.toContain('data-voice-preview=""');
    expect(html).toContain(VOICE_PREVIEW_LIMIT_RU);
    expect(radios(html)).toHaveLength(22);
    // (no paid model / automation: nothing to say about a preview at all)
    expect(render({ limitReached: true, automated: true })).not.toContain(VOICE_PREVIEW_LIMIT_RU);
    expect(render({ limitReached: true, server: { live: false, realtime: false } })).not.toContain(VOICE_PREVIEW_LIMIT_RU);
    expect(render({ limitReached: false })).not.toContain(VOICE_PREVIEW_LIMIT_RU);
  });

  it('not loaded: a calm line instead of the list (offline / waiting for the server)', () => {
    expect(render({ choice: null })).toContain('Выбор голоса появится, когда сервер ответит.');
    expect(render({ choice: null, serverOnline: false })).toContain('Голос можно выбрать, когда сервер работает.');
  });

  it('shows the save / preview note', () => {
    expect(render({ note: { tone: 'warn', text: 'Сервер не сохранил голос.' } })).toMatch(/data-tone="warn" role="status">Сервер не сохранил голос\./);
  });

  it('voicePickerView: the pick or the default, and which model «Послушать» would use', () => {
    expect(voicePickerView(choice(null), { live: true, realtime: true })).toMatchObject({ chosen: 'marin', isDefault: true, previewKind: 'openai-live' });
    expect(voicePickerView(choice('gleam'), { live: true, realtime: true })).toMatchObject({ chosen: 'gleam', isDefault: false, previewKind: 'openai-live' });
    expect(voicePickerView(choice('ash'), { live: false, realtime: true })).toMatchObject({ previewKind: 'openai-realtime' });
    expect(voicePickerView(choice('gleam'), { live: false, realtime: true })).toMatchObject({ previewKind: null });
  });
});
