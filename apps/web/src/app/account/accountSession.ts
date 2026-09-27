/**
 * The signed-in account of this page (accounts on only): set at start by `bootAccount` (../../main.tsx), read by the
 * settings (who is signed in, «Выйти», «Удалить аккаунт»). Signing out or deleting sends what is pending, removes the
 * child's data from this browser and reloads the page — which then shows the door (./AuthScreen.tsx).
 */
import { onAuthRequired, setPageAccount } from '../../api/client.ts';
import { deleteAccount, getMe, getState, putState, signOut } from './accountApi.ts';
import type { AccountUser, AuthResult } from './accountApi.ts';
import { ACCOUNTS_SITE_KEY, ACCOUNT_MARK_KEY, clearChildKeys, readMark, reconcile, startSync } from './accountState.ts';
import type { StateSync } from './accountState.ts';
import { startPresence } from './presence.ts';

interface Session {
  user: AccountUser;
  sync: StateSync | null;
}

let session: Session | null = null;

/** The signed-in child's login, or null (accounts off, or not signed in). */
export function accountUser(): AccountUser | null {
  return session?.user ?? null;
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export type BootResult = { kind: 'family' } | { kind: 'signedIn'; user: AccountUser } | { kind: 'door'; registration: boolean; invite: boolean } | { kind: 'offline' };

function flagAccountsSite(storage: Storage | null, on: boolean): void {
  try {
    if (on) storage?.setItem(ACCOUNTS_SITE_KEY, '1');
  } catch {
    // a blocked storage: nothing to remember
  }
}

/**
 * At start: accounts off (the family server) → nothing changes; not signed in → the door (and nothing of a previous
 * child stays in this browser); signed in → this browser's data becomes the account's (another account's is removed,
 * the newer copy of each key wins) and every change is kept with the account from now on. A server that does not
 * answer: on a site known to have accounts, a «сервер не отвечает» screen (never the last child's data without a
 * session); elsewhere the family app without accounts (it shows its own banner).
 */
export async function bootAccount(): Promise<BootResult> {
  const storage = localStorageOrNull();
  const me = await getMe();
  if (me === null) return storage?.getItem(ACCOUNTS_SITE_KEY) === '1' ? { kind: 'offline' } : { kind: 'family' };
  if (!me.accounts) return { kind: 'family' };
  flagAccountsSite(storage, true);
  if (me.user === null) {
    if (storage !== null) clearChildKeys(storage);
    return { kind: 'door', registration: me.registration, invite: me.invite };
  }
  const user = me.user;
  setPageAccount(user.account);
  let sync: StateSync | null = null;
  if (storage !== null) {
    const server = await getState();
    if (server !== null) {
      const { push } = reconcile(storage, user, server);
      const mark = readMark(storage);
      for (const key of push) void putState(key, storage.getItem(key), mark?.times[key] ?? Date.now());
    } else if (readMark(storage)?.account !== user.account) {
      // the server's copy is out of reach: at least never show another child's data
      clearChildKeys(storage);
    }
    sync = startSync(storage, user, { put: putState, onForeign: () => window.location.reload() });
    // another tab of this browser signed another child in (or out): this page reloads instead of writing on
    window.addEventListener('storage', (event) => {
      if (event.key !== ACCOUNT_MARK_KEY && event.key !== null) return;
      if (readMark(storage)?.account !== user.account) window.location.reload();
    });
  }
  session = { user, sync };
  // a session that ends while the app runs (signed out elsewhere, the account deleted, another child in the cookie)
  onAuthRequired(() => window.location.reload());
  // who is on the site now, for the admin's dashboard (only the screen's name)
  startPresence();
  return { kind: 'signedIn', user };
}

/** The page starts over on the home screen (never on the parent's settings), with this tab's parent gate closed. */
export function restartAtHome(): void {
  try {
    const session = typeof sessionStorage === 'undefined' ? null : sessionStorage;
    if (session !== null) clearChildKeys(session);
  } catch {
    // no session storage: nothing to close
  }
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
  } catch {
    // an odd embedding: reload where we are
  }
  window.location.reload();
}

/**
 * «Выйти»: what is pending goes to the server, the session is closed, the child's data leaves this browser, the door
 * opens. When the server could not close the session, nothing is removed and the failure is returned (the card says
 * so): a child must never believe it signed out while the cookie still works.
 */
export async function signOutHere(): Promise<AuthResult<object>> {
  await session?.sync?.flush().catch(() => undefined);
  const result = await signOut();
  if (!result.ok) return result;
  session?.sync?.stop();
  const storage = localStorageOrNull();
  if (storage !== null) clearChildKeys(storage);
  restartAtHome();
  return result;
}

/** «Удалить аккаунт»: needs the password; on success everything of the child is gone (server and this browser). */
export async function deleteHere(password: string): Promise<AuthResult<object>> {
  const result = await deleteAccount(password);
  if (!result.ok) return result;
  session?.sync?.stop();
  const storage = localStorageOrNull();
  if (storage !== null) clearChildKeys(storage);
  restartAtHome();
  return result;
}
