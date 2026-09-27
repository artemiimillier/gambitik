import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import styles from './Button.module.css';
import { cx } from './cx.ts';
import { playSound } from './sounds.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'md' | 'lg' | 'xl';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** primary = teal, secondary = white, ghost = transparent, danger = coral, accent = sunny yellow. Default 'primary'. */
  variant?: ButtonVariant;
  /** md = 56 px, lg = 64 px, xl = 80 px tall. Default 'md'. */
  size?: ButtonSize;
  /** Decorative icon shown before the label. For an icon-only button omit children and pass `aria-label` (Russian). */
  icon?: ReactNode;
  /** Decorative icon shown after the label. */
  iconAfter?: ReactNode;
  /** Stretch to the container width. */
  block?: boolean;
  /** Shows a spinner, sets aria-busy and blocks clicks. */
  loading?: boolean;
  /** Set to false to suppress the soft click sound. Default true. */
  sound?: boolean;
  type?: 'button' | 'submit' | 'reset';
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconAfter,
  block = false,
  loading = false,
  sound = true,
  type = 'button',
  className,
  children,
  disabled,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const iconOnly = children === undefined || children === null || children === false;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    if (sound) playSound('click');
    onClick?.(event);
  };

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-size={size}
      className={cx(styles.button, styles[variant], styles[size], block && styles.block, iconOnly && styles.iconOnly, loading && styles.loading, className)}
      onClick={handleClick}
    >
      {loading ? <span className={styles.busy} aria-hidden="true" /> : null}
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {iconOnly ? null : <span className={styles.label}>{children}</span>}
      {iconAfter ? (
        <span className={styles.icon} aria-hidden="true">
          {iconAfter}
        </span>
      ) : null}
    </button>
  );
}
