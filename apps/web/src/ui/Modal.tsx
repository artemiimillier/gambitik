import { useEffect, useId, useRef } from 'react';
import type { MouseEvent, ReactNode, SyntheticEvent } from 'react';
import { Button } from './Button.tsx';
import { cx } from './cx.ts';
import { Icon } from './icons.tsx';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  /** Called when the dialog wants to close (Esc, ✕, backdrop). The parent owns `open`. */
  onClose: () => void;
  /** Heading of the dialog; becomes its accessible name. */
  title: ReactNode;
  /** Big decorative picture above the title (emoji, avatar, stars). */
  icon?: ReactNode;
  children?: ReactNode;
  /** Footer with the choice buttons — usually two big <Button>s. */
  actions?: ReactNode;
  /**
   * When false the child MUST pick one of the `actions`: no ✕, Esc and backdrop clicks are ignored.
   * Use for «Сдаться?» and take-back decisions. Default true.
   */
  dismissible?: boolean;
  /** Close when the dimmed background is clicked (only if dismissible). Default false — kids click impulsively. */
  closeOnBackdrop?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Modal dialog on the native <dialog> element: the browser provides the focus trap, Esc handling,
 * the top layer and inert background.
 */
export function Modal({ open, onClose, title, icon, children, actions, dismissible = true, closeOnBackdrop = false, size = 'md', className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Leave no modal behind if the host component unmounts while it is open.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    // Esc: never let the browser close the dialog by itself — `open` is controlled by the parent.
    event.preventDefault();
    if (dismissible) onClose();
  };

  const handleClose = () => {
    // Closed by something other than our effect (e.g. form method="dialog"): sync the parent.
    if (open) onClose();
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (!dismissible || !closeOnBackdrop) return;
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <dialog ref={ref} className={cx(styles.dialog, className)} data-size={size} aria-labelledby={titleId} onCancel={handleCancel} onClose={handleClose} onClick={handleBackdropClick}>
      <div className={styles.panel}>
        {dismissible ? <Button variant="ghost" size="md" className={styles.close} icon={<Icon name="close" />} aria-label="Закрыть" onClick={onClose} /> : null}
        {icon !== undefined ? (
          <div className={styles.icon} aria-hidden="true">
            {icon}
          </div>
        ) : null}
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {children !== undefined ? <div className={styles.body}>{children}</div> : null}
        {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </dialog>
  );
}
