// DEV ONLY — open /src/features/puzzles/__dev__/screens.html on the Vite dev server.
// Shows the four secondary screens against an in-browser mock API (no server needed).
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/nunito/index.css';
import '../../../ui/index.ts';
import { MascotDock } from '../../../coach/index.ts';
import { Button, Screen } from '../../../ui/index.ts';
import { CurriculumScreen } from '../../curriculum/CurriculumScreen.tsx';
import { ProgressScreen } from '../../progress/ProgressScreen.tsx';
import { ReviewScreen } from '../../review/ReviewScreen.tsx';
import { PuzzlesScreen } from '../PuzzlesScreen.tsx';
import { installMockApi } from './mockApi.ts';

installMockApi();

function useHash(): [string, (next: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [hash, (next) => (window.location.hash = next)];
}

function Harness() {
  const [hash, go] = useHash();
  const home = () => go('');
  const [route, arg] = hash.split(':');

  let screen;
  if (route === 'puzzles') screen = <PuzzlesScreen key={arg ?? 'mix'} theme={arg} onExit={home} />;
  else if (route === 'review') screen = <ReviewScreen gameId={arg ?? 'game-1'} onExit={home} />;
  else if (route === 'progress') screen = <ProgressScreen onExit={home} onOpenGame={(id) => go(`review:${id}`)} />;
  else if (route === 'curriculum') screen = <CurriculumScreen onExit={home} onStartPuzzles={(theme) => go(`puzzles:${theme}`)} />;
  else
    screen = (
      <Screen title="Экраны" subtitle="dev-витрина с поддельным сервером">
        <div style={{ display: 'grid', gap: 16, maxWidth: 420 }}>
          <Button size="lg" onClick={() => go('puzzles')}>
            Задачи
          </Button>
          <Button size="lg" onClick={() => go('puzzles:fork')}>
            Задачи: вилка
          </Button>
          <Button size="lg" onClick={() => go('review:game-1')}>
            Разбор партии
          </Button>
          <Button size="lg" onClick={() => go('progress')}>
            Мои успехи
          </Button>
          <Button size="lg" onClick={() => go('curriculum')}>
            Путь пешки
          </Button>
        </div>
      </Screen>
    );

  return (
    <>
      {screen}
      <MascotDock />
    </>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing in screens.html');

createRoot(container).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
