import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// order matters: font faces → design tokens → global base styles → the app
import '@fontsource-variable/nunito/index.css';
import './ui/tokens.css';
import './ui/global.css';
import { App } from './app/App.tsx';
import { AuthScreen, OfflineScreen } from './app/account/AuthScreen.tsx';
import { bootAccount, restartAtHome } from './app/account/accountSession.ts';
import { applyFontScale, getBrowserStorage, loadShellSettings } from './app/shellSettings.ts';
import { setReducedMotion } from './ui/motion.ts';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing in index.html');
const root = createRoot(container);

async function start(): Promise<void> {
  // the public site (accounts on): the door first, then the child's own data in this browser; the family server: straight to the app
  const account = await bootAccount();
  if (account.kind === 'offline') {
    root.render(
      <StrictMode>
        <OfflineScreen />
      </StrictMode>,
    );
    return;
  }
  if (account.kind === 'door') {
    root.render(
      <StrictMode>
        <AuthScreen registration={account.registration} invite={account.invite} onSignedIn={restartAtHome} />
      </StrictMode>,
    );
    return;
  }

  // parent settings that change the very first paint (text size, «меньше анимации») — the account's, once it is loaded
  const shellSettings = loadShellSettings(getBrowserStorage());
  applyFontScale(shellSettings.fontScale);
  if (shellSettings.reducedMotion !== null) setReducedMotion(shellSettings.reducedMotion);

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
