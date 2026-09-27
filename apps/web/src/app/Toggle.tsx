import type { ReactNode } from 'react';
import { playSound } from '../ui/index.ts';
import styles from './shell.module.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  /** one short explaining line */
  hint?: ReactNode;
  disabled?: boolean;
}

/** A big, whole-row switch (`role="switch"`): the row itself is the 64 px target, not the little knob. */
export function Toggle({ checked, onChange, title, hint, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={styles.switchRow}
      onClick={() => {
        playSound('click');
        onChange(!checked);
      }}
    >
      <span className={styles.switchText}>
        <span className={styles.switchTitle}>{title}</span>
        {hint !== undefined ? <span className={styles.switchHint}>{hint}</span> : null}
      </span>
      <span className={styles.switchTrack} aria-hidden="true" />
    </button>
  );
}
