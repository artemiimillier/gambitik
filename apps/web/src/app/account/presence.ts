/**
 * «I am here, on this screen» for the admin's dashboard (accounts on only): the signed-in page reports the name of its
 * screen once a minute while it is visible, and at once when the screen changes. Only the route's name travels (never
 * a position, a game or a word of the child); the server keeps it in memory. A failed report is simply dropped.
 */
import { API_BASE } from '@gambit/shared';
import { pageAccountHeader } from '../../api/client.ts';
import { parseHash } from '../router.ts';

const EVERY_MS = 60_000;

export function startPresence(): () => void {
  let last = '';
  let lastAt = 0;
  const report = (force: boolean): void => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const screen = parseHash(window.location.hash).name;
    const now = Date.now();
    if (!force && screen === last && now - lastAt < EVERY_MS - 1_000) return;
    last = screen;
    lastAt = now;
    void fetch(`${API_BASE}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...pageAccountHeader() },
      body: JSON.stringify({ screen }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  };
  const onHash = (): void => report(false);
  const onVisible = (): void => report(true);
  window.addEventListener('hashchange', onHash);
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(() => report(true), EVERY_MS);
  report(true);
  return () => {
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(timer);
  };
}
