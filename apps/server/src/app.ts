/**
 * Builds the Hono application: security middleware → `/api` routes (the list at the bottom of
 * contracts.ts, plus the local `GET|POST /api/voice/usage` extension documented in routes/voice.ts)
 * → in production the built SPA with an index.html fallback.
 * `AppType` is exported for typed clients (`hc<AppType>('/')`).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { API_BASE } from '@gambit/shared';
import { allowedHosts, allowedOrigins } from './config.ts';
import type { ServerContext } from './context.ts';
import { coachRoutes } from './routes/coach.ts';
import { curriculumRoutes } from './routes/curriculum.ts';
import { diagRoutes } from './routes/diag.ts';
import { gamesRoutes } from './routes/games.ts';
import { clipGenRoutes } from './routes/clips.ts';
import { activityRecorder, healthRoutes } from './routes/health.ts';
import { kbRoutes } from './routes/kb.ts';
import { progressRoutes } from './routes/progress.ts';
import { puzzlesRoutes } from './routes/puzzles.ts';
import { studentRoutes } from './routes/student.ts';
import { voiceRoutes } from './routes/voice.ts';
import { BEACON_PATHS, hostAllowlist, originCheck, requireJsonContentType, securityHeaders } from './security.ts';
import { authRoutes, requireSession, sessionAccount } from './accounts/routes.ts';
import type { AccountsRuntime } from './accounts/routes.ts';
import { adminPage, adminRoutes, presenceRoutes } from './accounts/adminRoutes.ts';
import { accountStateRoutes } from './routes/accountState.ts';

/** the voice black box of the web client (routes/diag.ts) — local, additive, not in contracts.ts */
export const VOICE_DIAG_API_PATH = `${API_BASE}/voice/diag`;

/** The `/api` routes of one child's context (the family server's only one, or an account's — ./accounts/users.ts). */
export function createApi(ctx: ServerContext) {
  return new Hono()
    .route('/health', healthRoutes(ctx))
    .route('/student', studentRoutes(ctx))
    .route('/games', gamesRoutes(ctx))
    .route('/progress', progressRoutes(ctx))
    .route('/puzzles', puzzlesRoutes(ctx))
    .route('/curriculum', curriculumRoutes(ctx))
    .route('/kb', kbRoutes(ctx))
    .route('/voice/diag', diagRoutes(ctx))
    // «Дозапись голоса»: recording requests, the parent's switch, the recorded overlay (routes/clips.ts)
    .route('/voice/clips', clipGenRoutes(ctx))
    .route('/voice', voiceRoutes(ctx))
    .route('/coach', coachRoutes(ctx))
    // the browser's memory of the child, kept with the account (the web uses it only when accounts are on)
    .route('/account/state', accountStateRoutes(ctx));
}

/** `PUT /api/games/:id/excluded`: marking a game recounts the whole profile */
const RECOUNT_PATH_RE = new RegExp(`^${API_BASE}/games/[^/]+/excluded$`);

/** `127.0.0.1:<port>` / `localhost:<port>`: a request from the server's own machine (never through the proxy). */
function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host);
}

/** The family server's `/api`: its one context's routes (also the typed client's shape, `AppType`). */
function familyRoutes(app: Hono, ctx: ServerContext) {
  return app.route(API_BASE, createApi(ctx));
}
type FamilyRouted = ReturnType<typeof familyRoutes>;

/**
 * `accounts` (GAMBIT_ACCOUNTS=1, the public site): `/api/health` and `/api/auth/*` are open; every other `/api` request
 * needs a live session and is answered by the account's OWN context and routes (./accounts/users.ts) — the family
 * server (no `accounts`) answers from its one context, without sign-in.
 */
