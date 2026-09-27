// Dev-only entry for the live game: open /src/features/game/dev/game.html on the Vite dev server.
// Query parameters: persona=petya…dima · tc=bullet1|blitz5|rapid10|training · color=w|b · exam=1 · dock=0
// Not imported by the app, so it never reaches the production bundle.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/nunito/index.css';
import { PERSONA_IDS, TIME_CONTROL_IDS } from '@gambit/shared';
import type { Color, PersonaId, TimeControlId } from '@gambit/shared';
import { MascotDock } from '../../../coach/index.ts';
import '../../../ui/index.ts';
import { GameScreen } from '../GameScreen.tsx';

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

function DevGame() {
  const params = new URLSearchParams(window.location.search);
  const personaId: PersonaId = oneOf(params.get('persona'), PERSONA_IDS, 'petya');
  const timeControlId: TimeControlId = oneOf(params.get('tc'), TIME_CONTROL_IDS, 'training');
  const childColor: Color = oneOf(params.get('color'), ['w', 'b'] as const, 'w');
  const [exit, setExit] = useState<string | null>(null);

  if (exit !== null) {
    return (
      <main style={{ padding: 32, fontSize: 20 }}>
        <p>onExit({exit === '' ? '' : `"${exit}"`})</p>
        <button type="button" style={{ minHeight: 56, padding: '0 24px', fontSize: 20 }} onClick={() => setExit(null)}>
          Снова
        </button>
      </main>
    );
  }
  return (
    <>
      <GameScreen personaId={personaId} timeControlId={timeControlId} childColor={childColor} examMode={params.get('exam') === '1'} onExit={(id) => setExit(id ?? '')} />
      {params.get('dock') === '0' ? null : <MascotDock />}
    </>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing in game.html');

createRoot(container).render(
  <StrictMode>
    <DevGame />
  </StrictMode>,
);
