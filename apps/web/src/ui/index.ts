/**
 * «Гамбитик» design system — public entry of apps/web/src/ui.
 * Importing this module installs the design tokens and the global base styles (order matters).
 */
import './tokens.css';
import './global.css';

export { Button } from './Button.tsx';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button.tsx';
export { Card } from './Card.tsx';
export type { CardPadding, CardProps, CardTone } from './Card.tsx';
export { Screen } from './Screen.tsx';
export type { ScreenDockSpace, ScreenProps } from './Screen.tsx';
export { BigChoice } from './BigChoice.tsx';
export type { BigChoiceAccent, BigChoiceProps } from './BigChoice.tsx';
export { PersonaAvatar } from './PersonaAvatar.tsx';
export type { PersonaAvatarData, PersonaAvatarProps, PersonaMood } from './PersonaAvatar.tsx';
export { Stars, starsLabelRu } from './Stars.tsx';
export type { StarsProps } from './Stars.tsx';
export { ProgressBar } from './ProgressBar.tsx';
export type { ProgressBarProps, ProgressTone } from './ProgressBar.tsx';
export { Badge } from './Badge.tsx';
export type { BadgeProps, BadgeTone } from './Badge.tsx';
export { Modal } from './Modal.tsx';
export type { ModalProps } from './Modal.tsx';
export { Spinner } from './Spinner.tsx';
export type { SpinnerProps } from './Spinner.tsx';
export { Icon, ICON_NAMES } from './icons.tsx';
export type { IconName, IconProps } from './icons.tsx';

export {
  SOUND_NAMES,
  createSoundPlayer,
  getSoundVolume,
  installAudioUnlock,
  isSoundMuted,
  onSoundMutedChange,
  playSound,
  setSoundDucked,
  setSoundMuted,
  setSoundVolume,
  toggleSoundMuted,
  unlockAudio,
} from './sounds.ts';
export type { SoundName, SoundPlayer, SoundPlayerOptions } from './sounds.ts';

export { CONFETTI_COLORS, celebrate, stopConfetti } from './confetti.ts';
export type { CelebrateOptions, CelebrationKind } from './confetti.ts';

export { getReducedMotionOverride, prefersReducedMotion, setReducedMotion } from './motion.ts';

export {
  ANNOTATION_RGB,
  ARROW_COLORS,
  BOARD_MARKS,
  BOARD_THEMES,
  DEFAULT_BOARD_THEME,
  DEFAULT_BOARD_THEME_ID,
  DEFAULT_RING_PX,
  HIGHLIGHT_COLORS,
  boardThemeStyles,
  buildArrows,
  buildSquareStyles,
  checkSquareStyle,
  highlightStyle,
  lastMoveStyle,
  legalTargetStyle,
  selectedSquareStyle,
} from './boardTheme.ts';
export type { BoardArrow, BoardTheme, BoardThemeId, SquareStyleInput } from './boardTheme.ts';

export { cx } from './cx.ts';
export { pluralRu } from './plural.ts';
export { shade, withAlpha } from './color.ts';
export { SAMPLE_PERSONAS } from './samplePersonas.ts';
