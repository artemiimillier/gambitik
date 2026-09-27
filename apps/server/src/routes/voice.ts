/**
 * Voice routes (all under /api/voice):
 *
 *  POST /voice/session  -> VoiceSessionResponse              Realtime API (gpt-realtime-2.x): ephemeral `ek_…` secret,
 *                                                            the browser then talks to OpenAI directly (contract route).
 *  POST /voice/live     -> LiveVoiceSessionResponse          Live API (gpt-live-1, FULL DUPLEX): body { sdp: <offer> };
 *                                                            the server creates the session with the real key and
 *                                                            returns the SDP answer (contract route).
 *  POST /voice/usage    -> { ok: true }                      body { provider: 'openai-live' | 'openai-realtime' | 'browser-tts',
 *                                                            seconds: number (0 < s ≤ 21600; an INCREMENT — e.g. the length of the session just closed) }
 *                                                            as application/json, or as text/plain JSON: the closing page sends it
 *                                                            with navigator.sendBeacon (same-origin only — security.ts)
 *  GET  /voice/usage    -> VoiceUsageSummary                 { today, month, todaySeconds, monthSeconds,
 *                                                              byProvider: { [provider]: { todaySeconds, monthSeconds } } }
 *  GET  /voice/voices   -> VoiceChoiceInfo                   { selected: string | null, live, realtime,
 *                                                              defaults: { live, realtime }, voices: [{ id, live, realtime }] }
 *  PUT  /voice/voices   -> VoiceChoiceInfo                   body { voice: string | null } — the parent's pick of Гамбитик's
 *                                                            voice (Settings, parental lock), stored in kv; null = the .env
 *                                                            voices again (../voice/voices.ts). Automated runs change nothing.
 *
 * Voice of a session: `POST /voice/live { sdp, voice? }` and `POST /voice/session { voice? }` accept an optional
 * `voice` (one of that API's built-in voices, else 400) for the parent's «Послушать» preview; without it the stored
 * pick applies (when that API has it), else VOICE_LIVE_VOICE / VOICE_NAME from .env.
 *
 * The `/voice/usage` and `/voice/voices` routes and the optional `voice` / `reason` fields are NOT in contracts.ts
 * (the contract is frozen): they are a local, additive extension — documented here and in README.md.
 *
 * Common rules:
 *  - runtime AI off (GAMBIT_RUNTIME_AI unset, the default — docs/TEACHING.md §4.4) → 503 { error: 'no-api-key' }
 *    on /voice/session and /voice/live, key or not: no generative voice in the child's game (the web already reads
 *    this code as «no voice here»);
 *  - no OPENAI_API_KEY → 503 { error: 'no-api-key' };
 *  - an automation-driven browser (X-Gambit-Automation: 1) → 503 { error: 'no-api-key' } as well:
 *    automated runs stay silent and free; their usage reports are accepted but not stored;
 *  - upstream failures → 502 { error: 'voice-upstream', status: <upstream HTTP status | null>, reason } —
 *    never upstream text (it echoes a partly masked API key); `reason` is a short code
 *    ('net:ENOTFOUND', 'net:UND_ERR_SOCKET', 'timeout', 'http:503', …, see ../voice/network.ts); the log line carries the
 *    status, error.type / error.code and the reason only, and the same goes to the voice black box (`page: "server"`);
 *  - at most VOICE_SESSIONS_PER_MINUTE session creations per minute → 429 { error: 'voice-rate-limited' }:
 *    a reconnect loop in the browser must not burn money (every Live session bills 15 s up front).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { LiveVoiceSessionResponse, VoiceSessionResponse } from '@gambit/shared';
import type { ServerContext } from '../context.ts';
import { AUTOMATION_HEADER, isAutomationRequest } from '../security.ts';
import { MAX_REPORT_SECONDS, VOICE_USAGE_PROVIDERS } from '../services/voiceUsage.ts';
import type { VoiceUsageSummary } from '../services/voiceUsage.ts';
import { buildLiveInstructions, createLiveSession, isPlausibleSdp } from '../voice/live.ts';
import { mintVoiceSession, studentBrief } from '../voice/session.ts';
import { VoiceChoiceStore, isKnownVoice, isVoiceFor, resolveVoice } from '../voice/voices.ts';
import type { VoiceChoiceInfo } from '../voice/voices.ts';
import { writeServerDiag } from './diag.ts';
import { SMALL_BODY_LIMIT, jsonBody, limitBody } from './validation.ts';

export const VOICE_SESSIONS_PER_MINUTE = 10;

const liveBodySchema = z.object({
  sdp: z.string().refine(isPlausibleSdp, { message: 'must be an SDP offer' }),
  /** the parent's «Послушать»: this one session speaks with this voice */
  voice: z
    .string()
    .refine((voice) => isVoiceFor('live', voice), { message: 'not a voice of the live model' })
    .optional(),
});

