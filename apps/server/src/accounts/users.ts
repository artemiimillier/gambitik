/**
 * Accounts: one child = one data folder `DATA_DIR/users/<id>/` with its own SQLite (profile, games, journal, progress,
 * puzzles, the client state of ../routes/accountState.ts) and its own files — the same layout the family server has in
 * `data/`. A request of an account is answered by that account's own context and API (the very same routes, built
 * on it): another child's data is not reachable through any query or path, because it is not in the database or the
 * folder the handler has. Contexts are opened on first use, shared by concurrent requests, and closed after 30 idle
 * minutes (or the least recently used one when too many are open); deleting an account closes its context and
 * removes its folder.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { API_BASE } from '@gambit/shared';
import type { ServerConfig } from '../config.ts';
import { createServerContext } from '../context.ts';
import type { ContextOverrides, ServerContext, SharedServices } from '../context.ts';
import { forgetVoiceDiagLog } from '../routes/diag.ts';

import { ACCOUNT_ID_RE } from './store.ts';

export { ACCOUNT_ID_RE };

export interface UserApp {
  ctx: ServerContext;
  /** the account's API: `/api/...` routes on its own context */
  app: Hono;
}

interface Entry {
  ready: Promise<UserApp>;
  usedAt: number;
  /** requests being answered right now (never closed under them) */
  busy: number;
  /** the account is being deleted: no new use */
  closing: boolean;
}

export interface UserContextsOptions {
  config: ServerConfig;
  shared: SharedServices;
  /** builds an account's API from its context (app.ts `userApi`) */
  buildApi: (ctx: ServerContext) => Hono;
  log: (message: string) => void;
  maxOpen?: number;
  idleMs?: number;
  now?: () => number;
  /** tests: the rest of the context overrides (fake providers …) */
  overrides?: Omit<ContextOverrides, 'shared'>;
}

export class UserContexts {
  private readonly open = new Map<string, Entry>();
  private readonly o: Required<Pick<UserContextsOptions, 'maxOpen' | 'idleMs' | 'now'>> & UserContextsOptions;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(o: UserContextsOptions) {
    this.o = { maxOpen: 40, idleMs: 30 * 60_000, now: () => Date.now(), ...o };
    this.sweeper = setInterval(() => void this.sweep(), 5 * 60_000);
    this.sweeper.unref();
  }

  /** `DATA_DIR/users/<id>` (throws on anything but an account id: no path is ever built from other input). */
  dirOf(accountId: string): string {
    if (!ACCOUNT_ID_RE.test(accountId)) throw new Error('not an account id');
    return join(this.o.config.dataDir, 'users', accountId);
  }

  private configOf(accountId: string): ServerConfig {
    const dataDir = this.dirOf(accountId);
    // the puzzles database and the recorder stay the server's (shared); the rest follows the account's folder
    return { ...this.o.config, dataDir };
  }

  /**
   * Runs `fn` with the account's context and API, opening them on first use. The context is never closed while a
   * `use` of it runs.
   */
  async use<T>(accountId: string, fn: (u: UserApp) => Promise<T>): Promise<T> {
    let entry = this.open.get(accountId);
    if (entry?.closing === true) throw new Error('the account is being closed');
    if (entry === undefined) {
      const ready = this.create(accountId);
      entry = { ready, usedAt: this.o.now(), busy: 0, closing: false };
      this.open.set(accountId, entry);
      ready.catch(() => {
        if (this.open.get(accountId) === entry) this.open.delete(accountId);
      });
    }
    entry.busy++;
    entry.usedAt = this.o.now();
    try {
      return await fn(await entry.ready);
    } finally {
      entry.busy--;
      entry.usedAt = this.o.now();
      if (this.open.size > this.o.maxOpen) void this.evictLeastRecent();
    }
  }

  private async create(accountId: string): Promise<UserApp> {
    const ctx = await createServerContext(this.configOf(accountId), { ...this.o.overrides, shared: this.o.shared, log: this.o.log });
    // reviews that were still pending when the server (or this context) last stopped
    if (this.o.config.autoReview) ctx.reviews.resumePending();
    return { ctx, app: this.o.buildApi(ctx) };
  }

  /** Closes an entry that is idle right now (checked again at this moment, never under a request). */
  private async closeIfIdle(accountId: string, entry: Entry): Promise<boolean> {
    if (this.open.get(accountId) !== entry || entry.busy !== 0) return false;
    this.open.delete(accountId);
    await this.finish(entry);
    return true;
  }

  private async finish(entry: Entry): Promise<void> {
    try {
      const u = await entry.ready;
      await u.ctx.close();
      await forgetVoiceDiagLog(u.ctx.config.dataDir);
    } catch {
      // a context that never opened has nothing to close
    }
  }

  /** Closes the least recently used idle contexts, one at a time, until at most `maxOpen` are open. */
  private async evictLeastRecent(): Promise<void> {
    while (this.open.size > this.o.maxOpen) {
      const victim = [...this.open.entries()].filter(([, e]) => e.busy === 0 && !e.closing).sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (victim === undefined || !(await this.closeIfIdle(victim[0], victim[1]))) return;
    }
  }

  /** Closes the contexts nobody used for `idleMs`. */
  async sweep(): Promise<void> {
    const since = this.o.now() - this.o.idleMs;
    for (const [id, e] of [...this.open.entries()]) if (e.busy === 0 && e.usedAt < since) await this.closeIfIdle(id, e);
  }

  get openCount(): number {
    return this.open.size;
  }

  /** Creates the account's folder and profile (registration): nickname, address, stage. */
  async init(accountId: string, profile: { nickname: string; address: 'm' | 'f'; stage: number }): Promise<void> {
    await this.use(accountId, async ({ ctx }) => {
      ctx.student.update(profile);
      await ctx.writer.writeStudentFiles();
    });
  }

  /**
   * Deletes everything of the account: waits for its requests, closes its context and removes its folder. The
   * account row itself is the store's (the caller removes it first, so no new request can open it again).
   */
  async remove(accountId: string): Promise<void> {
    const dir = this.dirOf(accountId);
    const entry = this.open.get(accountId);
    if (entry !== undefined) {
      // no new use; the requests already running finish first (a slow upload too — at most two minutes)
      entry.closing = true;
      for (let i = 0; i < 4800 && entry.busy > 0; i++) await new Promise((r) => setTimeout(r, 25));
      if (this.open.get(accountId) === entry) this.open.delete(accountId);
      await this.finish(entry);
    }
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const [id, e] of [...this.open.entries()]) {
      this.open.delete(id);
      await this.finish(e);
    }
  }
}

/** The account API: the server's `/api` routes on one account's context, answering 404 / 500 like the app itself. */
export function accountApp(ctx: ServerContext, routes: (ctx: ServerContext) => Hono): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    // thrown by hono itself, e.g. a malformed JSON body (400) — as app.ts answers it
    if (error instanceof HTTPException) return c.json({ error: error.status === 400 ? 'invalid-body' : 'request-failed' }, error.status);
    ctx.log(`[server] ${c.req.method} ${new URL(c.req.url).pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
    return c.json({ error: 'internal-error' }, 500);
  });
  app.route(API_BASE, routes(ctx));
  app.all('*', (c) => c.json({ error: 'not-found' }, 404));
  return app;
}
