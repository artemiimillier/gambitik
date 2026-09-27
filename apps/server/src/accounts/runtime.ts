/**
 * Accounts (GAMBIT_ACCOUNTS=1): everything the public site adds to the server, built next to the server's own context
 * (index.ts): the accounts database `DATA_DIR/accounts.db`, the per-account contexts `DATA_DIR/users/<id>/`, the
 * attempt limits. The server's own context keeps what every account shares (content, puzzles, the recorder — which
 * stays off on the public site) and answers `/api/health`; it holds no child's data.
 */
import { readdirSync, statfsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createApi } from '../app.ts';
import type { ServerConfig } from '../config.ts';
import type { ContextOverrides, ServerContext } from '../context.ts';
import { Presence } from './adminStats.ts';
import { RateLimiter } from './limiter.ts';
import { ProofOfWork } from './pow.ts';
import type { AccountsRuntime } from './routes.ts';
import { ACCOUNT_ID_RE, AccountStore, parseLogin } from './store.ts';
import { UserContexts, accountApp } from './users.ts';

/** below this much free space under DATA_DIR the accounts write nothing new (507 disk-full) */
export const DISK_FREE_MIN = 1024 ** 3;

/** Free bytes under `dir` (null: unknown). */
function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * `users/<id>` folders without an account (a deletion that could not remove its folder, the owner's admin delete while
 * the server ran): removed at start.
 */
async function removeOrphans(dataDir: string, store: AccountStore, log: (m: string) => void): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(join(dataDir, 'users'));
  } catch {
    return;
  }
  const orphans = names.filter((n) => ACCOUNT_ID_RE.test(n) && store.byId(n) === undefined);
  for (const n of orphans) await rm(join(dataDir, 'users', n), { recursive: true, force: true }).catch(() => undefined);
  if (orphans.length > 0) log(`[accounts] removed ${orphans.length} folder(s) of deleted accounts`);
}

export function createAccountsRuntime(
  config: ServerConfig,
  base: ServerContext,
  o: { now?: () => number; limiter?: RateLimiter; overrides?: Omit<ContextOverrides, 'shared'>; sessionTtlMs?: number } = {},
): AccountsRuntime & { close(): Promise<void> } {
  const store = new AccountStore(join(config.dataDir, 'accounts.db'), o.now !== undefined ? { now: o.now } : {});
  const users = new UserContexts({
    config,
    shared: { content: base.content, puzzles: base.puzzles, clipGen: base.clipGen },
    buildApi: (ctx) => accountApp(ctx, createApi),
    log: base.log,
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.overrides !== undefined ? { overrides: o.overrides } : {}),
  });
  void removeOrphans(config.dataDir, store, base.log);
  let disk = { at: -Infinity, low: false };
  const diskLow = (): boolean => {
    const now = Date.now();
    if (now - disk.at > 60_000) {
      const free = freeBytes(config.dataDir);
      disk = { at: now, low: free !== null && free < DISK_FREE_MIN };
      if (disk.low) base.log(`[accounts] less than 1 GB free under ${config.dataDir}: nothing new is written until there is room`);
    }
    return disk.low;
  };
  const purge = setInterval(() => {
    try {
      store.purgeExpired();
    } catch {
      // the next sweep tries again
    }
  }, 3600_000);
  purge.unref();
  return {
    store,
    users,
    limiter: o.limiter ?? new RateLimiter(o.now !== undefined ? { now: o.now } : {}),
    options: {
      inviteCode: config.accounts.inviteCode,
      cookieSecure: config.accounts.cookieSecure,
      trustProxy: config.accounts.trustProxy,
      maxAccounts: config.accounts.maxAccounts,
      openRegistration: config.accounts.openRegistration,
      ...(o.sessionTtlMs !== undefined ? { sessionTtlMs: o.sessionTtlMs } : {}),
    },
    log: base.log,
    diskLow,
    dataDir: config.dataDir,
    presence: new Presence(o.now),
    pow: config.accounts.powBits > 0 ? new ProofOfWork({ difficulty: config.accounts.powBits }) : null,
    adminKeys: new Set(config.accounts.adminLogins.map((l) => parseLogin(l)?.key).filter((k): k is string => k !== undefined)),
    async close() {
      clearInterval(purge);
      await users.closeAll();
      store.close();
    },
  };
}
