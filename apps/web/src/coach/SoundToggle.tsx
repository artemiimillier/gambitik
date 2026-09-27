/**
 * <SoundToggle/> — the big «Звук вкл / Звук выкл» button of the game screen (docs/TEACHING.md §0.7, §4.4).
 *
 * One switch for Гамбитик's voice AND the move sounds (./soundMute.ts): «Звук выкл» lasts until local midnight,
 * «Звук вкл» brings both back and unlocks the audio inside the same click. Under the parent's «Всегда без звука» it
 * stays «Звук выкл» and cannot be pressed. Icon + text, `aria-pressed` = the sound is on; the accessible name is the
 * visible text only (never «Подсказка» / «Совет…» / «Выключить голос Гамбитика» — e2e selectors of other buttons).
 *
 * The game screen places it (panel head; above the board on narrow screens): `<SoundToggle size="md" />`.
 */
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { Button } from '../ui/Button.tsx';
import { Icon } from '../ui/icons.tsx';
import { getAppSoundMute, useSoundState } from './soundMute.ts';
import type { SoundMute } from './soundMute.ts';
import './SoundToggle.css';

export const SOUND_ON_TEXT = 'Звук вкл';
export const SOUND_OFF_TEXT = 'Звук выкл';
export const SOUND_ON_TITLE = 'Звук включён. Нажми — и до завтра будет тихо';
export const SOUND_OFF_TITLE = 'Звук выключен. Нажми, чтобы включить';
export const SOUND_LOCKED_TITLE = 'Звук выключен в настройках для взрослых';

export interface SoundToggleProps {
  /** 'lg' = 64 px tall (default), 'md' = 56 px */
  size?: 'lg' | 'md';
  className?: string;
  /** tests / the playground: another switch (null = a dead button that never mutes); the app uses its one switch */
  control?: SoundMute | null;
}

export function SoundToggle({ size = 'lg', className, control }: SoundToggleProps): ReactElement {
  const sound = control === undefined ? getAppSoundMute() : control;
  const state = useSoundState(sound);

  // a mute of yesterday lifts itself (the dock does it too; twice is harmless)
  useEffect(() => {
    sound?.reconcile();
  }, [sound]);

  const on = !state.muted;
  const locked = state.muted && state.always;
  return (
    <Button
      variant={on ? 'secondary' : 'accent'}
      size={size}
      sound={false}
      className={['gmb-sound-toggle', className].filter(Boolean).join(' ')}
      data-sound={on ? 'on' : 'off'}
      aria-pressed={on}
      disabled={locked}
      title={locked ? SOUND_LOCKED_TITLE : on ? SOUND_ON_TITLE : SOUND_OFF_TITLE}
      icon={<Icon name={on ? 'sound' : 'soundOff'} />}
      onClick={() => sound?.toggle()}
    >
      {on ? SOUND_ON_TEXT : SOUND_OFF_TEXT}
    </Button>
  );
}
