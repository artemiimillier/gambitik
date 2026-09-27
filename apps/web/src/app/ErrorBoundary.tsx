import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button, Icon } from '../ui/index.ts';
import styles from './shell.module.css';

export interface ErrorBoundaryProps {
  children?: ReactNode;
  /** When this value changes (e.g. the route), a shown error screen is cleared. */
  resetKey?: string;
  /** «На главную» — the shell passes a navigation callback; omitted for the outermost boundary. */
  onGoHome?: () => void;
  /** true = rendered inside the app frame (the mascot dock stays visible) */
  inline?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: string | undefined;
}

/** Friendly safety net: a crash of one screen never shows a white page to the child. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[shell] a screen crashed', error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  private readonly goHome = (): void => {
    this.props.onGoHome?.();
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className={styles.error} data-inline={this.props.inline ? 'true' : 'false'} role="alert">
        <div className={styles.errorCard}>
          <div className={styles.errorArt} aria-hidden="true">
            🧩
          </div>
          <h1>Ой! Что-то запуталось</h1>
          <p>Так бывает даже у гроссмейстеров. Твои партии в порядке — давай попробуем ещё раз.</p>
          <div className={styles.errorActions}>
            <Button size="lg" icon={<Icon name="refresh" />} onClick={this.retry}>
              Попробовать снова
            </Button>
            {this.props.onGoHome ? (
              <Button size="lg" variant="secondary" icon={<Icon name="home" />} onClick={this.goHome}>
                На главную
              </Button>
            ) : (
              <Button size="lg" variant="secondary" onClick={() => window.location.reload()}>
                Перезагрузить
              </Button>
            )}
          </div>
          <details className={styles.errorDetails}>
            <summary>Для родителей: что случилось</summary>
            <pre>{error.stack ?? error.message}</pre>
          </details>
        </div>
      </div>
    );
  }
}
