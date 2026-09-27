/**
 * «Дозапись голоса» routes (under /api/voice/clips; listed in contracts.ts — docs/voice-clips/ONDEMAND.md):
 *
 *  POST /voice/clips/request   -> 202 ClipGenRequestResult   body ClipGenRequest (ids only, strict at every level)
 *                                 503 { error: 'automation' }   an automation-driven browser never records (checked first)
 *                                 503 { error: 'clip-gen-off' } GAMBIT_CLIP_GEN off (no valid overlay: 202, outcome 'paused')
 *                                 429 { error: 'clip-gen-rate' } more than CLIP_REQUESTS_PER_MINUTE requests a minute
 *  GET  /voice/clips/status    -> ClipGenStatus            also answers when off (the parent's card, the web poller)
 *  PUT  /voice/clips/settings  -> ClipGenStatus            body ClipGenSettings (strict; dailyCapMilli ≤ CLIP_GEN_DAILY_MAX);
 *                                                          under automation nothing is stored, the status comes back
 *  GET  /voice/clips/overlay/* -> the recorded overlay:  index.json · <voice>/manifest.<hash>.json · <voice>/<xx>/<id>.mp3
 *                                 (strict regexes, real-path containment, size caps; JSON 404 otherwise). Served whenever
 *                                 the overlay folder is valid and exists — independent of GAMBIT_CLIP_GEN, so recorded
 *                                 phrases keep playing after the budget is spent.
 *
 * The server never plays anything and never reads the body's text: requests carry ids, the words come from
 * @gambit/content (voiceGen/render.ts).
 */
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import type { ClipGenRequestResult, ClipGenStatus } from '@gambit/shared';
import type { ServerContext } from '../context.ts';
import { clipGenRequestSchema, clipGenSettingsSchema } from '../schemas.ts';
import { AUTOMATION_HEADER, isAutomationRequest } from '../security.ts';
import { resolveOverlayFile } from '../voiceGen/overlay.ts';
import { SMALL_BODY_LIMIT, jsonBody, limitBody } from './validation.ts';

/** A browser asks once per unvoiced utterance; a loop must not flood the queue. */
export const CLIP_REQUESTS_PER_MINUTE = 30;

const OVERLAY_PREFIX = '/overlay/';
/** a year: content-addressed files of the recorded overlay */
export const IMMUTABLE_MAX_AGE_S = 31_536_000;

const CONTENT_TYPE = { index: 'application/json; charset=utf-8', manifest: 'application/json; charset=utf-8', mp3: 'audio/mpeg' } as const;

function createLimiter(maxPerMinute: number, now: () => number = Date.now): () => boolean {
  let stamps: number[] = [];
  return () => {
    const t = now();
    stamps = stamps.filter((stamp) => t - stamp < 60_000);
    if (stamps.length >= maxPerMinute) return false;
    stamps.push(t);
    return true;
  };
}

export function clipGenRoutes(ctx: ServerContext) {
  const allow = createLimiter(CLIP_REQUESTS_PER_MINUTE);
  return new Hono()
    .post(
      '/request',
      limitBody(SMALL_BODY_LIMIT),
      async (c, next) => {
        // before the body is even read: automation and «off» learn nothing else, and nothing is queued
        if (isAutomationRequest(c.req.header(AUTOMATION_HEADER))) return c.json({ error: 'automation' }, 503);
        // the public site never records: strangers must not spend the operator's credits
        if (ctx.config.accounts?.enabled === true || ctx.clipGen.health().state === 'off') return c.json({ error: 'clip-gen-off' }, 503);
        return next();
      },
      jsonBody(clipGenRequestSchema),
      (c) => {
        if (!allow()) return c.json({ error: 'clip-gen-rate' }, 429);
        return c.json<ClipGenRequestResult>(ctx.clipGen.request(c.req.valid('json')), 202);
      },
    )
    .get('/status', (c) => {
      const status = ctx.clipGen.status();
      // the public site: the owner's spend and caps are nobody else's business (recording is off there anyway)
      if (ctx.config.accounts?.enabled === true) {
        return c.json<ClipGenStatus>({
          health: status.health,
          enabled: false,
          queue: 0,
          busy: false,
          overlay: status.overlay,
          spent: { today: status.spent.today, todayMilli: 0, totalMilli: 0, prefetchMilli: 0 },
          caps: { dailyMilli: 0, dailyMaxMilli: 0, totalMilli: 0 },
          givenUp: 0,
        });
      }
      return c.json<ClipGenStatus>(status);
    })
    .put('/settings', limitBody(SMALL_BODY_LIMIT), jsonBody(clipGenSettingsSchema), (c) => {
      // the parent's switch is the server's, not an account's: nobody on the public site may turn recording on
      if (ctx.config.accounts?.enabled === true) return c.json({ error: 'accounts-mode' }, 403);
      const body = c.req.valid('json');
      const max = ctx.config.clipGen.dailyMaxMilli;
      if (body.dailyCapMilli > max) return c.json({ error: 'invalid-body', issues: [{ path: 'dailyCapMilli', message: `must be at most ${max} (CLIP_GEN_DAILY_MAX)` }] }, 400);
      // an automated run never changes the parent's settings: it gets the current state back
      if (isAutomationRequest(c.req.header(AUTOMATION_HEADER))) return c.json<ClipGenStatus>(ctx.clipGen.status());
      return c.json<ClipGenStatus>(ctx.clipGen.setSettings(body));
    })
    .get('/overlay/*', async (c) => {
      const dir = ctx.clipGen.overlayDir();
      const at = c.req.path.indexOf(OVERLAY_PREFIX);
      const rel = at < 0 ? '' : c.req.path.slice(at + OVERLAY_PREFIX.length);
      const file = dir === null ? null : resolveOverlayFile(dir, rel);
      if (file === null) return c.json({ error: 'not-found' }, 404);
      let data: Buffer;
      try {
        data = await readFile(file.path);
      } catch {
        return c.json({ error: 'not-found' }, 404);
      }
      // the index must never be stale; a manifest (`manifest.<hash>.json`) and a take (`c<id>.mp3`) never change under
      // their names: the browser keeps them (a phone does not fetch the whole library again on every visit) — private,
      // since on the public site they are behind the sign-in
      const cache = file.kind === 'index' ? 'no-store' : `private, max-age=${IMMUTABLE_MAX_AGE_S}, immutable`;
      return c.body(new Uint8Array(data), 200, { 'content-type': CONTENT_TYPE[file.kind], 'cache-control': cache });
    });
}
