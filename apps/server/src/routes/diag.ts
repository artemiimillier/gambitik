/**
 * The voice black box (apps/web/src/coach/voiceDiag.ts) on the server side:
 *
 *  POST /api/voice/diag   body { page: '<random id of the page load>', events: [{ t, e, ...fields }] }  → { ok: true }
 *                         as application/json (every 5 s) or as text/plain JSON (navigator.sendBeacon of a closing page —
 *                         accepted like the usage beacon: only with an allow-listed Origin or `Sec-Fetch-Site: same-origin`,
 *                         see app.ts / security.ts)
 *
 * Every event becomes one JSON line in <DATA_DIR>/voice-diag.log (0600): `{"at":"<server ISO time>","page":…,"t":…,"e":…,…}`.
 * At 2 MB the file is rotated once (voice-diag.log.1 is replaced) — the log never grows without bound.
 * The server adds its own lines with `page: "server"` (`writeServerDiag`): `srv.live.fail` / `srv.live.retry` /
 * `srv.rt.fail` — why a paid voice session could not be opened (`reason` 'net:ENOTFOUND', 'timeout', 'http:503' …).
 *
 * PRIVACY: the body is validated strictly (zod): event names and field keys are short identifiers, values are numbers,
 * booleans, null or SHORT LATIN strings (`^[A-Za-z0-9 _.:/+()-]{0,64}$`). Russian text — the child's words, the coach's
 * words — cannot pass, nor can SDP, keys or long text; an invalid batch is refused whole (400) and nothing is written.
 * Automated runs (X-Gambit-Automation) are accepted and dropped. Nothing is ever read back over HTTP.
 */
import { appendFile, chmod, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ServerContext } from '../context.ts';
import { AUTOMATION_HEADER, isAutomationRequest } from '../security.ts';
import { limitBody } from './validation.ts';

export const VOICE_DIAG_FILE = 'voice-diag.log';
export const VOICE_DIAG_MAX_BYTES = 2 * 1024 * 1024;
export const VOICE_DIAG_BODY_LIMIT = 96 * 1024;
export const VOICE_DIAG_MAX_EVENTS = 200;
export const VOICE_DIAG_MAX_FIELDS = 18;

/** the same rules as the client (voiceDiag.ts) */
const STRING_RE = /^[A-Za-z0-9 _.:/+()-]{0,64}$/;
const EVENT_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,23}$/;
const PAGE_RE = /^[a-z0-9-]{4,40}$/;

const valueSchema = z.union([z.number().refine(Number.isFinite), z.boolean(), z.null(), z.string().regex(STRING_RE)]);

const eventSchema = z
  .record(z.string().regex(KEY_RE), valueSchema)
  .refine((event) => Object.keys(event).length <= VOICE_DIAG_MAX_FIELDS, { message: 'too many fields' })
  .refine((event) => typeof event.t === 'number' && event.t >= 0 && event.t < 1e10, { message: 't must be a non-negative number' })
  .refine((event) => typeof event.e === 'string' && EVENT_RE.test(event.e), { message: 'e must be an event name' });

export const voiceDiagBatchSchema = z
  .object({
    page: z.string().regex(PAGE_RE),
    events: z.array(eventSchema).min(1).max(VOICE_DIAG_MAX_EVENTS),
  })
  .strict();

export type VoiceDiagBatch = z.infer<typeof voiceDiagBatchSchema>;

/** Appends the batch as JSON lines; rotates at `maxBytes`. Writes are serialised (one chain per file). */
export function createVoiceDiagLog(dir: string, options: { maxBytes?: number; now?: () => Date } = {}) {
  const path = join(dir, VOICE_DIAG_FILE);
  const maxBytes = options.maxBytes ?? VOICE_DIAG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  let chain: Promise<void> = Promise.resolve();

  async function write(batch: VoiceDiagBatch): Promise<void> {
    const at = now().toISOString();
    const text = batch.events.map((event) => JSON.stringify({ at, page: batch.page, ...event })).join('\n') + '\n';
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(text) > maxBytes) await rename(path, `${path}.1`);
    await appendFile(path, text, { encoding: 'utf8', mode: 0o600 });
    // appendFile's mode only applies to a new file; an older file keeps the private mode too
    await chmod(path, 0o600).catch(() => undefined);
  }

  return {
    path,
    append(batch: VoiceDiagBatch): Promise<void> {
      const next = chain.then(() => write(batch));
      chain = next.catch(() => undefined);
      return next;
    },
    /** resolves when every queued write has settled (tests) */
    idle(): Promise<void> {
      return chain;
    },
  };
}

type VoiceDiagLog = ReturnType<typeof createVoiceDiagLog>;
const sharedLogs = new Map<string, VoiceDiagLog>();

/** ONE writer per data directory: the browser's batches and the server's own lines share its write chain (and rotation). */
export function voiceDiagLogFor(dir: string): VoiceDiagLog {
  let log = sharedLogs.get(dir);
  if (!log) {
    log = createVoiceDiagLog(dir);
    sharedLogs.set(dir, log);
  }
  return log;
}

/** Forgets the writer of a data directory whose context closed (accounts: one per child, opened and closed over time). */
export async function forgetVoiceDiagLog(dir: string): Promise<void> {
  const log = sharedLogs.get(dir);
  if (log === undefined) return;
  sharedLogs.delete(dir);
  await log.idle().catch(() => undefined);
}

/** page id of the lines the server writes itself (e.g. why OpenAI Live could not be opened) */
export const SERVER_DIAG_PAGE = 'server';

/**
 * The server's own line in the black box, next to the browser's (so that a failure such as «OpenAI Live is
 * unreachable» is not left in server.log alone, without its cause). Same privacy rules: the fields are validated like a browser batch — a field that
 * would not pass is dropped, never written. Best effort, never throws.
 */
export function writeServerDiag(ctx: Pick<ServerContext, 'config' | 'log'>, e: string, fields: Record<string, string | number | boolean | null>): Promise<void> {
  const event = { t: Math.max(0, Math.round(process.uptime() * 1000)), e, ...fields };
  const parsed = voiceDiagBatchSchema.safeParse({ page: SERVER_DIAG_PAGE, events: [event] });
  if (!parsed.success) return Promise.resolve();
  return voiceDiagLogFor(ctx.config.dataDir)
    .append(parsed.data)
    .catch((error: unknown) => ctx.log(`[voice] diag log write failed: ${error instanceof Error ? error.message : String(error)}`));
}

export function diagRoutes(ctx: ServerContext) {
  const log = voiceDiagLogFor(ctx.config.dataDir);
  return new Hono().post('/', limitBody(VOICE_DIAG_BODY_LIMIT), async (c) => {
    // read by hand: the beacon of a closing page arrives as text/plain (the JSON validator would skip it)
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text()) as unknown;
    } catch {
      return c.json({ error: 'invalid-body', issues: [{ path: '', message: 'must be JSON' }] }, 400);
    }
    const parsed = voiceDiagBatchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid-body', issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })) }, 400);
    }
    // automated runs never talk to the owner's log
    if (isAutomationRequest(c.req.header(AUTOMATION_HEADER))) return c.json({ ok: true as const });
    try {
      await log.append(parsed.data);
    } catch (error) {
      ctx.log(`[voice] diag log write failed: ${error instanceof Error ? error.message : String(error)}`);
      return c.json({ error: 'write-failed' }, 500);
    }
    return c.json({ ok: true as const });
  });
}
