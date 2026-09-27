// Dev-only entry for the design-system gallery: open /src/ui/gallery.html on the Vite dev server.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/nunito/index.css';
import './index.ts';
import { Gallery } from './Gallery.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing in gallery.html');

createRoot(container).render(
  <StrictMode>
    <Gallery onBack={() => window.history.back()} />
  </StrictMode>,
);
