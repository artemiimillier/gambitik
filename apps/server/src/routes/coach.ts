import { Hono } from 'hono';
import type { GameStrategy, ReplanResponse } from '@gambit/shared';
import type { ServerContext } from '../context.ts';
import { buildRephrasePrompt } from '../llm/prompts.ts';
import { REPHRASE_JSON_SCHEMA, parseRephraseOutput } from '../llm/reviewSchema.ts';
import type { RephraseOutput } from '../llm/reviewSchema.ts';
import { rephraseBodySchema, replanRequestSchema, strategyRequestSchema } from '../schemas.ts';
import { AUTOMATION_HEADER, isAutomationRequest } from '../security.ts';
import { StrategistInputError } from '../strategist/strategist.ts';
import { SMALL_BODY_LIMIT, jsonBody, limitBody } from './validation.ts';

/** In-game polish must be quick: only the API provider is fast enough (codex needs 4–10 s per call). */
const REPHRASE_TIMEOUT_MS = 4_000;

/**
 * `POST /coach/rephrase` — optional LLM polish of a ready coach phrase. The facts never change
 * (the LLM only rephrases); on any problem the original `event.text` comes back.
 * `POST /coach/strategy` — the strategy of a new «Учитель» game (≤ 8 s; strategist/strategist.ts).
 * `POST /coach/replan` — a fresh plan when the opponent left it (≤ 15 s; the game drops stale answers by `ply`).
 * Both answer from the deterministic template for automated runs and whenever no model can.
 */
export function coachRoutes(ctx: ServerContext) {
  return new Hono()
    .post('/rephrase', limitBody(SMALL_BODY_LIMIT), jsonBody(rephraseBodySchema), async (c) => {
      const { event } = c.req.valid('json');
      const fallback = { text: event.text, provider: 'template' };
      if (isAutomationRequest(c.req.header(AUTOMATION_HEADER)) || !ctx.gateway.hasLlm(['openai-api'])) return c.json<{ text: string; provider: string }>(fallback);
      try {
        const { data, provider } = await ctx.gateway.generateJson<RephraseOutput>({ kind: 'rephrase', event }, buildRephrasePrompt(event, ctx.student.getProfile()), REPHRASE_JSON_SCHEMA, {
          validate: parseRephraseOutput,
          schemaName: 'coach_rephrase',
          timeoutMs: REPHRASE_TIMEOUT_MS,
          providers: ['openai-api', 'template'],
          skipQueueWhenBusy: true,
        });
        return c.json<{ text: string; provider: string }>({ text: data.text, provider });
      } catch {
        return c.json<{ text: string; provider: string }>(fallback);
      }
    })
    .post('/strategy', limitBody(SMALL_BODY_LIMIT), jsonBody(strategyRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const automation = isAutomationRequest(c.req.header(AUTOMATION_HEADER));
      try {
        return c.json<GameStrategy>(await ctx.strategist.chooseStrategy(body, { automation }));
      } catch (error) {
        if (error instanceof StrategistInputError) return c.json({ error: 'invalid-body' }, 400);
        throw error;
      }
    })
    .post('/replan', limitBody(SMALL_BODY_LIMIT), jsonBody(replanRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const automation = isAutomationRequest(c.req.header(AUTOMATION_HEADER));
      try {
        return c.json<ReplanResponse>(await ctx.strategist.replan(body, { automation }));
      } catch (error) {
        if (error instanceof StrategistInputError) return c.json({ error: 'invalid-body' }, 400);
        throw error;
      }
    });
}