export function createApp(ctx: ServerContext, accounts: AccountsRuntime | null = null) {
  const security = { allowedHosts: allowedHosts(ctx.config), allowedOrigins: allowedOrigins(ctx.config) };
  const app = new Hono();
  // the public site's pages talk to this server only (no live voice there)
  app.use('*', securityHeaders({ accounts: accounts !== null }));
  app.use('*', hostAllowlist(security));
  app.use('*', originCheck(security));
  // JSON only — except the beacons of a closing page (text/plain, same-origin proven): the voice usage and the voice
  // black box (see security.ts)
  app.use('*', requireJsonContentType({ allowedOrigins: security.allowedOrigins, beaconPaths: new Set([...BEACON_PATHS, VOICE_DIAG_API_PATH]) }));
  // «is somebody playing?» for GET /api/health → activity (the launcher restarts an outdated server only when idle)
  app.use(`${API_BASE}/*`, activityRecorder(ctx));
  app.onError((error, c) => {
    // thrown by hono itself, e.g. a malformed JSON body (400)
    if (error instanceof HTTPException) return c.json({ error: error.status === 400 ? 'invalid-body' : 'request-failed' }, error.status);
    // never leak internals (paths, SQL, secrets) to the browser
    ctx.log(`[server] ${c.req.method} ${new URL(c.req.url).pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
    return c.json({ error: 'internal-error' }, 500);
  });

  let routed: FamilyRouted;
  if (accounts === null) {
    // the web asks at start whether this server has accounts: the family server has none (a plain answer, no 404)
    app.get(`${API_BASE}/auth/me`, (c) => c.json({ accounts: false }));
    routed = familyRoutes(app, ctx);
  } else {
    // a stranger learns only that the site is up; the details (build, activity, recorder) are for a signed-in child
    // and for the server itself (loopback: the deploy's health check)
    app.use(`${API_BASE}/health`, async (c, next) => {
      if (isLoopbackHost(c.req.header('host')) || sessionAccount(c, accounts) !== null) return next();
      return c.json({ ok: true });
    });
    app.route(`${API_BASE}/health`, healthRoutes(ctx));
    app.route(`${API_BASE}/auth`, authRoutes(accounts));
    // the page's «I am here, on this screen» (once a minute) and the owner's dashboard (/admin)
    app.route(`${API_BASE}/presence`, presenceRoutes(accounts));
    app.route(`${API_BASE}/admin`, adminRoutes(accounts));
    app.route('/admin', adminPage());
    app.all(`${API_BASE}/*`, requireSession(accounts), async (c) => {
      const id = c.get('account').id;
      const limited = (wait: number) => {
        c.header('Retry-After', String(wait));
        return c.json({ error: 'too-many-requests', retryAfter: wait }, 429);
      };
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        // reads cost the server too (a list of 500 games, the progress over every game): 600 a minute per account
        const rule = new URL(c.req.url).pathname.startsWith(`${API_BASE}/voice/clips/overlay/`) ? 'clipAccount' : 'readAccount';
        const wait = accounts.limiter.blocked(rule, id);
        if (wait !== null) return limited(wait);
        accounts.limiter.hit(rule, id);
      } else {
        // one account cannot fill the disk for every child: changes per minute, games per day, and nothing new is
        // written when the disk is nearly full
        const path = new URL(c.req.url).pathname;
        const games = c.req.method === 'POST' && path === `${API_BASE}/games`;
        // a recount rereads and re-renders every game of the child: a few a minute
        const recount = (c.req.method === 'PUT' && RECOUNT_PATH_RE.test(path)) || (c.req.method === 'POST' && path === `${API_BASE}/student/reset-progress`);
        const wait =
          accounts.limiter.blocked('writeAccount', id) ?? (games ? accounts.limiter.blocked('gamesAccount', id) : null) ?? (recount ? accounts.limiter.blocked('recountAccount', id) : null);
        if (wait !== null) return limited(wait);
        accounts.limiter.hit('writeAccount', id);
        if (games) accounts.limiter.hit('gamesAccount', id);
        if (recount) accounts.limiter.hit('recountAccount', id);
        if (accounts.diskLow()) return c.json({ error: 'disk-full' }, 507);
      }
      // the raw request as it came: the account's API runs its own validation, limits and handlers on it
      return accounts.users.use(id, async ({ app: api }) => await api.fetch(c.req.raw, c.env));
    });
    // the typed client's shape is the family server's (the same routes, reached through the account)
    routed = app as unknown as typeof routed;
  }
  app.all(`${API_BASE}/*`, (c) => c.json({ error: 'not-found' }, 404));

  // Production: serve apps/web/dist. serveStatic resolves relative roots against process.cwd(),
  // which differs between `pnpm start` and the launcher — hence the absolute path.
  const indexHtmlPath = join(ctx.config.webDistDir, 'index.html');
  if (existsSync(indexHtmlPath)) {
    app.use('*', serveStatic({ root: ctx.config.webDistDir }));
    app.get('*', async (c) => c.html(await readFile(indexHtmlPath, 'utf8')));
  }
  return routed;
}

export type AppType = ReturnType<typeof createApp>;
