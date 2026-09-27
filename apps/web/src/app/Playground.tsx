/**
 * #/playground — dev harnesses of the other modules. Both are lazy-loaded so they never
 * weigh on the child's bundle: coach/MascotPlayground and ui/Gallery.
 */
import { Suspense, lazy } from 'react';
import { Button, Spinner } from '../ui/index.ts';
import type { PlaygroundTool } from './router.ts';
import styles from './Playground.module.css';
import shell from './shell.module.css';

const MascotPlayground = lazy(() => import('../coach/MascotPlayground.tsx').then((module) => ({ default: module.MascotPlayground })));
const Gallery = lazy(() => import('../ui/Gallery.tsx').then((module) => ({ default: module.Gallery })));

export interface PlaygroundProps {
  tool: PlaygroundTool;
  onSelectTool: (tool: PlaygroundTool) => void;
  onExit: () => void;
}

export function Playground({ tool, onSelectTool, onExit }: PlaygroundProps) {
  return (
    <div className={styles.page}>
      <nav className={styles.bar} aria-label="Витрина для разработчика">
        <Button variant="secondary" onClick={onExit}>
          Домой
        </Button>
        <Button variant={tool === 'mascot' ? 'primary' : 'ghost'} aria-pressed={tool === 'mascot'} onClick={() => onSelectTool('mascot')}>
          Маскот и голос
        </Button>
        <Button variant={tool === 'ui' ? 'primary' : 'ghost'} aria-pressed={tool === 'ui'} onClick={() => onSelectTool('ui')}>
          Компоненты
        </Button>
      </nav>
      <Suspense
        fallback={
          <div className={shell.loading}>
            <Spinner showLabel />
          </div>
        }
      >
        {tool === 'ui' ? <Gallery /> : <MascotPlayground />}
      </Suspense>
    </div>
  );
}
