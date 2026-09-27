import { Hono } from 'hono';
import type { ProgressResetResponse, StudentProfile } from '@gambit/shared';
import type { ServerContext } from '../context.ts';
import { progressResetRequestSchema, studentUpdateSchema } from '../schemas.ts';
import { SMALL_BODY_LIMIT, jsonBody, limitBody } from './validation.ts';

export function studentRoutes(ctx: ServerContext) {
  return new Hono()
    .get('/', (c) => c.json<StudentProfile>(ctx.student.getProfile()))
    .put('/', limitBody(SMALL_BODY_LIMIT), jsonBody(studentUpdateSchema), async (c) => {
      const profile = ctx.student.update(c.req.valid('json'));
      await ctx.writer.writeStudentFiles();
      return c.json<StudentProfile>(profile);
    })
    // parent only: «Начать прогресс заново» — the games that count are archived (never deleted), the profile is recounted
    .post('/reset-progress', limitBody(SMALL_BODY_LIMIT), jsonBody(progressResetRequestSchema), async (c) => {
      const { archivedGames, profile } = await ctx.games.resetProgress();
      return c.json<ProgressResetResponse>({ archivedGames, profile });
    });
}
