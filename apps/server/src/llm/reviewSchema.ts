/**
 * Structured output of the game review and of the coach rephrase. The JSON Schemas are strict
 * (additionalProperties:false, every key required) so that Codex `--output-schema` and OpenAI
 * structured outputs accept them unchanged; the zod schemas re-validate whatever comes back.
 * There is deliberately NO field in which an LLM could re-judge a move: verdicts come from the engine.
 */
import { z } from 'zod';
import type { JsonSchema } from './types.ts';

export interface ReviewOutput {
  /** Russian markdown for the parent + child */
  markdown: string;
  keyTakeaways: string[];
  /** lichess theme key worth practising next */
  suggestedTheme: string;
}

export const REVIEW_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['markdown', 'keyTakeaways', 'suggestedTheme'],
  properties: {
    markdown: { type: 'string', description: 'Разбор партии на русском языке в формате markdown' },
    keyTakeaways: { type: 'array', items: { type: 'string' }, description: 'От двух до четырёх коротких выводов' },
    suggestedTheme: { type: 'string', description: 'Ключ темы для тренировки из списка allowedThemes' },
  },
};

export const reviewOutputSchema = z.object({
  markdown: z.string().trim().min(20).max(12_000),
  keyTakeaways: z.array(z.string().trim().min(1).max(400)).max(8),
  suggestedTheme: z.string().trim().max(60),
});

export function parseReviewOutput(data: unknown): ReviewOutput {
  return reviewOutputSchema.parse(data);
}

export interface RephraseOutput {
  text: string;
}

export const REPHRASE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', description: 'Реплика тренера по-русски, готовая для озвучивания' } },
};

const rephraseOutputSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(400)
    // spoken text must not contain Latin notation (contract: CoachEvent.text)
    .refine((text) => !/[A-Za-z]/.test(text), { message: 'Latin letters are not allowed in spoken text' }),
});

export function parseRephraseOutput(data: unknown): RephraseOutput {
  return rephraseOutputSchema.parse(data);
}