const realtimeBodySchema = z.object({
  voice: z
    .string()
    .refine((voice) => isVoiceFor('realtime', voice), { message: 'not a voice of the realtime model' })
    .optional(),
});

const voiceChoiceSchema = z
  .object({
    voice: z.string().refine(isKnownVoice, { message: 'unknown voice' }).nullable(),
  })
  .strict();

const usageBodySchema = z.object({
  provider: z.enum(VOICE_USAGE_PROVIDERS),
  seconds: z.number().positive().max(MAX_REPORT_SECONDS),
});

/** Sliding-window limiter shared by both session-creating routes. */
function createSessionLimiter(maxPerMinute: number, now: () => number = Date.now) {
  let stamps: number[] = [];
  return (): boolean => {
    const t = now();
    stamps = stamps.filter((stamp) => t - stamp < 60_000);
    if (stamps.length >= maxPerMinute) return false;
    stamps.push(t);
    return true;
  };
}

export function voiceRoutes(ctx: ServerContext) {
  const allowSession = createSessionLimiter(VOICE_SESSIONS_PER_MINUTE);
  const choices = new VoiceChoiceStore(ctx.db);
  const defaults = (): { live: string; realtime: string } => ({ live: ctx.config.voiceLiveVoice, realtime: ctx.config.voiceName });

  return new Hono()
    .post('/session', limitBody(SMALL_BODY_LIMIT), async (c) => {
      // an automated test run never gets a (paid) realtime session — it looks like a server without a key
      if (isAutomationRequest(c.req.header(AUTOMATION_HEADER))) return c.json({ error: 'no-api-key' }, 503);
      const { config } = ctx;
      // runtime AI off: never a paid voice session, whatever the key
      if (config.runtimeAi !== true || config.openaiApiKey === null) return c.json({ error: 'no-api-key' }, 503);
      // the body is optional ({} from the app's client); only a preview names a voice
      let raw: unknown = {};
      const text = await c.req.text();
      if (text.trim() !== '') {
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          return c.json({ error: 'invalid-body', issues: [{ path: '', message: 'must be JSON' }] }, 400);
        }
      }
      const parsed = realtimeBodySchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return c.json({ error: 'invalid-body', issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })) }, 400);
      }
      if (!allowSession()) return c.json({ error: 'voice-rate-limited' }, 429);
      const result = await mintVoiceSession({
        apiKey: config.openaiApiKey,
        baseUrl: config.openaiBaseUrl,
        model: config.voiceModel,
        voice: parsed.data.voice ?? resolveVoice('realtime', choices.get(), config.voiceName),
        transcribeModel: config.voiceTranscribeModel,
        ttlSeconds: config.voiceSecretTtlSeconds,
        instructions: `${ctx.content.coachSystemPromptRu.trim()}\n\n${studentBrief(ctx.student.getProfile())}`,
        fetchImpl: ctx.fetchImpl,
      });
      if (result.ok) return c.json<VoiceSessionResponse>(result.session);
      if (result.status === 503) return c.json({ error: result.error }, 503);
      ctx.log(`[voice] realtime: ${result.detail}`);
      void writeServerDiag(ctx, 'srv.rt.fail', { reason: result.reason, status: result.upstreamStatus });
      return c.json({ error: result.error, status: result.upstreamStatus, reason: result.reason }, 502);
    })
    .post('/live', limitBody(SMALL_BODY_LIMIT), async (c, next) => {
      // checked BEFORE body validation: an automated or keyless client (or any client while runtime AI is off) learns
      // nothing but "no voice here"
      if (isAutomationRequest(c.req.header(AUTOMATION_HEADER)) || ctx.config.runtimeAi !== true || ctx.config.openaiApiKey === null) return c.json({ error: 'no-api-key' }, 503);
      return next();
    }, jsonBody(liveBodySchema), async (c) => {
      const { config } = ctx;
      const { sdp, voice } = c.req.valid('json');
      if (!allowSession()) return c.json({ error: 'voice-rate-limited' }, 429);
      const result = await createLiveSession({
        apiKey: config.openaiApiKey,
        baseUrl: config.openaiBaseUrl,
        model: config.voiceLiveModel,
        voice: voice ?? resolveVoice('live', choices.get(), config.voiceLiveVoice),
        instructions: buildLiveInstructions(ctx.content.coachSystemPromptRu, studentBrief(ctx.student.getProfile())),
        sdp,
        fetchImpl: ctx.fetchImpl,
      });
      if (result.ok) {
        if (result.retriedAfter !== undefined) {
          // a network blip retried once instead of costing the whole Live attempt: worth knowing that it happens
          ctx.log(`[voice] live: opened on the second attempt (first: ${result.retriedAfter})`);
          void writeServerDiag(ctx, 'srv.live.retry', { reason: result.retriedAfter, ok: true });
        }
        return c.json<LiveVoiceSessionResponse>(result.session);
      }
      if (result.status === 503) return c.json({ error: result.error }, 503);
      ctx.log(`[voice] live: ${result.detail}`);
      void writeServerDiag(ctx, 'srv.live.fail', { reason: result.reason, status: result.upstreamStatus, attempts: result.attempts });
      return c.json({ error: result.error, status: result.upstreamStatus, reason: result.reason }, 502);
    })
    .post('/usage', limitBody(SMALL_BODY_LIMIT), async (c) => {
      // read by hand: a sendBeacon body arrives as text/plain (the JSON validator would skip it)
      let raw: unknown;
      try {
        raw = JSON.parse(await c.req.text()) as unknown;
      } catch {
        return c.json({ error: 'invalid-body', issues: [{ path: '', message: 'must be JSON' }] }, 400);
      }
      const parsed = usageBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid-body', issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })) }, 400);
      }
      const { provider, seconds } = parsed.data;
      // automated runs never talk, so there is nothing to account for
      if (!isAutomationRequest(c.req.header(AUTOMATION_HEADER))) ctx.voiceUsage.record(provider, seconds);
      return c.json({ ok: true as const });
    })
    .get('/usage', (c) => c.json<VoiceUsageSummary>(ctx.voiceUsage.summary()))
    .get('/voices', (c) => c.json<VoiceChoiceInfo>(choices.info(defaults())))
    .put('/voices', limitBody(SMALL_BODY_LIMIT), jsonBody(voiceChoiceSchema), (c) => {
      // an automated run never changes the owner's settings: it gets the current state back, nothing is stored
      if (!isAutomationRequest(c.req.header(AUTOMATION_HEADER))) {
        const { voice } = c.req.valid('json');
        choices.set(voice);
        ctx.log(`[voice] the parent picked the voice: ${voice ?? 'default'}`);
      }
      return c.json<VoiceChoiceInfo>(choices.info(defaults()));
    });
}
