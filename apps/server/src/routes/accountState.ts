/**
 * `GET /api/account/state`, `PUT /api/account/state` — what the browser remembers about a child (the lesson's phrase
 * book, the voice and sound settings, the teacher's cards, the clips heard lately, a game to resume, games and
 * thoughts not sent yet …), kept with the account on the public site (GAMBIT_ACCOUNTS=1): it follows the child to
 * another browser and never mixes with another child's in a shared one. The family server's browser keeps all of it
 * in localStorage (the web asks for this only when accounts are on). Allow-listed keys only, the values as
 * the browser stores them (strings), ≤ 256 KB each and ≤ 1 MB together, in the account's own database (kv).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ServerContext } from '../context.ts';
import { kvGet, kvSet } from '../storage/db.ts';
import { jsonBody, limitBody } from './validation.ts';

/** The browser's keys that belong to the child (the web mirrors the same list: apps/web/src/app/account/accountState.ts). */
export const CLIENT_STATE_KEYS = [
  'gambit.settings',
  'gambit.lessonBook',
  'gambit.teacher.concepts',
  'gambit.coachStyle',
  'gambit.day',
  'gambit.clipRecency',
  'gambit.clipStats',
  'gambit.clipMisses',
  'gambit.sound.alwaysMuted',
  'gambit.sound.mutedUntil',
  'gambit.sfx.muted',
  'gambit.resumeGame',
  'gambit.unsentThoughts',
  'gambit.unsavedGames',
] as const;

export const CLIENT_STATE_VALUE_MAX = 256 * 1024;
export const CLIENT_STATE_TOTAL_MAX = 1024 * 1024;
const KV_PREFIX = 'client:';

const putSchema = z.object({
  key: z.enum(CLIENT_STATE_KEYS),
  /** null = the browser removed it */
  value: z.string().max(CLIENT_STATE_VALUE_MAX).nullable(),
  /** when the browser changed it (ms): the newer side wins when a child comes back to another browser */
  at: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
});

interface Stored {
  /** null = removed (kept, with its time, so an older copy elsewhere does not bring it back) */
  v: string | null;
  at: number;
}

function readAll(ctx: ServerContext): Map<string, Stored> {
  const out = new Map<string, Stored>();
  for (const key of CLIENT_STATE_KEYS) {
    const raw = kvGet(ctx.db, `${KV_PREFIX}${key}`);
    if (raw === undefined) continue;
    try {
      const s = JSON.parse(raw) as Partial<Stored>;
      if ((typeof s.v === 'string' || s.v === null) && typeof s.at === 'number') out.set(key, { v: s.v, at: s.at });
    } catch {
      // not ours: ignored
    }
  }
  return out;
}

export function accountStateRoutes(ctx: ServerContext) {
  return new Hono()
    .get('/', (c) => {
      const values: Record<string, string> = {};
      const times: Record<string, number> = {};
      for (const [key, s] of readAll(ctx)) {
        if (s.v !== null) values[key] = s.v;
        times[key] = s.at;
      }
      return c.json({ values, times });
    })
    .put('/', limitBody(CLIENT_STATE_VALUE_MAX + 4096), jsonBody(putSchema), (c) => {
      const { key, value, at } = c.req.valid('json');
      const all = readAll(ctx);
      const others = [...all].reduce((n, [k, s]) => (k === key ? n : n + (s.v?.length ?? 0)), 0);
      if (value !== null && others + value.length > CLIENT_STATE_TOTAL_MAX) return c.json({ error: 'payload-too-large' }, 413);
      kvSet(ctx.db, `${KV_PREFIX}${key}`, JSON.stringify({ v: value, at: at ?? Date.now() }));
      return c.json({ ok: true });
    });
}
