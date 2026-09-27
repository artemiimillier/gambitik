/**
 * `POST /api/presence` { screen } — a signed-in page says «I am here, on this screen» (once a minute; memory only).
 * `GET  /api/admin/stats`         — the owner's dashboard data; 404 for everybody but GAMBIT_ADMIN_LOGINS.
 * `GET  /admin`, `/admin/admin.js` — the dashboard page itself (static: it shows nothing without the stats above).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { SMALL_BODY_LIMIT, jsonBody, limitBody } from '../routes/validation.ts';
import { ADMIN_PAGE_HTML, ADMIN_PAGE_JS } from './adminPage.ts';
import { PRESENCE_SCREENS, computeAdminStats } from './adminStats.ts';
import type { AdminStats } from './adminStats.ts';
import { requireSession } from './routes.ts';
import type { AccountsRuntime, AuthEnv } from './routes.ts';

const presenceSchema = z.object({ screen: z.enum(PRESENCE_SCREENS) });

/** the dashboard refreshes every 15 s; several open tabs read the databases once per this long */
const STATS_CACHE_MS = 5_000;

export function presenceRoutes(rt: AccountsRuntime) {
  return new Hono<AuthEnv>().post('/', requireSession(rt), limitBody(SMALL_BODY_LIMIT), jsonBody(presenceSchema), (c) => {
    rt.presence.mark(c.get('account').id, c.req.valid('json').screen);
    return c.body(null, 204);
  });
}

export function adminRoutes(rt: AccountsRuntime) {
  let cache: { at: number; stats: AdminStats } | null = null;
  return new Hono<AuthEnv>().get('/stats', requireSession(rt), (c) => {
    // not an admin: the dashboard does not exist
    if (!rt.adminKeys.has(c.get('account').login)) return c.json({ error: 'not-found' }, 404);
    const now = Date.now();
    if (cache === null || now - cache.at > STATS_CACHE_MS) {
      cache = { at: now, stats: computeAdminStats({ store: rt.store, dataDir: rt.dataDir, presence: rt.presence, maxAccounts: rt.options.maxAccounts, sharedInviteOpen: rt.options.inviteCode !== null, openRegistration: rt.options.openRegistration, now }) };
    }
    c.header('Cache-Control', 'no-store');
    return c.json(cache.stats);
  });
}

export function adminPage() {
  return new Hono()
    .get('/', (c) => {
      c.header('Cache-Control', 'no-store');
      return c.html(ADMIN_PAGE_HTML);
    })
    .get('/admin.js', (c) => {
      c.header('Cache-Control', 'no-store');
      c.header('Content-Type', 'text/javascript; charset=utf-8');
      return c.body(ADMIN_PAGE_JS);
    });
}
