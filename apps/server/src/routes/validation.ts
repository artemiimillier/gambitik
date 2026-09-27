/** zod validation middleware with one uniform 400 answer, plus the body-size limits. */
import { zValidator } from '@hono/zod-validator';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';

/**
 * A finished GameRecord carries every event and judgement of the game. 1 MB:
 * the real games weigh at most ~1.1 KB per ply, so even a 600-ply game (the most schemas.ts MAX_GAME_PLIES lets in)
 * of the chattiest real kind (~660 KB) fits with room to spare; the largest real one is 77 KB.
 */
export const GAME_BODY_LIMIT = 1024 * 1024;
export const SMALL_BODY_LIMIT = 64 * 1024;

export interface ValidationIssue {
  path: string;
  message: string;
}

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): ValidationIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

export const jsonBody = <T extends z.ZodType>(schema: T) =>
  zValidator('json', schema, (result, c) => {
    if (!result.success) return c.json({ error: 'invalid-body', issues: issuesOf(result.error) }, 400);
    return undefined;
  });

export const queryParams = <T extends z.ZodType>(schema: T) =>
  zValidator('query', schema, (result, c) => {
    if (!result.success) return c.json({ error: 'invalid-query', issues: issuesOf(result.error) }, 400);
    return undefined;
  });

export const limitBody = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json({ error: 'payload-too-large' }, 413) });
