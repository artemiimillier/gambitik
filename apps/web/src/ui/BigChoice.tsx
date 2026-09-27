import type { MouseEvent, ReactNode, Ref } from 'react';
import styles from './BigChoice.module.css';
import { cx } from './cx.ts';
import { Icon } from './icons.tsx';
import { playSound } from './sounds.ts';

export type BigChoiceAccent = 'teal' | 'sunny' | 'coral' | 'green' | 'blue';

export interface BigChoiceProps {
  /** 1–3 Russian words. */
  title: ReactNode;
  /** One short line under the title. */
  subtitle?: ReactNode;
  /** Emoji, <Icon/>, <PersonaAvatar/> or any node; decorative (hidden from screen readers). */
  icon?: ReactNode;
  /** Marks the tile as the current choice (adds a check mark, not only colour). */
  selected?: boolean;
  disabled?: boolean;
  /** Small label pinned to the top-right corner, e.g. «Гамбитик советует». */
  badge?: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** 'row' = icon on the left (lists), 'column' = big icon on top (home tiles). Default 'row'. */
  layout?: 'row' | 'column';
  /** Colour of the icon bubble. Default 'teal'. */
  accent?: BigChoiceAccent;
  /** Extra content under the subtitle (strength pawns, score line). */
  children?: ReactNode;
  /** Accessible name override; by default the title + subtitle are read. */
  'aria-label'?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

/** Large tappable tile (≥ 96 px tall) for the big decisions: what to play, against whom, how long. */
export function BigChoice({
  title,
  subtitle,
  icon,
  selected,
  disabled = false,
  badge,
  onClick,
  layout = 'row',
  accent = 'teal',
  children,
  className,
  ref,
  'aria-label': ariaLabel,
}: BigChoiceProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    playSound('click');
    onClick?.(event);
  };

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-label={ariaLabel}
      data-layout={layout}
      data-accent={accent}
      className={cx(styles.tile, selected && styles.selected, className)}
      onClick={handleClick}
    >
      {icon !== undefined ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {subtitle !== undefined ? <span className={styles.subtitle}>{subtitle}</span> : null}
        {children !== undefined ? <span className={styles.extra}>{children}</span> : null}
      </span>
      {badge !== undefined ? <span className={styles.badge}>{badge}</span> : null}
      {selected ? (
        <span className={styles.check} aria-hidden="true">
          <Icon name="check" />
        </span>
      ) : null}
    </button>
  );
}
