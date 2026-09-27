import type { HTMLAttributes, ReactNode, Ref } from 'react';
import styles from './Card.module.css';
import { cx } from './cx.ts';

export type CardTone = 'surface' | 'tint' | 'teal' | 'sunny' | 'coral' | 'green' | 'blue';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Rendered element. Use 'section' together with `title`, 'li' inside lists. Default 'div'. */
  as?: 'div' | 'section' | 'article' | 'li' | 'aside';
  /** Optional heading rendered as <h3> at the top of the card. */
  title?: ReactNode;
  /** Content aligned to the right of the title (a badge, a small button). */
  headerAside?: ReactNode;
  tone?: CardTone;
  padding?: CardPadding;
  /** Flat cards have a hairline instead of the soft lift. */
  flat?: boolean;
  ref?: Ref<HTMLElement>;
}

export function Card({ as = 'div', title, headerAside, tone = 'surface', padding = 'md', flat = false, className, children, ref, ...rest }: CardProps) {
  const Tag = as;
  return (
    // The ref type is widened on purpose: every allowed tag is an HTMLElement.
    <Tag {...rest} ref={ref as Ref<never>} data-tone={tone} className={cx(styles.card, styles[`pad-${padding}`], flat && styles.flat, className)}>
      {title !== undefined || headerAside !== undefined ? (
        <header className={styles.header}>
          {title !== undefined ? <h3 className={styles.title}>{title}</h3> : <span />}
          {headerAside !== undefined ? <div className={styles.aside}>{headerAside}</div> : null}
        </header>
      ) : null}
      {children}
    </Tag>
  );
}
